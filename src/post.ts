import * as core from '@actions/core';
import { parseCellRef } from './config';
import { readCell, writeCell } from './cells';
import { GUARD_CELL_STATE, setup, summarize } from './main';
import { writeRenderedPage } from './publish';
import type { CellData } from './types';

/**
 * Post step: runs at job end even when the job failed or was cancelled
 * (post-if: always()). If the main step recorded an in-flight cell with the
 * guard enabled and the job is ending while that cell is STILL in-flight from
 * this very run, the job died without reporting -- record "aborted" so the
 * table can never show a forever-in-flight entry for a dead job.
 */
export async function runPost(): Promise<void> {
  const guardCell = core.getState(GUARD_CELL_STATE);
  if (!guardCell) {
    core.info('post: no in-flight guard armed by the main step; nothing to do');
    return;
  }

  const { env, config, store, storage } = await setup();
  const ref = parseCellRef(config, guardCell);

  const result = await store.update(async (dir) => {
    // Guard, re-checked on EVERY retry attempt against the freshly synced
    // state: only abort a cell that is still in-flight from our own
    // runId+runAttempt. A done/failed report that landed in the meantime
    // (even mid-retry-loop), or another run's takeover, is never clobbered.
    const existing = readCell(dir, config, ref.rowKey, ref.colKey);
    if (
      !existing ||
      existing.status !== 'in-flight' ||
      existing.runId !== env.runId ||
      existing.runAttempt !== env.runAttempt
    ) {
      core.info(`post: ${guardCell} is not in-flight from this run (a report landed or another run took over); leaving it alone`);
      return null;
    }
    const now = new Date();
    const cell: CellData = {
      status: 'aborted',
      note: 'job ended without reporting a result',
      epoch: existing.epoch,
      startedAt: existing.startedAt,
      finishedAt: now.toISOString(),
      recordedAt: now.toISOString(),
      runId: env.runId,
      runAttempt: env.runAttempt,
      runUrl: env.runUrl,
      sha: env.sha,
    };
    writeCell(dir, config, ref.rowKey, ref.colKey, cell);
    writeRenderedPage(dir, config, storage, {
      now,
      event: `\`${guardCell}\` → aborted`,
      runId: env.runId,
      runUrl: env.runUrl,
    });
    return { message: `${config.id}: ${guardCell} → aborted (run ${env.runId})` };
  });

  if (result.pushed) {
    core.info(`post: marked ${guardCell} aborted (the job ended while the cell was still in-flight)`);
    await summarize(
      `[${config.title}](${storage.pageUrl}) updated: \`${guardCell}\` aborted (job ended without reporting)`,
    );
  }
}
