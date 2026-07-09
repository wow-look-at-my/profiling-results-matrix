import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import type { CellData, MatrixConfig } from './types';

/**
 * Every cell is its own JSON file so concurrent reporters touch disjoint
 * paths: data/<matrixId>/<rowKey>--<colKey>.json.
 */
export function cellPath(dir: string, config: MatrixConfig, rowKey: string, colKey: string): string {
  return path.join(dir, 'data', config.id, `${rowKey}--${colKey}.json`);
}

export function readCell(dir: string, config: MatrixConfig, rowKey: string, colKey: string): CellData | undefined {
  const p = cellPath(dir, config, rowKey, colKey);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CellData;
  } catch (err) {
    // A corrupt data file must not brick the whole matrix; treat as unrecorded.
    core.warning(`ignoring unparseable cell data file ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function writeCell(dir: string, config: MatrixConfig, rowKey: string, colKey: string, cell: CellData): void {
  const p = cellPath(dir, config, rowKey, colKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(cell, null, 2)}\n`);
}

/**
 * Read every recorded cell for the configured rows x cols. Cells are looked up
 * by their expected file name (never by parsing file names back into keys, so
 * keys containing "--" cannot be misattributed and junk files are ignored).
 */
export function readAllCells(dir: string, config: MatrixConfig): Map<string, CellData> {
  const cells = new Map<string, CellData>();
  for (const row of config.rows) {
    for (const col of config.cols) {
      const cell = readCell(dir, config, row.key, col.key);
      if (cell) cells.set(`${row.key}/${col.key}`, cell);
    }
  }
  return cells;
}
