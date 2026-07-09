import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeCellText, fmtUtc, humanAge, renderPage } from './render';
import type { CellData, MatrixConfig } from './types';

const NOW = new Date('2026-07-09T12:00:00.000Z');

function cfg(overrides: Partial<MatrixConfig> = {}): MatrixConfig {
  return {
    id: 'demo',
    title: 'Demo profiling results',
    page: 'Profiling-Results',
    epoch: 3,
    unit: 'ms',
    inFlightTtlMinutes: 60,
    rows: [
      { key: 'fib', label: '`fib(35)`' },
      { key: 'matmul', label: 'matmul' },
    ],
    cols: [
      { key: 'O0', label: '-O0' },
      { key: 'O1', label: '-O1' },
    ],
    ...overrides,
  };
}

function cell(overrides: Partial<CellData>): CellData {
  return {
    status: 'done',
    epoch: 3,
    recordedAt: NOW.toISOString(),
    runId: '42',
    runAttempt: '1',
    runUrl: 'https://example.test/runs/42',
    sha: 'abc123',
    ...overrides,
  };
}

function render(cells: Record<string, CellData>, config = cfg()): string {
  return renderPage(config, new Map(Object.entries(cells)), {
    now: NOW,
    event: '`fib/O0` → done',
    runId: '42',
    runUrl: 'https://example.test/runs/42',
    historyUrl: 'https://example.test/commits/results/Profiling-Results.md',
  });
}

test('fresh done cell renders bold value with unit, linked to the run', () => {
  const page = render({ 'fib/O0': cell({ value: '812.4' }) });
  assert.match(page, /\[\*\*812\.4 ms\*\*\]\(https:\/\/example\.test\/runs\/42\)/);
  assert.doesNotMatch(page, /~~\[\*\*812\.4/);
});

test('stale done cell (older epoch) is struck through with an epoch marker', () => {
  const page = render({ 'fib/O0': cell({ value: '95.0', epoch: 2 }) });
  assert.match(page, /~~\[\*\*95\.0 ms\*\*\]\(https:\/\/example\.test\/runs\/42\)~~ <sub>e2<\/sub>/);
});

test('per-column epoch override makes a global-epoch result stale', () => {
  const config = cfg({ cols: [{ key: 'O0', label: '-O0', epoch: 5 }, { key: 'O1' }] });
  const page = render({ 'fib/O0': cell({ value: '1.0', epoch: 3 }) }, config);
  assert.match(page, /~~\[\*\*1\.0 ms\*\*\].*~~ <sub>e3<\/sub>/);
});

test('per-row epoch override applies too', () => {
  const config = cfg({ rows: [{ key: 'fib', epoch: 9 }, { key: 'matmul' }] });
  const page = render({ 'fib/O0': cell({ value: '1.0', epoch: 3 }) }, config);
  assert.match(page, /~~.*1\.0 ms.*~~ <sub>e3<\/sub>/);
});

test('in-flight within TTL renders the italic word with age', () => {
  const started = new Date(NOW.getTime() - 3 * 60_000).toISOString();
  const page = render({ 'fib/O1': cell({ status: 'in-flight', startedAt: started }) });
  assert.match(page, /\[\*in flight\*\]\(https:\/\/example\.test\/runs\/42\) <sub>started 3m ago<\/sub>/);
});

test('in-flight past TTL renders as lost', () => {
  const started = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
  const page = render({ 'fib/O1': cell({ status: 'in-flight', startedAt: started }) });
  assert.match(page, /\[\*lost\*\]\(https:\/\/example\.test\/runs\/42\) <sub>started 2h ago<\/sub>/);
  // Lost is a render-time distinction only; the status stays in-flight.
});

test('aborted and failed cells render their plain words and note', () => {
  const page = render({
    'matmul/O0': cell({ status: 'aborted', note: 'job ended without reporting a result' }),
    'matmul/O1': cell({ status: 'failed', note: 'benchmark segfaulted' }),
  });
  assert.match(page, /\[\*aborted\*\]\(.*\) <sub>job ended without reporting a result<\/sub>/);
  assert.match(page, /\[\*failed\*\]\(.*\) <sub>benchmark segfaulted<\/sub>/);
});

test('no emoji anywhere in the rendered page (cells or legend)', () => {
  const started = new Date(NOW.getTime() - 3 * 60_000).toISOString();
  const page = render({
    'fib/O0': cell({ value: '812.4' }),
    'fib/O1': cell({ status: 'in-flight', startedAt: started }),
    'matmul/O0': cell({ status: 'aborted' }),
    'matmul/O1': cell({ status: 'failed', epoch: 2 }),
  });
  // Everything the page needs fits in Latin-1 plus typographic punctuation;
  // emoji and other symbol/pictograph codepoints must not appear.
  assert.doesNotMatch(page, /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{231A}-\u{23FF}]/u);
});

test('unrecorded cells render an em dash', () => {
  const page = render({});
  const fibRow = page.split('\n').find((l) => l.includes('`fib(35)`'));
  assert.equal(fibRow, '| `fib(35)` | — | — |');
});

test('header carries epoch, UTC timestamp, event and run link; legend and footer present', () => {
  const page = render({});
  assert.match(page, /epoch \*\*3\*\*/);
  assert.match(page, /last update 2026-07-09 12:00 UTC/);
  assert.match(page, /`fib\/O0` → done by \[run 42\]\(https:\/\/example\.test\/runs\/42\)/);
  assert.match(page, /### Legend/);
  assert.match(page, /\*lost\* \| in flight for more than 60 min/);
  assert.match(page, /do not edit by hand/);
  assert.match(page, /\[page history\]\(https:\/\/example\.test\/commits\/results\/Profiling-Results\.md\)/);
  assert.match(page, /data\/demo\/\*\.json/);
});

test('notes cannot break the table: pipes escaped, newlines flattened', () => {
  const page = render({ 'fib/O0': cell({ status: 'failed', note: 'a|b\nc' }) });
  assert.match(page, /<sub>a\\|b c<\/sub>/);
});

test('column and row labels default to keys', () => {
  const config = cfg({ rows: [{ key: 'r1' }], cols: [{ key: 'c1' }] });
  const page = render({}, config);
  assert.match(page, /\| \| c1 \|/);
  assert.match(page, /\| r1 \| — \|/);
});

test('humanAge is coarse and never negative', () => {
  assert.equal(humanAge(-5000), '0m');
  assert.equal(humanAge(3 * 60_000), '3m');
  assert.equal(humanAge(2 * 60 * 60_000), '2h');
  assert.equal(humanAge(72 * 60 * 60_000), '3d');
});

test('fmtUtc and escapeCellText helpers', () => {
  assert.equal(fmtUtc(NOW), '2026-07-09 12:00 UTC');
  assert.equal(escapeCellText('a|b'), 'a\\|b');
});
