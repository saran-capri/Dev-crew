// Runs one headless Claude Code session (`claude -p`) and streams its events back.
// The prompt goes in on stdin, so nothing the user types ever passes through a shell.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* ---------------- what the agents may do ---------------- */

const SHELLS = ['Bash', 'PowerShell'];
const cmdRules = cmds => cmds.flatMap(c => SHELLS.map(s => `${s}(${c}:*)`));

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch'];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
// cd / Set-Location are harmless on their own and models love "cd <dir>; npm test"; Claude Code
// checks each part of a chained command separately, so the deny list still applies to the rest.
const GIT_READ = ['cd', 'Set-Location', 'pwd', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse', 'git ls-files', 'git blame', 'git grep'];
const GIT_WRITE = ['git add', 'git commit', 'git mv', 'git rm', 'git restore', 'git stash'];
// Build and test commands for the common stacks. A project adds its own with "allowCommands".
const BUILD = [
  'npm test', 'npm run', 'npm ci', 'npm install', 'npx tsc', 'npx eslint', 'npx prettier', 'npx jest', 'npx vitest', 'npx playwright test', 'npx ng',
  'pnpm', 'yarn',
  'dotnet build', 'dotnet test', 'dotnet restore', 'dotnet format', 'dotnet ef migrations',
  'mvn', './mvnw', 'mvnw', 'gradle', './gradlew', 'gradlew',
  'pytest', 'python -m pytest', 'python -m unittest', 'pip install', 'ruff', 'mypy', 'black',
  'go test', 'go build', 'go vet', 'cargo build', 'cargo test', 'cargo check',
  'terraform fmt', 'terraform validate', 'terraform init -backend=false', 'tflint', 'bicep build', 'az bicep build', 'helm lint', 'hadolint',
  'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'find', 'Get-ChildItem', 'Get-Content',
];
const DENY_CMDS = [
  'git push', 'git merge', 'git rebase', 'git reset', 'git checkout', 'git switch', 'git worktree', 'git clean',
  'git branch -D', 'git branch -d', 'git branch -m', 'git remote', 'git config', 'git tag',
  'rm -rf', 'Remove-Item', 'terraform apply', 'terraform destroy', 'kubectl', 'helm install', 'helm upgrade', 'az deployment',
];
const DENY_TOOLS = ['Task', 'Agent', 'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification', 'EnterWorktree', 'ExitWorktree'];

export function toolPolicy(mode, extraCommands = []) {
  const allowed = mode === 'change'
    ? [...READ_TOOLS, ...EDIT_TOOLS, ...cmdRules([...GIT_READ, ...GIT_WRITE, ...BUILD, ...extraCommands])]
    : [...READ_TOOLS, ...cmdRules(GIT_READ)];
  return { allowed, disallowed: [...DENY_TOOLS, ...cmdRules(DENY_CMDS)] };
}

/* ---------------- finding the claude executable ---------------- */

let resolved = null;
let features = null;

/** On Windows an npm install puts a claude.cmd shim on PATH; we run the program it points at. */
export function resolveClaude(command = 'claude') {
  if (resolved && resolved.command === command) return resolved;
  resolved = { command, file: command, pre: [], shell: false };
  if (process.platform !== 'win32') return resolved;
  const candidates = /[\\/]/.test(command)
    ? [command]
    : (process.env.PATH || '').split(';').filter(Boolean).flatMap(d => ['.exe', '.cmd', '.bat'].map(x => path.join(d, command + x)));
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (/\.exe$/i.test(c)) { resolved.file = c; return resolved; }
    if (/\.(cmd|bat)$/i.test(c)) {
      const dir = path.dirname(c) + path.sep;
      const text = fs.readFileSync(c, 'utf8');
      const m = text.match(/"([^"]+\.(?:exe|js|cjs|mjs))"/i);
      if (m) {
        const target = path.normalize(m[1].replace(/%~?dp0%?\\?/gi, dir));
        if (fs.existsSync(target)) {
          if (/\.exe$/i.test(target)) resolved.file = target;
          else { resolved.file = process.execPath; resolved.pre = [target]; }
          return resolved;
        }
      }
      resolved.file = c;
      resolved.shell = true; // last resort
      return resolved;
    }
  }
  return resolved;
}

function runOnce(command, args) {
  const r = resolveClaude(command);
  return new Promise(resolve => {
    execFile(r.file, [...r.pre, ...args], { shell: r.shell, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) =>
      resolve(err ? '' : String(stdout || stderr)));
  });
}

/** Which flags this machine's Claude Code understands (versions differ between laptops). */
export async function claudeFeatures(command = 'claude') {
  if (features) return features;
  const [version, help] = await Promise.all([runOnce(command, ['--version']), runOnce(command, ['--help'])]);
  features = {
    found: !!version,
    version: version.trim().split('\n')[0],
    dontAsk: /dontAsk/.test(help),
    systemPromptFile: /append-system-prompt-file/.test(help),
    path: resolveClaude(command).file,
  };
  return features;
}

/* ---------------- running a session ---------------- */

/**
 * Start `claude -p` in `cwd`. Returns { done, kill }.
 * done resolves to { ok, result, sessionId, costUsd, turns, denials, error }.
 */
export function runClaude({ command = 'claude', cwd, prompt, systemPrompt, mode, extraCommands, model, resume, addDirs = [], permissionMode, strictMcp, tmpDir, onEvent }) {
  const r = resolveClaude(command);
  const f = features || {};
  const policy = toolPolicy(mode, extraCommands);
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', model);
  args.push('--permission-mode', permissionMode || (f.dontAsk ? 'dontAsk' : mode === 'change' ? 'acceptEdits' : 'default'));
  args.push('--allowedTools', policy.allowed.join(','));
  args.push('--disallowedTools', policy.disallowed.join(','));
  if (strictMcp) args.push('--strict-mcp-config');
  if (resume) args.push('--resume', resume);
  let promptFile = null;
  if (systemPrompt) {
    if (f.systemPromptFile && tmpDir) {
      fs.mkdirSync(tmpDir, { recursive: true });
      promptFile = path.join(tmpDir, `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.md`);
      fs.writeFileSync(promptFile, systemPrompt);
      args.push('--append-system-prompt-file', promptFile);
    } else {
      args.push('--append-system-prompt', systemPrompt);
    }
  }
  if (addDirs.length) args.push('--add-dir', ...addDirs);

  const child = spawn(r.file, [...r.pre, ...args], {
    cwd,
    shell: r.shell,
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'dev-crew' },
  });

  let sessionId = resume || null;
  let final = null;
  let stderr = '';
  let buf = '';
  let killed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'result') final = ev;
      try { onEvent && onEvent(ev); } catch { /* a bad listener must not kill the run */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const done = new Promise(resolve => {
    const finish = (code, spawnErr) => {
      if (promptFile) fs.rm(promptFile, { force: true }, () => {});
      const ok = !!final && !final.is_error && !killed;
      resolve({
        ok,
        result: final ? String(final.result || '') : '',
        sessionId,
        costUsd: final && typeof final.total_cost_usd === 'number' ? final.total_cost_usd : 0,
        turns: final ? final.num_turns || 0 : 0,
        denials: final && Array.isArray(final.permission_denials) ? final.permission_denials : [],
        error: ok ? '' : killed ? 'Cancelled.'
          : spawnErr ? `Could not start Claude Code (${spawnErr.message}). Is it installed and on PATH?`
          : final && final.is_error ? `Claude stopped: ${final.subtype || 'error'}${final.result ? ' — ' + String(final.result).slice(0, 400) : ''}`
          : `Claude exited with code ${code}. ${stderr.trim().slice(-600)}`,
      });
    };
    child.on('error', e => finish(-1, e));
    child.on('close', code => finish(code));
  });

  const kill = () => {
    killed = true;
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  };
  return { done, kill };
}

/* ---------------- turning stream events into log lines ---------------- */

export function describeEvent(ev, cwd) {
  const rel = p => {
    if (!p) return '';
    const r = cwd ? path.relative(cwd, p) : p;
    return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p;
  };
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') out.push({ kind: 'sys', text: `Session started · ${ev.model || ''}` });
  else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text && c.text.trim()) out.push({ kind: 'say', text: c.text.trim() });
      else if (c.type === 'tool_use') {
        const i = c.input || {};
        let t = c.name;
        if (['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(c.name)) t = `${c.name} ${rel(i.file_path || i.notebook_path)}`;
        else if (c.name === 'Bash' || c.name === 'PowerShell') t = `$ ${String(i.command || '').slice(0, 200)}`;
        else if (c.name === 'Grep') t = `Grep "${i.pattern || ''}"${i.path ? ' in ' + rel(i.path) : ''}`;
        else if (c.name === 'Glob') t = `Glob ${i.pattern || ''}`;
        else if (c.name === 'WebSearch') t = `Search: ${i.query || ''}`;
        else if (c.name === 'WebFetch') t = `Fetch ${i.url || ''}`;
        else if (c.name === 'TodoWrite') t = `Plan: ${(i.todos || []).map(x => (x.status === 'completed' ? '✓ ' : '• ') + (x.content || '')).join('  ')}`.slice(0, 300);
        out.push({ kind: 'tool', text: t });
      }
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'tool_result' && c.is_error) {
        const txt = Array.isArray(c.content) ? c.content.map(x => x.text || '').join(' ') : String(c.content || '');
        out.push({ kind: 'warn', text: txt.trim().slice(0, 300) });
      }
    }
  } else if (ev.type === 'result') {
    const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(2)}` : '';
    out.push({ kind: ev.is_error ? 'err' : 'done', text: `${ev.is_error ? 'Stopped' : 'Finished'} · ${ev.num_turns || 0} turns${cost}` });
  }
  return out;
}
