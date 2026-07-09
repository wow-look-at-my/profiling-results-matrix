// Demo matrix for this repository (exercised by .github/workflows/demo.yml).
//
// Config-as-code contract (for any repo using the action):
// - default-export one object shaped like MatrixConfig; the action validates
//   it at runtime with field-path error messages.
// - the file is loaded with Node's native type stripping, so use only
//   erasable TypeScript syntax (no enums, namespaces or parameter
//   properties) and `import type` for type-only imports. Plain .mjs/.js
//   configs work too; if your repo's root package.json sets
//   "type": "commonjs", name the file *.mts instead of *.ts.
import type { MatrixConfig } from './src/types';

const config = {
  id: 'demo',
  title: 'Demo profiling results',
  page: 'Profiling-Results', // wiki page name (or Profiling-Results.md on the results branch)
  // Where results live: 'auto' (default) uses the repo wiki iff its git repo
  // exists (a human must have created the first page in the web UI once) and
  // otherwise falls back to an orphan `results` branch; 'wiki' or
  // 'results-branch' pin one backend.
  storage: 'auto',
  // Bump to invalidate every recorded result (they render struck through
  // until re-measured). Rows/cols accept per-axis `epoch` overrides; the
  // effective epoch of a cell is max(global, row, col).
  epoch: 3,
  unit: 'ms',
  inFlightTtlMinutes: 60,
  rows: [
    { key: 'fib', label: '`fib(35)` (recursive)' },
    { key: 'matmul', label: '512×512 matmul' },
  ],
  cols: [
    { key: 'O0', label: '-O0' },
    { key: 'O1', label: '-O1' },
    { key: 'O2', label: '-O2' },
    { key: 'O3', label: '-O3' },
  ],
} satisfies MatrixConfig;

export default config;
