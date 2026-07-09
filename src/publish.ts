import * as fs from 'fs';
import * as path from 'path';
import { readAllCells } from './cells';
import { FRAMEWORK_URL, renderPage } from './render';
import type { MatrixConfig, Storage } from './types';

const INDEX_MARKER = '<!-- profiling-results-matrix index -->';

/**
 * GitHub prefills the wiki's very first page ("Create the first page") with
 * exactly "Welcome to the <name> wiki!". A Home.md still carrying only that
 * boilerplate was never really written by anyone -- take it over as the
 * index. Anything else without our marker is hand-maintained and untouchable.
 */
const WIKI_BOILERPLATE_RE = /^Welcome to the [^\n]+ wiki!$/;

export interface WriteMeta {
  now: Date;
  /** What this write did, e.g. "`fib/O2` → done" or "re-render". */
  event: string;
  runId: string;
  runUrl: string;
}

/**
 * Recompute the rendered page from ALL cell data + config and write it (plus
 * the branch-root index). Called inside every store mutation, so the page is
 * always derived from the merged, current state -- it never has to be patched
 * and therefore never conflicts.
 */
export function writeRenderedPage(dir: string, config: MatrixConfig, storage: Storage, meta: WriteMeta): void {
  const cells = readAllCells(dir, config);
  const page = renderPage(config, cells, { ...meta, historyUrl: storage.historyUrl });
  fs.writeFileSync(path.join(dir, storage.pageFile), page);
  ensureIndex(dir, config, storage);
}

/**
 * Keep a small index file pointing at the results page(s). Only files we own
 * (carrying INDEX_MARKER) -- or a wiki Home.md still holding GitHub's
 * untouched first-page boilerplate -- are ever rewritten; a hand-maintained
 * index is left alone.
 */
export function ensureIndex(dir: string, config: MatrixConfig, storage: Storage): void {
  const indexPath = path.join(dir, storage.indexFile);
  const links = new Map<string, string>([[storage.indexLinkTarget, `- [${config.title}](${storage.indexLinkTarget})`]]);

  if (fs.existsSync(indexPath)) {
    const existing = fs.readFileSync(indexPath, 'utf8');
    const ours = existing.includes(INDEX_MARKER);
    if (!ours && !WIKI_BOILERPLATE_RE.test(existing.trim())) return; // hand-maintained; leave alone
    if (ours) {
      for (const line of existing.split('\n')) {
        const m = /^- \[.*\]\((\S+)\)$/.exec(line.trim());
        if (m && !links.has(m[1])) links.set(m[1], line.trim());
      }
    }
  }

  const body = [
    INDEX_MARKER,
    '# Profiling results',
    '',
    ...[...links.values()].sort(),
    '',
    `<sub>This index is maintained automatically by [profiling-results-matrix](${FRAMEWORK_URL}).</sub>`,
    '',
  ].join('\n');
  fs.writeFileSync(indexPath, body);
}
