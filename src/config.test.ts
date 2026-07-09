import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { effectiveEpoch, loadConfig, parseCellRef, validateConfig } from './config';
import type { MatrixConfig } from './types';

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to throw');
}

function valid(): Record<string, unknown> {
  return {
    id: 'demo',
    title: 'Demo',
    page: 'Results',
    epoch: 3,
    unit: 'ms',
    inFlightTtlMinutes: 60,
    rows: [{ key: 'fib' }, { key: 'matmul', epoch: 4 }],
    cols: [{ key: 'O0' }, { key: 'O1', label: '-O1' }],
  };
}

test('a valid config passes validation unchanged', () => {
  const cfg = validateConfig(valid(), 'test');
  assert.equal(cfg.id, 'demo');
  assert.equal(cfg.rows.length, 2);
});

test('errors carry field paths and every problem is reported at once', () => {
  const raw = valid();
  raw.id = 'has spaces!';
  raw.epoch = 1.5;
  (raw.rows as Record<string, unknown>[])[0].key = 'bad/key';
  const err = captureError(() => validateConfig(raw, 'my.config'));
  assert.match(err.message, /invalid matrix config \(my\.config\)/);
  assert.match(err.message, /^\s+- id: must be a string matching/m);
  assert.match(err.message, /^\s+- epoch: must be a non-negative integer/m);
  assert.match(err.message, /^\s+- rows\[0\]\.key: must be a string matching/m);
});

test('duplicate axis keys are rejected', () => {
  const raw = valid();
  raw.cols = [{ key: 'O0' }, { key: 'O0' }];
  assert.throws(() => validateConfig(raw, 't'), /cols\[1\]\.key: duplicate key "O0"/);
});

test('empty axes and bad TTL are rejected', () => {
  const raw = valid();
  raw.rows = [];
  raw.inFlightTtlMinutes = 0;
  const err = captureError(() => validateConfig(raw, 't'));
  assert.match(err.message, /rows: must be a non-empty array/);
  assert.match(err.message, /inFlightTtlMinutes: must be a positive number/);
});

test('effectiveEpoch is the max of global, row and column epochs', () => {
  const cfg = validateConfig(valid(), 't');
  const [fib, matmul] = cfg.rows;
  const [o0] = cfg.cols;
  assert.equal(effectiveEpoch(cfg, fib, o0), 3); // global wins
  assert.equal(effectiveEpoch(cfg, matmul, o0), 4); // row override wins
});

test('parseCellRef resolves keys and rejects unknowns with the known-key list', () => {
  const cfg = validateConfig(valid(), 't');
  const ref = parseCellRef(cfg, 'fib/O1');
  assert.equal(ref.row.key, 'fib');
  assert.equal(ref.col.label, '-O1');
  assert.throws(() => parseCellRef(cfg, 'nope/O0'), /unknown row key "nope" -- known rows: fib, matmul/);
  assert.throws(() => parseCellRef(cfg, 'fib/O9'), /unknown column key "O9" -- known columns: O0, O1/);
  assert.throws(() => parseCellRef(cfg, 'fib'), /malformed cell reference/);
  assert.throws(() => parseCellRef(cfg, 'a/b/c'), /malformed cell reference/);
});

test("this repo's own demo config loads through the real loader", async () => {
  const cfg: MatrixConfig = await loadConfig(path.resolve(__dirname, '..', 'profiling-matrix.config.ts'));
  assert.equal(cfg.id, 'demo');
  assert.equal(cfg.page, 'Profiling-Results');
  assert.equal(cfg.epoch, 3);
  assert.deepEqual(
    cfg.rows.map((r) => r.key),
    ['fib', 'matmul'],
  );
  assert.deepEqual(
    cfg.cols.map((c) => c.key),
    ['O0', 'O1', 'O2', 'O3'],
  );
});

test('a missing config file gives an actionable error', async () => {
  await assert.rejects(loadConfig('/nonexistent/nope.config.ts'), /did the workflow run actions\/checkout/);
});
