// Thin wrappers over the git CLI. Every call is argv-only (no shell), so branch names and
// paths are never interpreted by a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`));
      resolve(err ? '' : stdout.replace(/\s+$/, ''));
    });
  });
}

export async function currentBranch(repo) {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })) || '';
}

export async function localBranches(repo) {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], { allowFail: true });
  return out ? out.split('\n') : [];
}

// One `git worktree add` per repo at a time; parallel adds race on .git/worktrees.
const locks = new Map();
function withRepoLock(repo, fn) {
  const prev = locks.get(repo) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(repo, next.catch(() => {}));
  return next;
}

/** Create `branch` from `base` in a new worktree at `dir`. Returns the base commit sha. */
export function addWorktree(repo, dir, branch, base) {
  return withRepoLock(repo, async () => {
    const baseSha = await git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, dir, baseSha]);
    return baseSha;
  });
}

export function removeWorktree(repo, dir) {
  return withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
    await git(repo, ['worktree', 'prune'], { allowFail: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** What a task's branch holds compared with where it started. */
export async function branchSummary(repo, baseSha, branch, worktree) {
  const commits = await git(repo, ['log', '--format=%h %s', `${baseSha}..${branch}`], { allowFail: true });
  const shortstat = await git(repo, ['diff', '--shortstat', baseSha, branch], { allowFail: true });
  const files = await git(repo, ['diff', '--stat=120', baseSha, branch], { allowFail: true });
  const dirty = worktree && fs.existsSync(worktree)
    ? await git(worktree, ['status', '--porcelain'], { allowFail: true })
    : '';
  return {
    commits: commits ? commits.split('\n') : [],
    shortstat: shortstat.trim(),
    files: files.split('\n').slice(0, 60).join('\n'),
    uncommitted: dirty ? dirty.split('\n').length : 0,
  };
}

/** Facts for the daily report: what moved in this repo recently. */
export async function recentActivity(repo, hours = 26) {
  const [branch, status, log, branches] = await Promise.all([
    currentBranch(repo),
    git(repo, ['status', '--porcelain'], { allowFail: true }),
    git(repo, ['log', '--all', `--since=${hours} hours ago`, '-n', '40', '--format=%h %an (%ar) [%D] %s'], { allowFail: true }),
    git(repo, ['for-each-ref', '--sort=-committerdate', '--count=12', '--format=%(refname:short) (%(committerdate:relative))', 'refs/heads'], { allowFail: true }),
  ]);
  return {
    branch,
    uncommitted: status ? status.split('\n').length : 0,
    commits: log ? log.split('\n') : [],
    branches: branches ? branches.split('\n') : [],
  };
}

export async function gitVersion() {
  try {
    return await git(process.cwd(), ['--version']);
  } catch {
    return '';
  }
}
