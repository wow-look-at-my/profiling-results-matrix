# profiling-results-matrix

A GitHub Action that keeps a **profiling results table** up to date, one cell at a time, with no human in the loop. It exists because hand-maintained results tables rot: values get copy-pasted from run logs into a README, most cells sit at `?` forever, and entries stay "(in flight)" eternally because the session that dispatched the run died before the numbers landed (see the [wow-look-at-my/gcc README table](https://github.com/wow-look-at-my/gcc#compile-time-performance-work) this framework replaces). With this action, a profiling job *is* the table maintainer: it marks its cell in-flight when it starts, reports the measured value when it finishes, and the rendered table updates itself incrementally on the repo's wiki (or on an orphan `results` branch until the wiki exists -- see [Storage](#storage-layout-and-history)). Jobs that die without reporting are auto-marked **aborted**; jobs that vanish without a trace surface as **lost** after a TTL; results from an old generation render **struck through** until re-measured. The table can rot in exactly one way -- visibly -- never silently.

**Live demo:** [rendered table](https://github.com/wow-look-at-my/profiling-results-matrix/wiki/Profiling-Results) (on this repo's wiki) · [demo workflow](.github/workflows/demo.yml) that produces it, exercising every state.

## Quickstart

1. Put a matrix config in your repo (see [The matrix config](#the-matrix-config) below; this repo's own [`profiling-matrix.config.ts`](profiling-matrix.config.ts) is a complete example).
2. Wrap each profiling job in two invocations of the action -- `in-flight` at the start, `done` (or `failed`) at the end:

```yaml
permissions:
  contents: write   # the action pushes results to the wiki (or `results` branch)

jobs:
  profile-fib-O2:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4   # the action reads the matrix config from the workspace

      - name: Start profiling fib/O2
        uses: wow-look-at-my/profiling-results-matrix@v1
        with:
          cell: fib/O2
          status: in-flight

      - name: Run the benchmark
        id: bench
        run: echo "ms=$(./run-benchmark --opt O2)" >> "$GITHUB_OUTPUT"

      - name: Report result
        uses: wow-look-at-my/profiling-results-matrix@v1
        with:
          cell: fib/O2
          status: done
          value: ${{ steps.bench.outputs.ms }}
```

That is the whole contract. If the benchmark step crashes, the first invocation's **post step** notices the job is ending while the cell is still in-flight from this run and records **aborted** instead -- the table never shows a forever-in-flight entry for a dead job.

Released refs: `wow-look-at-my/profiling-results-matrix@v1` (immutable per `version` in [action.yml](action.yml)) or `@latest` (moving). Inside this repo, workflows use `uses: ./` after building with `just build`.

## Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `status` | yes | -- | `in-flight`, `done`, `failed`, `render`, or `reset` (see below) |
| `cell` | for reports | -- | Cell address `<rowKey>/<colKey>`; required for `in-flight`/`done`/`failed`, forbidden otherwise |
| `value` | for `done` | -- | Measured value, rendered with the config `unit` |
| `note` | no | -- | Free text rendered small in the cell (e.g. a failure reason) |
| `epoch` | no | effective epoch | Integer override: record the result against an older generation (renders stale) |
| `started-at` | no | now | ISO 8601 override for the start timestamp (backfills) |
| `finished-at` | no | now | ISO 8601 override for the finish timestamp (backfills; not allowed for `in-flight`) |
| `post-guard` | no | `true` | For `in-flight`: disable the post step's auto-abort for this cell |
| `config` | no | `profiling-matrix.config.ts` | Workspace-relative path to the matrix config (requires `actions/checkout`) |
| `token` | no | `github.token` | Token used to push results; needs `contents: write` |

Output: `page-url` -- the rendered results page. Every invocation addresses exactly **one** cell; recording automatically re-renders the whole page from all recorded cells.

The two non-cell statuses are maintenance verbs: `render` re-renders the page from current config + data without writing any cell (use it after an epoch bump), `reset` wipes every recorded cell of the matrix and re-renders an empty table (the demo exposes it as a dispatch input).

## The matrix config

Config-as-code, one file per matrix (the `config` input names the file, so a repo can have several matrices):

```ts
import type { MatrixConfig } from './src/types'; // optional; runtime validation is the contract

const config = {
  id: 'demo',                  // data files live under data/<id>/
  title: 'Demo profiling results',
  page: 'Profiling-Results',   // wiki page name (<page>.md on the results branch)
  storage: 'auto',             // 'auto' (default) | 'wiki' | 'results-branch'
  epoch: 3,                    // current generation; bump to invalidate old results
  unit: 'ms',
  inFlightTtlMinutes: 60,      // in-flight older than this renders as lost
  rows: [
    { key: 'fib', label: '`fib(35)` (recursive)' },
    { key: 'matmul', label: '512×512 matmul' },
  ],
  cols: [
    { key: 'O0', label: '-O0' },
    { key: 'O1', label: '-O1', epoch: 4 },  // per-row/col epoch overrides supported
  ],
} satisfies MatrixConfig;

export default config;
```

- **Keys** (`id`, `page`, row/col `key`) must match `[A-Za-z0-9._-]+` -- they become file names and cell addresses. Labels are markdown and default to the key.
- **Adding a row or column** is just adding an entry; its cells render as `—` until measured. Removing one hides its data files from the render (they stay in git history).
- The config is validated at runtime with field-path error messages -- that validation, not the TypeScript type, is the contract for external repos.
- **Loading rules:** the file is loaded with Node's native type stripping, so it must be *erasable-syntax* TypeScript (no enums, no namespaces, no parameter properties) and use `import type` for type-only imports. Plain `.mjs`/`.js` configs work too. If your repo's root `package.json` sets `"type": "commonjs"`, name the file `*.mts`.

## Cell addressing

A cell is `<rowKey>/<colKey>`, e.g. `fib/O2` -- row key from `rows`, column key from `cols`. Unknown keys fail with the list of known keys. On disk each cell is `data/<id>/<rowKey>--<colKey>.json` (cells are looked up by expected file name, never parsed back from file names, so keys containing `--` are safe).

## Epochs and staleness

Every recorded result carries the **epoch** it was measured against (default: the cell's *effective epoch* = `max(global, row, col)`; the `epoch` input overrides it, e.g. for backfilling an old measurement). At render time, a `done`/`failed` result whose epoch is older than the current effective epoch still renders -- **struck through, with an `eN` marker** -- until a new-epoch result replaces it.

To invalidate results after the thing being measured changed: bump `epoch` in the config (globally, or per row/column for a targeted invalidation), commit, and run any invocation -- the next cell write re-renders everything. To re-render immediately without waiting for one, run a step with `status: render`.

## Concurrency

Concurrent reporters are the normal case (a matrix usually fills from a parallel fan-out), so the write path is designed for them:

- **One JSON file per cell.** Parallel reporters touch disjoint paths; there is no shared mutable file except the rendered page, which is *derived*.
- **Every write is: sync -> mutate -> render -> push.** The action clones the storage branch fresh, writes its own cell file, regenerates the page markdown from **all** merged cell files + config, commits, and pushes.
- **Push rejection is the serialization point.** If a concurrent writer got its push in first, ours is rejected as non-fast-forward. The action then fetches, hard-resets to the new remote head, **redoes the entire mutation on the fresh state** (cell write + full re-render), and pushes again -- up to 8 attempts with jittered 1-5 s backoff. Because the page is recomputed from data on every attempt rather than patched, it can never text-conflict, and the winning history is a clean line of one commit per cell write.
- **Same-cell races are last-writer-wins.** The push loop linearizes all writes; whichever report for a given cell pushes last is the one that stays. This is deliberate: reports for the same cell are equivalent-quality measurements, and the newest one wins.
- **The post-abort step can never clobber a real result.** It only writes `aborted` if the cell is *still* in-flight from its **own** `runId` + `runAttempt` -- re-checked on every retry attempt against freshly synced state -- so a `done`/`failed` that lands mid-loop (or another run's takeover) makes it back off to a no-op.
- **Exhausted retries fail loudly.** If 8 attempts cannot land the push, the step fails (`core.setFailed`). A result is never silently dropped.

## Orphaned jobs: aborted and lost

The rot this framework exists to kill is the eternal "(in flight)" cell. Two mechanisms guarantee it cannot happen:

1. **Post-step abort.** `status: in-flight` arms a post step (`post-if: always()`) that runs when the job ends -- including failure and cancellation. If the job ends without a `done`/`failed` report having replaced the in-flight entry, the post step records **aborted** (with the guard semantics above). Disable per-cell with `post-guard: 'false'`.
2. **TTL -> lost.** If even the post step never ran (runner VM hard-died), the entry stays `in-flight` in the data -- but any render after `inFlightTtlMinutes` shows it as **lost** instead of in-flight. This is a render-time distinction only; the JSON keeps status `in-flight`, and any later report for the cell simply replaces it.

## Storage layout and history

Results live in the **repository wiki** of the repo the workflow runs in -- a wiki is itself a git repository (`<repo>.wiki.git`, branch `master`), so the same storage engine drives it and the table gets a first-class rendered home at `/wiki/<page>`:

```
<repo>.wiki.git (branch master)
├── Home.md                 # auto-maintained index of result pages (only if not hand-written)
├── Profiling-Results.md    # the rendered page (wiki page name = config `page`)
└── data/
    └── demo/               # <matrix id>
        ├── fib--O0.json    # one file per recorded cell
        └── ...
```

**The one wiki catch -- a human must bootstrap it once.** GitHub only creates a wiki's git repository when the first page is made by hand in the web UI: pushing to an *uninitialized* wiki returns `Repository not found` even for `GITHUB_TOKEN` with `contents: write` (verified empirically -- probe run [29009602939](https://github.com/wow-look-at-my/profiling-results-matrix/actions/runs/29009602939)), and no API can create it. Once any page exists (repo **Wiki** tab, "Create the first page", any content), `GITHUB_TOKEN` pushes to the wiki work fine.

The config's `storage` field decides how to handle that:

| `storage` | Behavior |
|---|---|
| `auto` (default) | Use the wiki iff its git repo exists. If the probe says *repository not found*, fall back to an orphan **`results` branch** of the same repo (identical layout, `README.md` as the index, page browsable at `/blob/results/<page>.md`) and emit a prominent notice explaining the bootstrap step. Any **other** probe failure (auth, network) fails the step loudly -- a definitive not-found is the only fallback trigger. |
| `wiki` | Pin the wiki; if it does not exist, fail loudly with the bootstrap instructions. |
| `results-branch` | Pin the `results` branch; the wiki is never probed. |

Note `auto` re-decides per write: results recorded on the `results` branch before the wiki was bootstrapped stay there and do **not** migrate automatically (this repo's own pre-wiki history lives on its [`results` branch](https://github.com/wow-look-at-my/profiling-results-matrix/blob/results/Profiling-Results.md)).

Browsable history is free because storage is git: [the page's change history](https://github.com/wow-look-at-my/profiling-results-matrix/wiki/Profiling-Results/_history) shows one commit per cell write, and `git log` on the wiki repo is the full audit trail. The rendered page links its producing run in every cell and in the header line.

## The demo

[`demo.yml`](.github/workflows/demo.yml) fakes a parallel profiling fan-out against this repo's real wiki and produces [the live table](https://github.com/wow-look-at-my/profiling-results-matrix/wiki/Profiling-Results) with every state: three normal in-flight -> done cells (one held in-flight for ~4 minutes so you can watch the live page flip), a stale epoch-2 backfill, a job that dies without reporting (post step -> aborted), an explicit `failed` report, an untouched empty cell, and a backdated guard-off in-flight that renders lost. All jobs start simultaneously, so the logs show the push-retry loop absorbing real collisions. Its `reset` input wipes the matrix data first for a clean slate.

## Development

```
just build   # pnpm install + tsc typecheck + esbuild bundle to dist/index.js
just test    # unit tests (render, config validation, store retry loop)
```

`dist/` is not committed; CI builds it, and pushes to `master` publish the built action to orphan tags `v<version>` + `latest` via [release.yml](.github/workflows/release.yml).
