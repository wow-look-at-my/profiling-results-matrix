/** One row or column of the matrix. */
export interface AxisEntry {
  /**
   * Stable identifier used in cell addresses ("<rowKey>/<colKey>") and data
   * file names. Must match /^[A-Za-z0-9._-]+$/.
   */
  key: string;
  /** Markdown label rendered in the table. Defaults to the key. */
  label?: string;
  /**
   * Optional per-row/per-column epoch override. The effective epoch of a cell
   * is max(global epoch, row epoch, column epoch).
   */
  epoch?: number;
}

/**
 * Shape of a matrix config file (see profiling-matrix.config.ts). The action
 * validates this at runtime with field-path error messages; the TypeScript
 * type is a convenience for configs authored inside this repo.
 */
export interface MatrixConfig {
  /** Matrix identifier; cell data lives under data/<id>/ in the storage repo. */
  id: string;
  /** Page title (markdown allowed). */
  title: string;
  /** Page name; the rendered table is written to <page>.md in storage. */
  page: string;
  /**
   * Current global generation number. Results recorded against an older epoch
   * still render, but struck through (stale), until re-measured.
   */
  epoch: number;
  /** Unit suffix rendered after measured values (e.g. "ms"). */
  unit?: string;
  /** In-flight entries older than this render as lost (the job likely died). */
  inFlightTtlMinutes: number;
  rows: AxisEntry[];
  cols: AxisEntry[];
}

/** Status values stored in cell data files. */
export type CellStatus = 'in-flight' | 'done' | 'failed' | 'aborted';

/** One recorded cell, stored as data/<matrixId>/<rowKey>--<colKey>.json. */
export interface CellData {
  status: CellStatus;
  /** Measured value (status=done). */
  value?: string;
  /** Free-text note rendered small in the cell. */
  note?: string;
  /** Epoch the result was recorded against (staleness comparison at render). */
  epoch: number;
  startedAt?: string;
  finishedAt?: string;
  recordedAt: string;
  runId: string;
  runAttempt: string;
  runUrl: string;
  sha: string;
}
