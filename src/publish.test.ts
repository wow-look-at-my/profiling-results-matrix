import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureIndex } from './publish';
import type { MatrixConfig, Storage } from './types';

const CONFIG: MatrixConfig = {
  id: 'demo',
  title: 'Demo profiling results',
  page: 'Profiling-Results',
  epoch: 3,
  inFlightTtlMinutes: 60,
  rows: [{ key: 'fib' }],
  cols: [{ key: 'O0' }],
};

const WIKI_STORAGE: Storage = {
  remoteUrl: 'https://github.com/o/r.wiki.git',
  branch: 'master',
  pageFile: 'Profiling-Results.md',
  pageUrl: 'https://github.com/o/r/wiki/Profiling-Results',
  historyUrl: 'https://github.com/o/r/wiki/Profiling-Results/_history',
  indexFile: 'Home.md',
  indexLinkTarget: 'Profiling-Results',
};

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prm-publish-test-'));
}

test('a missing index is created with the marker and the page link', () => {
  const dir = tmpdir();
  ensureIndex(dir, CONFIG, WIKI_STORAGE);
  const home = fs.readFileSync(path.join(dir, 'Home.md'), 'utf8');
  assert.match(home, /^<!-- profiling-results-matrix index -->/);
  assert.match(home, /- \[Demo profiling results\]\(Profiling-Results\)/);
  assert.match(home, /maintained automatically/);
});

test("GitHub's untouched first-page boilerplate Home.md is taken over", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'Home.md'), 'Welcome to the profiling-results-matrix wiki!\n');
  ensureIndex(dir, CONFIG, WIKI_STORAGE);
  const home = fs.readFileSync(path.join(dir, 'Home.md'), 'utf8');
  assert.match(home, /^<!-- profiling-results-matrix index -->/);
  assert.match(home, /- \[Demo profiling results\]\(Profiling-Results\)/);
});

test('a hand-maintained index (no marker, not boilerplate) is left alone', () => {
  const dir = tmpdir();
  const hand = '# My wiki\n\nCarefully curated.\n';
  fs.writeFileSync(path.join(dir, 'Home.md'), hand);
  ensureIndex(dir, CONFIG, WIKI_STORAGE);
  assert.equal(fs.readFileSync(path.join(dir, 'Home.md'), 'utf8'), hand);
});

test('links from other matrices in an owned index are preserved', () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'Home.md'),
    '<!-- profiling-results-matrix index -->\n# Profiling results\n\n- [Other matrix](Other-Page)\n',
  );
  ensureIndex(dir, CONFIG, WIKI_STORAGE);
  const home = fs.readFileSync(path.join(dir, 'Home.md'), 'utf8');
  assert.match(home, /- \[Demo profiling results\]\(Profiling-Results\)/);
  assert.match(home, /- \[Other matrix\]\(Other-Page\)/);
});
