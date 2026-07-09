import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { effectiveEpoch, loadConfig, parseCellRef } from './config';
import { readCell, writeCell } from './cells';
import { readActionEnv, type ActionEnv } from './env';
import { writeRenderedPage } from './publish';
import { GitStore, remoteRepoExists } from './store';
import type { CellData, MatrixConfig, Storage } from './types';

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

/**
 * Storage backends.
 *
 * The repository wiki is the primary home: a wiki is itself a git repository
 * (`<repo>.wiki.git`, branch `master`), so the same GitStore drives it. The
 * one catch: GitHub only creates that git repository when a human creates the
 * first wiki page in the web UI -- pushing to an uninitialized wiki returns
 * "Repository not found" even for GITHUB_TOKEN with `contents: write`
 * (verified empirically from an Actions run), and no API can create it. So
 * 'auto' (the default) probes the wiki and falls back to an orphan `results`
 * branch of the caller repository -- same file layout, same properties --
 * until the wiki is bootstrapped. Only a definitive "repository not found"
 * triggers the fallback; any other probe failure (auth, network) throws.
 */
export async function resolveStorage(
  env: ActionEnv,
  config: MatrixConfig,
  token?: string,
  probe: (remoteUrl: string, token?: string) => Promise<boolean> = remoteRepoExists,
): Promise<Storage> {
  const mode = config.storage ?? 'auto';
  if (mode === 'results-branch') return branchStorage(env, config);

  const wiki = wikiStorage(env, config);
  if (await probe(wiki.remoteUrl, token)) {
    core.info(`storage: using the repository wiki (${wiki.remoteUrl})`);
    return wiki;
  }
  const bootstrap =
    `the wiki git repository (${wiki.remoteUrl}) does not exist. GitHub only creates it when a ` +
    `human creates the first wiki page in the web UI (${env.serverUrl}/${env.repository}/wiki, ` +
    '"Create the first page", any content) -- no API or token can do it. (A token that cannot ' +
    'read the repository at all is answered with the same "not found".)';
  if (mode === 'wiki') {
    throw new Error(`storage: the config pins storage to "wiki", but ${bootstrap}`);
  }
  core.notice(
    `storage: falling back to the "results" branch because ${bootstrap} Once the wiki is ` +
      'bootstrapped, storage mode "auto" switches to it on the next write (already-recorded ' +
      'results do not migrate automatically).',
    { title: 'profiling-results-matrix: wiki not bootstrapped' },
  );
  return branchStorage(env, config);
}

/** The orphan `results` branch of the caller repository. */
function branchStorage(env: ActionEnv, config: MatrixConfig): Storage {
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

/** The repository wiki: git repo `<repo>.wiki.git`, pages on branch `master`. */
function wikiStorage(env: ActionEnv, config: MatrixConfig): Storage {
  return {
    remoteUrl: `${env.serverUrl}/${env.repository}.wiki.git`,
    branch: 'master',
    pageFile: `${config.page}.md`,
    pageUrl: `${env.serverUrl}/${env.repository}/wiki/${config.page}`,
    historyUrl: `${env.serverUrl}/${env.repository}/wiki/${config.page}/_history`,
    indexFile: 'Home.md',
    indexLinkTarget: config.page,
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
  const token = core.getInput('token');
  const storage = await resolveStorage(env, config, token);
  const store = new GitStore({
    remoteUrl: storage.remoteUrl,
    branch: storage.branch,
    dir: fs.mkdtempSync(path.join(env.tempDir, 'profiling-results-matrix-')),
    token,
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
      status,
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
