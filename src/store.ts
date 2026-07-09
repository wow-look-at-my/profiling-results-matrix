import * as core from '@actions/core';
import { getExecOutput } from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';

export interface StoreOptions {
  /** Git remote holding the results (e.g. https://github.com/o/r.wiki.git). */
  remoteUrl: string;
  /** Branch to read and write (GitHub wikis live on master). */
  branch: string;
  /** Local working directory for the clone (should be empty or absent). */
  dir: string;
  /** Token for HTTP auth (omit for unauthenticated/local remotes). */
  token?: string;
  /** Max push attempts before failing loudly (default 8). */
  attempts?: number;
  /** Jittered backoff bounds between attempts (defaults 1000..5000 ms). */
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** What a mutation wants committed; return null to no-op (nothing pushed). */
export interface UpdateOutcome {
  message: string;
}

/**
 * Header-based auth, the same scheme actions/checkout uses. The base64
 * credential would not be auto-masked in logs, so register it.
 */
function authConfigArgs(token?: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  core.setSecret(basic);
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** True when git's failure output says the remote repository does not exist. */
export function isRepoNotFound(gitOutput: string): boolean {
  // GitHub answers a clone/ls-remote of a nonexistent repo with
  //   remote: Repository not found.
  //   fatal: repository 'https://github.com/o/r.wiki.git/' not found
  // Match per line so unrelated occurrences of the words cannot combine.
  return gitOutput.split('\n').some((line) => /repository\b.*\bnot found/i.test(line));
}

/**
 * Does the remote repository exist? Only a definitive "repository not found"
 * answer returns false; any other failure (auth, network, ...) throws, so
 * callers can never mistake an outage for a missing repo. Note that GitHub
 * reports a repo the token cannot read at all as "not found" too.
 */
export async function remoteRepoExists(remoteUrl: string, token?: string): Promise<boolean> {
  const res = await getExecOutput('git', [...authConfigArgs(token), 'ls-remote', remoteUrl, 'HEAD'], {
    ignoreReturnCode: true,
    silent: true,
  });
  if (res.exitCode === 0) return true;
  if (isRepoNotFound(`${res.stderr}\n${res.stdout}`)) return false;
  throw new Error(
    `storage: could not probe remote ${remoteUrl} (git ls-remote exited ${res.exitCode}): ` +
      `${(res.stderr || res.stdout).trim()}`,
  );
}

export interface UpdateResult {
  /** False when the mutation no-opped or produced no changes. */
  pushed: boolean;
  /** Attempts consumed (>1 means we collided with concurrent writers). */
  attempts: number;
}

/**
 * Serialized-by-push git storage. update() runs the mutation against a fresh
 * copy of the remote's head and pushes the result; when a concurrent writer
 * gets its push in first, ours is rejected as non-fast-forward, so we fetch,
 * hard-reset to the new remote head, RE-RUN the mutation on the fresh state
 * and push again (bounded attempts, jittered backoff). Because the mutation is
 * re-run from scratch every attempt, derived state (the rendered page) is
 * always recomputed on top of the winning writes and can never conflict.
 */
export class GitStore {
  private readonly remoteUrl: string;
  private readonly branch: string;
  readonly dir: string;
  private readonly attempts: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly configArgs: string[];
  private ready = false;

  constructor(opts: StoreOptions) {
    this.remoteUrl = opts.remoteUrl;
    this.branch = opts.branch;
    this.dir = opts.dir;
    this.attempts = opts.attempts ?? 8;
    this.minDelayMs = opts.minDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 5000;
    this.configArgs = authConfigArgs(opts.token);
  }

  async update(mutate: (dir: string) => Promise<UpdateOutcome | null>): Promise<UpdateResult> {
    await this.ensureRepo();
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (attempt > 1) {
        const delay = Math.round(this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs));
        core.info(`store: waiting ${delay}ms, then re-syncing for attempt ${attempt}/${this.attempts}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await this.refresh();
      }

      const outcome = await mutate(this.dir);
      if (outcome === null) return { pushed: false, attempts: attempt };

      await this.git(['add', '-A']);
      const staged = await this.git(['diff', '--cached', '--quiet'], { allowFail: true });
      if (staged.exitCode === 0) {
        // Nothing new from this mutation. Unless a previous failed attempt
        // left local commits that never made it out (e.g. an unborn remote we
        // could not re-sync from), there is nothing to do.
        const ahead = await this.git(['rev-list', '--count', `origin/${this.branch}..HEAD`], { allowFail: true });
        if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') {
          core.info('store: nothing changed; skipping commit and push');
          return { pushed: false, attempts: attempt };
        }
        core.info('store: no new changes, but local commits are still unpushed; pushing them');
      } else {
        await this.git(['commit', '-m', outcome.message]);
      }

      const push = await this.git(['push', 'origin', `HEAD:${this.branch}`], { allowFail: true });
      if (push.exitCode === 0) {
        if (attempt > 1) core.info(`store: push succeeded on attempt ${attempt}/${this.attempts}`);
        return { pushed: true, attempts: attempt };
      }
      core.info(
        `store: push rejected (attempt ${attempt}/${this.attempts}) -- a concurrent writer updated ` +
          `${this.branch}; will re-fetch and re-apply`,
      );
    }
    throw new Error(
      `store: push to ${this.branch} failed after ${this.attempts} attempts -- ` +
        'failing loudly so the result is not silently dropped',
    );
  }

  /** Clone the remote; if it does not exist yet, init a repo whose first push creates it. */
  private async ensureRepo(): Promise<void> {
    if (this.ready) return;
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const parent = path.dirname(this.dir);
    const clone = await this.git(['clone', '--branch', this.branch, '--single-branch', this.remoteUrl, this.dir], {
      cwd: parent,
      allowFail: true,
    });
    if (clone.exitCode !== 0) {
      core.info(
        'store: clone failed (the remote repository or branch may not exist yet); ' +
          'initializing an empty repo -- the first push will create it',
      );
      await this.git(['init', '-b', this.branch, this.dir], { cwd: parent });
      await this.git(['remote', 'add', 'origin', this.remoteUrl]);
    }
    await this.git(['config', 'user.name', 'profiling-results-matrix[bot]']);
    await this.git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
    this.ready = true;
  }

  /** Drop local state and match the remote head (tolerates a still-unborn remote). */
  private async refresh(): Promise<void> {
    const fetch = await this.git(['fetch', 'origin', this.branch], { allowFail: true });
    if (fetch.exitCode === 0) {
      await this.git(['reset', '--hard', 'FETCH_HEAD']);
      await this.git(['clean', '-fd']);
    } else {
      core.info('store: fetch failed (remote branch may not exist yet); keeping local tree');
    }
  }

  private async git(
    args: string[],
    opts: { allowFail?: boolean; cwd?: string } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const res = await getExecOutput('git', [...this.configArgs, ...args], {
      cwd: opts.cwd ?? this.dir,
      ignoreReturnCode: true,
    });
    if (res.exitCode !== 0 && !opts.allowFail) {
      throw new Error(`git ${args[0]} failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
    return res;
  }
}
