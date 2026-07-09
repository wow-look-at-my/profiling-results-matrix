## Before / After

**Before** (the failure mode this kills): profiling results live in a hand-maintained README table, like the one in wow-look-at-my/gcc -- values are copy-pasted from run logs, most cells sit at `?` forever, and entries stay "(in flight)" eternally because the session that dispatched them died before the numbers landed. Nothing updates unless a human remembers to.

**After**: a profiling job wraps its benchmark in two steps of this action (`status: in-flight` at start, `status: done` with the value at the end). Each invocation records exactly one cell and re-renders the whole table to the repo's `results` branch, incrementally, with no coordinator. Jobs that die without reporting get their cell auto-marked **aborted** by the action's post step; jobs that vanish so hard even post never ran surface as **lost** after a TTL. Results from an older generation (epoch) render struck through until re-measured. The table can rot in exactly one way -- honestly (a visibly stale/lost/aborted cell) -- never silently.

Live demo table: https://github.com/wow-look-at-my/profiling-results-matrix/blob/results/Profiling-Results.md

## How

- **Config-as-code**: `profiling-matrix.config.ts` (path is an input, so any repo/matrix works) declares rows/cols with stable keys, a global `epoch` (+ optional per-row/col overrides; effective epoch = max), a `unit`, and an in-flight TTL. Loaded via a native dynamic `import()` kept out of esbuild's CJS rewrite; Node >= 22.18 type stripping runs erasable-syntax TS configs directly. Runtime validation with field-path errors is the real contract.
- **Storage: orphan `results` branch** of the caller repo. One JSON file per cell (`data/<id>/<row>--<col>.json`) so parallel reporters touch disjoint paths; the rendered page (`<page>.md`) is derived state recomputed from all cell files on every write. Branch history = free browsable history.
  - The repo **wiki was the preferred target and was probed first**: pushing to an uninitialized wiki repo fails with `Repository not found` even for GITHUB_TOKEN with `contents: write` (probe run [29009602939](https://github.com/wow-look-at-my/profiling-results-matrix/actions/runs/29009602939)); GitHub only creates the wiki git repo when a first page is made by hand in the web UI, and no API exists for that. The storage backend is one function (`resolveStorage`) -- if someone bootstraps the wiki manually, switching back is a ~6 line change.
- **Concurrency** (first-class, see README section): every write clones/refreshes the results branch, writes its own cell file, re-renders the page from ALL merged cells, commits, pushes. A non-fast-forward rejection means a concurrent writer won the race: fetch, hard-reset to the new head, redo the whole mutation, push again (8 attempts, jittered 1-5 s backoff). Same-cell races are last-writer-wins; the post-abort step only writes if the cell is still in-flight from its own runId+runAttempt, re-checked on every retry attempt, so it can never clobber a real result. Exhausted retries fail the step loudly.
- **Org conventions**: node24 action, single bundle for main+post (`core.saveState`/`getState` branch), no `scripts` in package.json, justfile build (`pnpm install` + `pnpm tsc` + `pnpm esbuild`), `dist/` not committed, orphan-tag release adapted for a root action (tags `v<version>` + `latest`, script vendored from `wow-look-at-my/actions@orphan-release`).

## Verification

- Unit tests (render states, staleness incl. per-axis epochs, config validation, cell-ref parsing, store retry loop incl. a real 4-writer concurrent race against a local bare repo): `just test`, green in CI.
- Local smoke test drove the real bundled `dist/index.js` against a local bare repo through every state (in-flight -> done carry-over, post-abort guard both directions, stale epoch override, backdated lost cell, loud bad-input failures) -- output matched the expected table exactly.
- Demo run evidence: (pending -- will be updated after the demo dispatch)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KoCYXZbev8cEpVmr4M9PBZ
