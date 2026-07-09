import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitStore } from './store';

function makeRemote(): { root: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-store-test-'));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'master', remote]);
  return { root, remote };
}

function newStore(root: string, remote: string, name: string): GitStore {
  return new GitStore({
    remoteUrl: remote,
    branch: 'master',
    dir: path.join(root, name),
    // Tight backoff so the collision test stays fast.
    minDelayMs: 50,
    maxDelayMs: 200,
  });
}

function clone(root: string, remote: string): string {
  const dir = path.join(root, 'verify');
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['clone', remote, dir], { stdio: 'ignore' });
  return dir;
}

test('bootstrap: first push creates the branch in an empty remote', async () => {
  const { root, remote } = makeRemote();
  const store = newStore(root, remote, 'w');
  const result = await store.update(async (dir) => {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi\n');
    return { message: 'first write' };
  });
  assert.equal(result.pushed, true);
  const verify = clone(root, remote);
  assert.equal(fs.readFileSync(path.join(verify, 'hello.txt'), 'utf8'), 'hi\n');
});

test('concurrent writers: every write lands, one commit each, page re-derived every attempt', async () => {
  const { root, remote } = makeRemote();
  const writers = [0, 1, 2, 3];
  await Promise.all(
    writers.map((i) =>
      newStore(root, remote, `w${i}`).update(async (dir) => {
        // Disjoint per-writer file (the per-cell JSON in real use)...
        fs.writeFileSync(path.join(dir, `cell${i}.json`), `${i}\n`);
        // ...plus the shared derived page, recomputed from the merged tree.
        const seen = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort();
        fs.writeFileSync(path.join(dir, 'page.md'), `${seen.join(',')}\n`);
        return { message: `write ${i}` };
      }),
    ),
  );

  const verify = clone(root, remote);
  for (const i of writers) {
    assert.equal(fs.readFileSync(path.join(verify, `cell${i}.json`), 'utf8'), `${i}\n`);
  }
  // The derived page reflects ALL writes after the last one (recomputed, not merged).
  assert.equal(
    fs.readFileSync(path.join(verify, 'page.md'), 'utf8'),
    'cell0.json,cell1.json,cell2.json,cell3.json\n',
  );
  // One commit per write, serialized by the push loop.
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: verify, encoding: 'utf8' }).trim().split('\n');
  assert.equal(log.length, writers.length);
});

test('mutation returning null is a no-op (nothing committed or pushed)', async () => {
  const { root, remote } = makeRemote();
  const w1 = newStore(root, remote, 'w1');
  await w1.update(async (dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    return { message: 'seed' };
  });
  const result = await newStore(root, remote, 'w2').update(async () => null);
  assert.equal(result.pushed, false);
  const verify = clone(root, remote);
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: verify, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(log, ['seed']);
});

test('a mutation that changes nothing skips the commit', async () => {
  const { root, remote } = makeRemote();
  const w1 = newStore(root, remote, 'w1');
  await w1.update(async (dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    return { message: 'seed' };
  });
  const result = await newStore(root, remote, 'w2').update(async (dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); // identical content
    return { message: 'no-op rewrite' };
  });
  assert.equal(result.pushed, false);
});

test('retries exhaust loudly when the push can never succeed', async () => {
  const { root, remote } = makeRemote();
  const store = new GitStore({
    remoteUrl: path.join(root, 'does-not-exist.git'),
    branch: 'master',
    dir: path.join(root, 'w'),
    attempts: 2,
    minDelayMs: 10,
    maxDelayMs: 20,
  });
  await assert.rejects(
    store.update(async (dir) => {
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
      return { message: 'doomed' };
    }),
    /push to master failed after 2 attempts/,
  );
});
