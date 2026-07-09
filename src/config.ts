import * as fs from 'fs';
import { pathToFileURL } from 'url';
import type { AxisEntry, MatrixConfig } from './types';

/** Keys become file names and URL fragments, so keep them strictly safe. */
export const KEY_RE = /^[A-Za-z0-9._-]+$/;

// This action is bundled to CommonJS. esbuild rewrites a literal `import(...)`
// in CJS output into `require(...)`, which cannot load an ESM/.ts module. The
// indirection below keeps a NATIVE dynamic import in the bundle so Node can
// load the user's config (Node >= 22.18 strips erasable TypeScript syntax
// natively; .mjs/.js configs work the same way).
const nativeImport = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<Record<string, unknown>>;

/** Load and validate a matrix config file (.ts, .mts, .mjs or .js). */
export async function loadConfig(configPath: string): Promise<MatrixConfig> {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `matrix config not found: ${configPath} -- the config path is resolved against ` +
        `GITHUB_WORKSPACE; did the workflow run actions/checkout, and is the "config" input correct?`,
    );
  }
  let mod: Record<string, unknown>;
  try {
    mod = await nativeImport(pathToFileURL(configPath).href);
  } catch (err) {
    throw new Error(
      `failed to load matrix config ${configPath}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Hints: the config must be erasable-syntax-only TypeScript (no enums/namespaces/parameter ` +
        `properties), must use "import type" for type-only imports, and -- if the nearest ` +
        `package.json sets "type": "commonjs" -- must be renamed to .mts.`,
    );
  }
  return validateConfig(interopDefault(mod), configPath);
}

/**
 * Find the default export across module flavours: native ESM puts the config
 * at mod.default; a CJS config reached through import() puts module.exports
 * there (one more .default down when the CJS was transpiled from ESM).
 */
function interopDefault(mod: Record<string, unknown>): unknown {
  let value: unknown = mod;
  for (let i = 0; i < 2; i++) {
    if (typeof value === 'object' && value !== null && 'default' in value) {
      const inner = (value as { default?: unknown }).default;
      if (inner !== undefined) {
        value = inner;
        continue;
      }
    }
    break;
  }
  return value;
}

/** Validate an untyped config object; throws listing every problem with its field path. */
export function validateConfig(raw: unknown, source: string): MatrixConfig {
  const errors: string[] = [];
  const bad = (path: string, msg: string): void => {
    errors.push(`${path}: ${msg}`);
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid matrix config (${source}): expected the default export to be an object`);
  }
  const cfg = raw as Record<string, unknown>;

  const key = (path: string, v: unknown): void => {
    if (v === undefined || v === null) {
      bad(path, 'is required');
      return;
    }
    if (typeof v !== 'string' || !KEY_RE.test(v)) {
      bad(path, `must be a string matching ${KEY_RE} (it becomes a file/URL name), got ${JSON.stringify(v)}`);
    }
  };
  const epoch = (path: string, v: unknown, required: boolean): void => {
    if (v === undefined) {
      if (required) bad(path, 'is required');
      return;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      bad(path, `must be a non-negative integer, got ${JSON.stringify(v)}`);
    }
  };

  key('id', cfg.id);
  if (typeof cfg.title !== 'string' || cfg.title.trim() === '') bad('title', 'must be a non-empty string');
  key('page', cfg.page);
  epoch('epoch', cfg.epoch, true);
  if (cfg.unit !== undefined && typeof cfg.unit !== 'string') bad('unit', 'must be a string when present');
  if (
    typeof cfg.inFlightTtlMinutes !== 'number' ||
    !Number.isFinite(cfg.inFlightTtlMinutes) ||
    cfg.inFlightTtlMinutes <= 0
  ) {
    bad('inFlightTtlMinutes', 'must be a positive number');
  }

  for (const axis of ['rows', 'cols'] as const) {
    const list = cfg[axis];
    if (!Array.isArray(list) || list.length === 0) {
      bad(axis, 'must be a non-empty array');
      continue;
    }
    const seen = new Set<string>();
    list.forEach((entry: unknown, i: number) => {
      const path = `${axis}[${i}]`;
      if (typeof entry !== 'object' || entry === null) {
        bad(path, 'must be an object with a "key"');
        return;
      }
      const e = entry as Record<string, unknown>;
      key(`${path}.key`, e.key);
      if (typeof e.key === 'string') {
        if (seen.has(e.key)) bad(`${path}.key`, `duplicate key "${e.key}"`);
        seen.add(e.key);
      }
      if (e.label !== undefined && typeof e.label !== 'string') bad(`${path}.label`, 'must be a string when present');
      epoch(`${path}.epoch`, e.epoch, false);
    });
  }

  if (errors.length > 0) {
    throw new Error(`invalid matrix config (${source}):\n  - ${errors.join('\n  - ')}`);
  }
  return raw as MatrixConfig;
}

/** Effective epoch of a cell: max of the global, row and column epochs. */
export function effectiveEpoch(config: MatrixConfig, row: AxisEntry, col: AxisEntry): number {
  return Math.max(config.epoch, row.epoch ?? 0, col.epoch ?? 0);
}

export interface CellRef {
  rowKey: string;
  colKey: string;
  row: AxisEntry;
  col: AxisEntry;
}

/** Parse and resolve a "<rowKey>/<colKey>" cell address against the config. */
export function parseCellRef(config: MatrixConfig, ref: string): CellRef {
  const parts = ref.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`malformed cell reference ${JSON.stringify(ref)} -- expected "<rowKey>/<colKey>"`);
  }
  const [rowKey, colKey] = parts;
  const row = config.rows.find((r) => r.key === rowKey);
  if (!row) {
    throw new Error(
      `unknown row key ${JSON.stringify(rowKey)} -- known rows: ${config.rows.map((r) => r.key).join(', ')}`,
    );
  }
  const col = config.cols.find((c) => c.key === colKey);
  if (!col) {
    throw new Error(
      `unknown column key ${JSON.stringify(colKey)} -- known columns: ${config.cols.map((c) => c.key).join(', ')}`,
    );
  }
  return { rowKey, colKey, row, col };
}
