import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionEnv } from './env';
import { resolveStorage } from './main';
import type { MatrixConfig, StorageMode } from './types';

const ENV: ActionEnv = {
  serverUrl: 'https://github.com',
  repository: 'o/r',
  runId: '42',
  runAttempt: '1',
  runUrl: 'https://github.com/o/r/actions/runs/42',
  sha: 'abc123',
  workspace: '/w',
  tempDir: '/tmp',
};

function cfg(storage?: StorageMode): MatrixConfig {
  return {
    id: 'demo',
    title: 'Demo',
    page: 'Profiling-Results',
    epoch: 3,
    inFlightTtlMinutes: 60,
    ...(storage === undefined ? {} : { storage }),
    rows: [{ key: 'fib' }],
    cols: [{ key: 'O0' }],
  };
}

const wikiExists = async (): Promise<boolean> => true;
const wikiMissing = async (): Promise<boolean> => false;
const probeMustNotRun = async (): Promise<boolean> => {
  throw new Error('probe must not be called');
};

test("storage 'auto' with an existing wiki resolves to the wiki", async () => {
  const s = await resolveStorage(ENV, cfg(), undefined, wikiExists);
  assert.equal(s.remoteUrl, 'https://github.com/o/r.wiki.git');
  assert.equal(s.branch, 'master');
  assert.equal(s.pageFile, 'Profiling-Results.md');
  assert.equal(s.pageUrl, 'https://github.com/o/r/wiki/Profiling-Results');
  assert.equal(s.historyUrl, 'https://github.com/o/r/wiki/Profiling-Results/_history');
  assert.equal(s.indexFile, 'Home.md');
  assert.equal(s.indexLinkTarget, 'Profiling-Results');
});

test("storage 'auto' without a wiki falls back to the results branch", async () => {
  const s = await resolveStorage(ENV, cfg('auto'), undefined, wikiMissing);
  assert.equal(s.remoteUrl, 'https://github.com/o/r.git');
  assert.equal(s.branch, 'results');
  assert.equal(s.pageFile, 'Profiling-Results.md');
  assert.equal(s.pageUrl, 'https://github.com/o/r/blob/results/Profiling-Results.md');
  assert.equal(s.historyUrl, 'https://github.com/o/r/commits/results/Profiling-Results.md');
  assert.equal(s.indexFile, 'README.md');
  assert.equal(s.indexLinkTarget, 'Profiling-Results.md');
});

test("storage 'wiki' pinned without a wiki fails loudly with bootstrap instructions", async () => {
  await assert.rejects(
    resolveStorage(ENV, cfg('wiki'), undefined, wikiMissing),
    /pins storage to "wiki".*creates the first wiki page in the web UI.*https:\/\/github\.com\/o\/r\/wiki/s,
  );
});

test("storage 'results-branch' pinned never probes the wiki", async () => {
  const s = await resolveStorage(ENV, cfg('results-branch'), undefined, probeMustNotRun);
  assert.equal(s.branch, 'results');
});

test('a probe failure (auth/network) propagates -- no silent fallback', async () => {
  const probeError = async (): Promise<boolean> => {
    throw new Error('could not probe remote: 403');
  };
  await assert.rejects(resolveStorage(ENV, cfg('auto'), undefined, probeError), /could not probe remote: 403/);
  await assert.rejects(resolveStorage(ENV, cfg('wiki'), undefined, probeError), /could not probe remote: 403/);
});

test('the probe receives the wiki remote and the token', async () => {
  const calls: Array<{ url: string; token?: string }> = [];
  const probe = async (url: string, token?: string): Promise<boolean> => {
    calls.push({ url, token });
    return true;
  };
  await resolveStorage(ENV, cfg(), 'tok-123', probe);
  assert.deepEqual(calls, [{ url: 'https://github.com/o/r.wiki.git', token: 'tok-123' }]);
});
