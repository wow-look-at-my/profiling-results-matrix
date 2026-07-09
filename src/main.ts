import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { effectiveEpoch, loadConfig, parseCellRef } from './config';
import { readCell, writeCell } from './cells';
import { readActionEnv, type ActionEnv } from './env';
import { writeRenderedPage } from './publish';
import { GitStore } from './store';
import type { CellData, MatrixConfig } from './types';

/** State key: cell the post step must guard (set for in-flight reports). */
export const GUARD_CELL_STATE = 'guardCell';

const REPORT_STATUSES = ['in-flight', 'done', 'failed'] as const;
const ALL_STATUSES = [...REPORT_STATUSES, 'render', 'reset'] as const;
type InputStatus = (typeof ALL_STATUSES)[number];

export async function runMain(): Promise<void> {
  const status = core.getInput('status', { required: true }) as InputStatus;
  if (!ALL_STATUSES.includes(status)) {
    throw new Error(`invalid status ${JSON.stringify(status)} -- expected one of: ${ALL_STATUSES.join(', ')}`);
  }

  const { env, config, store, storage } = await setup();

  if (status === 'render' || status === 'reset') {
    for (const name of ['cell', 'value', 'note', 'epoch', 'started-at', 'finished-at']) {
      if (core.getInput(name) !== '') throw new Error(`input "${name}" is not allowed when status=${status}`);
    }
    await store.update(async (dir) => {
      if (status === 'reset') fs.rmSync(path.join(dir, 'data', config.id), { recursive: true, force: true });
      writeRenderedPage(dir, config, storage, {
        now: new Date(),
        event: status === 'reset' ? 'reset' : 're-render',
        runId: env.runId,
        runUrl: env.runUrl,
      });
      return { message: `${config.id}: ${status} (run ${env.runId})` };
    });
    core.info(`store: ${status} complete`);
  } else {
    await reportCell(status, config, store, storage, env);
  }

  core.setOutput('page-url', storage.pageUrl);
  core.info(`Results page: ${storage.pageUrl}`);
  await summarize(`[${config.title}](${storage.pageUrl}) updated: ${status}`);
}

/** Where the results live and how the rendered page is reached. */
export interface Storage {
  remoteUrl: string;
  branch: string;
  /** File the rendered page is written to (repo-root relative). */
  pageFile: string;
  /** Browsable URL of the rendered page. */
  pageUrl: string;
  /** Browsable URL of the page's change history. */
  historyUrl: string;
  /** Small index file kept next to the page (branch-root README). */
  indexFile: string;
  /** Link target the index uses to reach the page. */
  indexLinkTarget: string;
}

/**
 * Storage backend: an orphan `results` branch of the caller repository.
 *
 * The repo wiki would be the natural home, but GitHub only creates the wiki
 * git repository when the first page is made by hand in the web UI; pushing
 * to an uninitialized wiki returns "Repository not found" even for
 * GITHUB_TOKEN with contents: write (verified empirically from an Actions
 * run), and no API can create it. A branch gives the same properties: one
 * JSON file per cell, a rendered page derived from them, and free browsable
 * history. To move to the wiki (once bootstrapped by hand), only this
 * function has to change: remoteUrl `<server>/<repo>.wiki.git`, branch
 * `master`, pageUrl `<server>/<repo>/wiki/<page>`, historyUrl
 * `<pageUrl>/_history`, indexFile `Home.md`, indexLinkTarget `<page>`.
 */
export function resolveStorage(env: ActionEnv, config: MatrixConfig): Storage {
  const branch = 'results';
  return {
    remoteUrl: `${env.serverUrl}/${env.repository}.git`,
    branch,
    pageFile: `${config.page}.md`,
    pageUrl: `${env.serverUrl}/${env.repository}/blob/${branch}/${config.page}.md`,
    historyUrl: `${env.serverUrl}/${env.repository}/commits/${branch}/${config.page}.md`,
    indexFile: 'README.md',
    indexLinkTarget: `${config.page}.md`,
  };
}

export interface Setup {
  env: ActionEnv;
  config: MatrixConfig;
  store: GitStore;
  storage: Storage;
}

/** Shared by main and post: env, validated config, and the storage backend. */
export async function setup(): Promise<Setup> {
  const env = readActionEnv();
  const configInput = core.getInput('config') || 'profiling-matrix.config.ts';
  const config = await loadConfig(path.resolve(env.workspace, configInput));
  const storage = resolveStorage(env, config);
  const store = new GitStore({
    remoteUrl: storage.remoteUrl,
    branch: storage.branch,
    dir: fs.mkdtempSync(path.join(env.tempDir, 'profiling-results-matrix-')),
    token: core.getInput('token'),
  });
  return { env, config, store, storage };
}

async function reportCell(
  status: (typeof REPORT_STATUSES)[number],
  config: MatrixConfig,
  store: GitStore,
  storage: Storage,
  env: ActionEnv,
): Promise<void> {
  const cellInput = core.getInput('cell');
  if (!cellInput) throw new Error(`input "cell" is required when status=${status}`);
  const ref = parseCellRef(config, cellInput);

  const value = core.getInput('value');
  if (status === 'done' && !value) throw new Error('input "value" is required when status=done');
  if (status !== 'done' && value) throw new Error(`input "value" is not allowed when status=${status}`);
  const note = core.getInput('note');
  const startedAtIn = parseIsoInput('started-at');
  const finishedAtIn = parseIsoInput('finished-at');
  if (status === 'in-flight' && finishedAtIn) throw new Error('input "finished-at" is not allowed when status=in-flight');
  const epochIn = parseEpochInput();
  const recordEpoch = epochIn ?? effectiveEpoch(config, ref.row, ref.col);

  const result = await store.update(async (dir) => {
    const now = new Date();
    const base: CellData = {
      status: status === 'in-flight' ? 'in-flight' : status,
      epoch: recordEpoch,
      recordedAt: now.toISOString(),
      runId: env.runId,
      runAttempt: env.runAttempt,
      runUrl: env.runUrl,
      sha: env.sha,
    };
    if (note) base.note = note;
    if (status === 'in-flight') {
      base.startedAt = startedAtIn ?? now.toISOString();
    } else {
      if (status === 'done') base.value = value;
      base.finishedAt = finishedAtIn ?? now.toISOString();
      // Preserve the start timestamp of our own in-flight report, if any.
      // (Re-read on every retry attempt, like everything else in this mutation.)
      const existing = readCell(dir, config, ref.rowKey, ref.colKey);
      const ownInFlight =
        existing?.status === 'in-flight' && existing.runId === env.runId && existing.runAttempt === env.runAttempt;
      const startedAt = startedAtIn ?? (ownInFlight ? existing.startedAt : undefined);
      if (startedAt) base.startedAt = startedAt;
    }
    writeCell(dir, config, ref.rowKey, ref.colKey, base);
    writeRenderedPage(dir, config, storage, {
      now,
      event: `\`${cellInput}\` → ${status}`,
      runId: env.runId,
      runUrl: env.runUrl,
    });
    return {
      message: `${config.id}: ${cellInput} → ${status}${status === 'done' ? ` ${value}` : ''} (run ${env.runId})`,
    };
  });
  core.info(`store: recorded ${cellInput} → ${status} in ${result.attempts} push attempt(s)`);

  if (status === 'in-flight' && core.getInput('post-guard') !== 'false') {
    core.saveState(GUARD_CELL_STATE, cellInput);
    core.info(
      `post guard armed for ${cellInput}: if this job ends without a done/failed report, ` +
        'the post step will mark the cell aborted',
    );
  }
}

function parseIsoInput(name: string): string | undefined {
  const raw = core.getInput(name);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`input "${name}" is not a parseable ISO 8601 timestamp: ${JSON.stringify(raw)}`);
  return new Date(ms).toISOString();
}

function parseEpochInput(): number | undefined {
  const raw = core.getInput('epoch');
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`input "epoch" must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** Best-effort job summary line; absent outside a real runner. */
export async function summarize(line: string): Promise<void> {
  try {
    if (process.env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(line, true).write();
  } catch (err) {
    core.debug(`could not write job summary: ${err instanceof Error ? err.message : String(err)}`);
  }
}
