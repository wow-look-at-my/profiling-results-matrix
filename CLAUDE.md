# profiling-results-matrix

A single root-level GitHub Action (`action.yml` at the repo root, `runs.using: node24`) that maintains a self-updating profiling results table on the repo's wiki (with a `results`-branch fallback until the wiki exists). See README.md for the full user-facing contract.

## Structure

- `action.yml` -- the action (root-level so external repos use `wow-look-at-my/profiling-results-matrix@v1` and this repo's workflows use `uses: ./`). Carries the org-required top-level `version:` field (drives release tags).
- `src/` -- TypeScript source. `index.ts` is the single entry for both `runs.main` and `runs.post` (actions/checkout stateHelper pattern: main saves `isPost` state, post branches on it). `main.ts` handles input validation + cell reporting, `post.ts` the auto-abort guard, `store.ts` the git storage retry loop, `render.ts` the pure page renderer, `config.ts` config loading/validation, `cells.ts` cell-file IO, `publish.ts` page+index writing, `env.ts` Actions env collection. `*.test.ts` are node:test files run via tsx.
- `profiling-matrix.config.ts` -- the DEMO matrix for this repo (exercised by demo.yml). Other repos bring their own config; the `config` input names the path.
- `scripts/orphan-release.sh` -- release script, vendored and adapted from `wow-look-at-my/actions@orphan-release` for a root action: publishes the built action as orphan tags `v<version>` + moving `latest` (instead of the monorepo's `<dir>#<version>` scheme).
- `.github/actions/setup/` -- internal composite (node/pnpm/just + `just build`) shared by the workflows.
- `.github/workflows/`: `ci.yml` (build + test on push), `release.yml` (build/test/validate on every push; tag publish master-only), `demo.yml` (workflow_dispatch; fakes a parallel profiling fan-out against the real wiki, exercising every rendered state; `reset` input wipes the matrix data first).

## Build and test

```
just build   # pnpm install; pnpm tsc (typecheck only, noEmit); pnpm esbuild src/index.ts --bundle -> dist/index.js
just test    # pnpm install; pnpm tsx --test src/*.test.ts
```

Org conventions that apply here: **no `scripts` in package.json** (justfile instead), **`dist/` is never committed** (CI builds it; release tags ship it), pnpm-workspace.yaml `allowBuilds` lets esbuild's postinstall run. Deviations from the smart-cache template, both deliberate: tsc is typecheck-only with esbuild bundling straight from `src/` (keeps `dist/` to exactly `index.js`), and package.json has **no `"type"` field** -- the action dynamically imports the user's `.ts` config with native `import()`, and an explicit `"type": "commonjs"` would make a config sitting next to our package.json (the demo config) parse as CJS and choke on `export default`. The dynamic import itself is wrapped in `new Function('u','return import(u)')` so esbuild's CJS output cannot rewrite it into `require()`.

## Storage and concurrency model

Results live in the caller repo's **wiki** by default: a wiki is itself a git repo (`<repo>.wiki.git`, branch `master`) holding one JSON file per cell (`data/<matrix id>/<rowKey>--<colKey>.json`), the rendered page (`<page>.md`, browsable at `/wiki/<page>`) and an auto-maintained `Home.md` index (only written when Home.md is absent, marker-owned, or still GitHub's first-page boilerplate "Welcome to the X wiki!"). The page is derived state: every write regenerates it in full from config + all cell files. The one wiki catch, probed empirically: GitHub only creates the wiki git repo when a human creates the first page in the web UI (pushing to an uninitialized wiki fails with `Repository not found` even for GITHUB_TOKEN with `contents: write`; no API exists). The config `storage` field handles it: `auto` (default) probes the wiki with `git ls-remote` and falls back to an orphan `results` branch of the caller repo (same layout, `README.md` index, page at `/blob/results/<page>.md`) iff the probe answers a definitive repository-not-found -- any other failure (auth, network) fails loudly, never a silent fallback; `wiki`/`results-branch` pin one backend (pinned wiki that doesn't exist = loud failure carrying the bootstrap instructions). `resolveStorage()` in src/main.ts is the single decision point. This repo's own wiki was hand-bootstrapped on 2026-07-09; pre-switch demo history stays on the `results` branch (kept, not migrated).

Every write runs in `GitStore.update()`: clone/refresh the branch, run the mutation (write own cell file, re-render page), commit, push. A non-fast-forward rejection means a concurrent writer won; the store fetches, hard-resets to the new head, re-runs the whole mutation on the fresh state and pushes again (8 attempts, jittered 1-5 s backoff), so derived state never conflicts and history stays one-commit-per-write. Same-cell races are last-writer-wins. The post step's auto-abort only fires if the cell is still in-flight from its own runId+runAttempt, re-checked inside every retry attempt, so it can never overwrite a real report. Exhausted retries fail the step loudly -- results are never silently dropped.
