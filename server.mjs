// Dev Crew server: a queue of agent runs, a daily stand-up scheduler, a small JSON API and
// a live event stream for the dashboard. Listens on 127.0.0.1 only: these agents edit code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, refreshRepos } from './lib/config.mjs';
import { ROLES, roleById } from './lib/roles.mjs';
import * as G from './lib/git.mjs';
import { runClaude, claudeFeatures, describeEvent } from './lib/claude.mjs';
import { taskSystemPrompt, taskPrompt, reportSystemPrompt, reportPrompt, parseReport, summaryOf } from './lib/prompts.mjs';
import { createStore, newId } from './lib/store.mjs';
import { createMonday } from './lib/monday.mjs';
import { search as searchPeople, directory, contactsFor } from './lib/people.mjs';

const DATA = path.join(ROOT, 'data');
const WT_DIR = path.join(DATA, 'worktrees');
const TMP = path.join(DATA, 'tmp');
const PUBLIC = path.join(ROOT, 'public');

let cfg = loadConfig();
const store = createStore(DATA);
const monday = createMonday(() => cfg);
async function refreshMonday(projectId) {
  await monday.refresh(projectId);
  emit('monday', monday.snapshot());
}
setInterval(() => refreshMonday().catch(e => console.warn(e.message)), 120000);
const S = store.state;

for (const t of S.tasks) {
  if (t.status === 'running') { t.status = 'failed'; t.error = 'Interrupted: the server stopped during this run. Send a follow-up to continue it.'; }
}
for (const r of S.reports) {
  if (r.status === 'running' || r.status === 'queued') { r.status = 'failed'; r.error = 'Interrupted: the server stopped before this report finished.'; }
}
const project = id => cfg.projects.find(p => p.id === id);
const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The very first start counts as today's run, so installing doesn't fire five reports at once.
if (!S.meta.lastDaily) S.meta.lastDaily = todayStr();
store.save();

/* ---------------- live events ---------------- */

const clients = new Set();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

function touchTask(t) { store.save(); emit('task', t); }
function touchReport(r) { store.save(); emit('report', r); }
function log(id, kind, text) {
  const entry = { at: Date.now(), kind, text };
  store.appendLog(id, entry);
  emit('log', { id, ...entry });
}

/* ---------------- the queue ---------------- */

const running = new Map(); // job id -> { kill, cancelled }

function nextJob() {
  let best = null;
  for (const t of S.tasks) if (t.status === 'queued' && (!best || t.queuedAt < best.job.queuedAt)) best = { kind: 'task', job: t };
  for (const r of S.reports) if (r.status === 'queued' && (!best || r.queuedAt < best.job.queuedAt)) best = { kind: 'report', job: r };
  return best;
}

function pump() {
  while (running.size < Math.max(1, cfg.settings.maxConcurrent)) {
    const next = nextJob();
    if (!next) return;
    const handle = { kill: null, cancelled: false };
    running.set(next.job.id, handle);
    next.job.status = 'running';
    next.job.startedAt = Date.now();
    (next.kind === 'task' ? execTask(next.job, handle) : execReport(next.job, handle))
      .catch(e => console.error('job crashed', e))
      .finally(() => { running.delete(next.job.id); pump(); });
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
}

async function execTask(t, handle) {
  t.error = '';
  touchTask(t);
  let repo = null;
  try {
    const p = project(t.projectId);
    if (!p) throw new Error(`Project "${t.projectId}" is no longer in the config.`);
    refreshRepos(p);
    repo = p.repos.find(r => r.name === t.repo) || null;
    let cwd;
    let addDirs = [];
    if (t.mode === 'change') {
      if (!repo) throw new Error(`Repo "${t.repo}" was not found in ${p.path}.`);
      if (t.cleaned) throw new Error('This task\'s worktree was cleaned up. Assign a new task to continue on that branch.');
      if (!t.worktree) {
        const base = t.base || (await G.currentBranch(repo.path)) || 'HEAD';
        const d = new Date();
        const branch = `agent/${t.role}/${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${slug(t.title)}-${t.id.slice(-4)}`;
        const dir = path.join(WT_DIR, t.projectId, t.id);
        log(t.id, 'sys', `Creating branch ${branch} from ${base} in its own worktree`);
        t.baseSha = await G.addWorktree(repo.path, dir, branch, base);
        Object.assign(t, { base, branch, worktree: dir });
        touchTask(t);
      } else if (!fs.existsSync(t.worktree)) {
        throw new Error('The worktree folder for this task is missing.');
      }
      cwd = t.worktree;
    } else if (repo) {
      cwd = repo.path;
    } else {
      cwd = p.path;
      addDirs = p.repos.map(r => r.path).filter(rp => path.relative(cwd, rp).startsWith('..'));
    }
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);

    const followup = t.pendingFollowup || '';
    t.pendingFollowup = '';
    const resume = followup && t.sessionId ? t.sessionId : undefined;
    const prompt = resume ? followup : taskPrompt(t) + (followup ? `\n\nAlso from the owner: ${followup}` : '');
    if (followup) log(t.id, 'you', followup);

    const run = runClaude({
      command: cfg.settings.claudeCommand,
      cwd,
      prompt,
      systemPrompt: taskSystemPrompt(p, t.role, t.mode, { cwd, branch: t.branch, base: t.base }),
      mode: t.mode,
      extraCommands: p.allowCommands,
      model: t.model || (p.roles[t.role] || {}).model || cfg.settings.model,
      resume,
      addDirs,
      permissionMode: cfg.settings.permissionMode,
      strictMcp: cfg.settings.strictMcp,
      tmpDir: TMP,
      onEvent: ev => {
        if (ev.type === 'system' && ev.session_id && ev.session_id !== t.sessionId) { t.sessionId = ev.session_id; store.save(); }
        for (const l of describeEvent(ev, cwd)) log(t.id, l.kind, l.text);
      },
    });
    handle.kill = run.kill;
    if (handle.cancelled) run.kill();
    const res = await run.done;

    if (res.sessionId) t.sessionId = res.sessionId;
    t.costUsd = (t.costUsd || 0) + res.costUsd;
    t.turns = (t.turns || 0) + res.turns;
    if (res.denials.length) {
      const what = res.denials.map(d => d.tool_name + (d.tool_input && d.tool_input.command ? `: ${d.tool_input.command}` : '')).join(' · ');
      log(t.id, 'warn', `Blocked by the crew's permissions: ${what}`.slice(0, 800));
    }
    if (res.result) {
      t.result = res.result;
      t.summary = summaryOf(res.result);
      (t.history = t.history || []).push({ at: Date.now(), prompt: followup || t.title, result: res.result });
    }
    if (t.mode === 'change' && t.baseSha) t.git = await G.branchSummary(repo.path, t.baseSha, t.branch, t.worktree);
    if (handle.cancelled) { t.status = 'cancelled'; t.error = 'Cancelled.'; }
    else if (res.ok) t.status = 'done';
    else { t.status = 'failed'; t.error = res.error; log(t.id, 'err', res.error); }
  } catch (e) {
    t.status = handle.cancelled ? 'cancelled' : 'failed';
    t.error = e.message;
    log(t.id, 'err', e.message);
  }
  t.endedAt = Date.now();
  touchTask(t);
}

async function execReport(r, handle) {
  touchReport(r);
  try {
    const p = project(r.projectId);
    if (!p) throw new Error(`Project "${r.projectId}" is no longer in the config.`);
    refreshRepos(p);
    if (!p.exists) throw new Error(`Project folder not found: ${p.path}. Clone the repos there or fix "folder" in the config.`);
    const since = Date.now() - 3 * 864e5;
    const tasks = S.tasks
      .filter(t => t.projectId === p.id && (t.createdAt > since || t.status === 'queued' || t.status === 'running'))
      .map(t => ({
        role: roleById(t.role).name, title: t.title, status: t.status, branch: t.branch,
        commits: t.git ? t.git.commits.length : 0, summary: t.summary, error: t.status === 'failed' ? t.error : '',
      }));
    const repos = [];
    for (const rp of p.repos) repos.push({ name: rp.name, ...(await G.recentActivity(rp.path)) });
    const board = monday.snapshot().boards[p.id];
    const tickets = board ? board.items.filter(i => !/^done$/i.test(i.status)).slice(0, 40).map(i => ({
      roles: i.roles.map(x => roleById(x).name), name: i.name, status: i.status, due: i.due, people: i.people,
    })) : [];
    log(r.id, 'sys', `Gathered ${tasks.length} task(s), ${tickets.length} open ticket(s) and activity from ${repos.length} repo(s)`);

    const run = runClaude({
      command: cfg.settings.claudeCommand,
      cwd: p.path,
      prompt: reportPrompt(p, { date: r.date, tasks, repos, tickets }),
      systemPrompt: reportSystemPrompt(p),
      mode: 'analyze',
      model: cfg.settings.reportModel || cfg.settings.model,
      addDirs: p.repos.map(x => x.path).filter(rp => path.relative(p.path, rp).startsWith('..')),
      permissionMode: cfg.settings.permissionMode,
      strictMcp: cfg.settings.strictMcp,
      tmpDir: TMP,
      onEvent: ev => { for (const l of describeEvent(ev, p.path)) if (l.kind !== 'say') log(r.id, l.kind, l.text); },
    });
    handle.kill = run.kill;
    if (handle.cancelled) run.kill();
    const res = await run.done;
    r.costUsd = res.costUsd;
    if (res.ok) {
      Object.assign(r, parseReport(res.result), { status: 'done' });
    } else {
      r.status = handle.cancelled ? 'cancelled' : 'failed';
      r.error = res.error;
    }
  } catch (e) {
    r.status = 'failed';
    r.error = e.message;
    log(r.id, 'err', e.message);
  }
  r.endedAt = Date.now();
  touchReport(r);
}

/* ---------------- daily stand-ups ---------------- */

function queueReports(projectId, trigger) {
  const made = [];
  for (const p of cfg.projects) {
    if (projectId && p.id !== projectId) continue;
    if (S.reports.some(r => r.projectId === p.id && (r.status === 'queued' || r.status === 'running'))) continue;
    const r = { id: newId('r'), projectId: p.id, date: todayStr(), trigger, status: 'queued', createdAt: Date.now(), queuedAt: Date.now() };
    S.reports.unshift(r);
    made.push(r);
    emit('report', r);
  }
  S.reports = S.reports.slice(0, 300);
  store.save();
  pump();
  return made;
}

function nextDaily() {
  const dr = cfg.settings.dailyReport;
  if (!dr.enabled) return null;
  const [h, m] = String(dr.at).split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  if (S.meta.lastDaily === todayStr()) d.setDate(d.getDate() + 1);
  while (dr.weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function checkDaily() {
  const dr = cfg.settings.dailyReport;
  if (!dr.enabled) return;
  const now = new Date();
  if (dr.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return;
  const [h, m] = String(dr.at).split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < (h || 0) * 60 + (m || 0)) return;
  if (S.meta.lastDaily === todayStr(now)) return;
  S.meta.lastDaily = todayStr(now);
  console.log(`Daily stand-up: queuing reports for ${cfg.projects.length} project(s)`);
  queueReports(null, 'scheduled');
}
setInterval(checkDaily, 30000);

/* ---------------- HTTP ---------------- */

const publicProject = p => ({
  id: p.id, name: p.name, path: p.path, stack: p.stack, context: p.context, exists: p.exists,
  repos: p.repos.map(r => ({ name: r.name, path: r.path, exists: r.exists })), roles: p.roles,
});

async function stateView() {
  return {
    settings: {
      model: cfg.settings.model, reportModel: cfg.settings.reportModel, maxConcurrent: cfg.settings.maxConcurrent,
      dailyReport: cfg.settings.dailyReport, workspacePath: cfg.settings.workspacePath, configFile: path.basename(cfg.file),
    },
    problems: cfg.problems,
    claude: await claudeFeatures(cfg.settings.claudeCommand),
    roles: ROLES.map(({ prompt, ...r }) => r),
    projects: cfg.projects.map(publicProject),
    tasks: S.tasks,
    reports: S.reports,
    nextDaily: nextDaily(),
    monday: monday.snapshot(),
    people: directory(cfg, monday.snapshot()).map(({ tickets, ...p }) => ({ ...p, ticketCount: tickets.length })),
    contacts: Object.fromEntries(cfg.projects.map(p => [p.id, Object.fromEntries(ROLES.map(r => [r.id, contactsFor(p.id, r.id, cfg, monday.snapshot()).map(x => x.name)]))])),
  };
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function createTask(b) {
  const p = project(b.projectId);
  if (!p) throw new Error('Unknown project.');
  if (!roleById(b.role)) throw new Error('Unknown role.');
  const mode = b.mode === 'analyze' ? 'analyze' : 'change';
  const title = String(b.title || '').trim();
  if (!title) throw new Error('Give the task a title.');
  refreshRepos(p);
  let repoName = String(b.repo || '').trim();
  if (repoName === '*' && mode === 'change') throw new Error('Pick one repo for a task that changes code.');
  if (repoName !== '*' && !p.repos.some(r => r.name === repoName)) {
    if (p.repos.length === 1) repoName = p.repos[0].name;
    else throw new Error(p.repos.length ? `Unknown repo "${repoName}".` : `No git repos found in ${p.path}.`);
  }
  let details = String(b.details || '').slice(0, 8000);
  let ticket = null;
  if (b.ticketId) {
    const d = await monday.details(p.id, b.ticketId);
    ticket = { itemId: d.id, name: d.name, url: d.url, status: d.status };
    const cols = Object.entries(d.columns || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const ups = (d.updates || []).map(u => `- ${u.by || 'someone'}: ${u.text.replace(/\s+/g, ' ')}`).join('\n');
    details = `monday.com ticket "${d.name}"${d.url ? ` (${d.url})` : ''}\n${cols}${ups ? `\n\nLatest updates on the ticket:\n${ups}` : ''}${details ? `\n\nFrom the owner:\n${details}` : ''}`;
  }
  const t = {
    id: newId('t'), projectId: p.id, role: b.role, mode, repo: repoName, base: String(b.base || '').trim(),
    title: title.slice(0, 200), details, model: String(b.model || ''), ticket,
    status: 'queued', createdAt: Date.now(), queuedAt: Date.now(), costUsd: 0, turns: 0, history: [],
  };
  S.tasks.unshift(t);
  touchTask(t);
  pump();
  return t;
}

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (m === 'GET' && url.pathname === '/api/state') return send(res, 200, await stateView());

  if (m === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && parts[1] === 'log' && parts[2]) return send(res, 200, store.readLog(parts[2]));

  if (m === 'GET' && url.pathname === '/api/branches') {
    const p = project(url.searchParams.get('project'));
    const repo = p && p.repos.find(r => r.name === url.searchParams.get('repo'));
    if (!repo) return send(res, 404, { error: 'Unknown repo.' });
    return send(res, 200, { current: await G.currentBranch(repo.path), branches: await G.localBranches(repo.path) });
  }

  if (m === 'POST' && url.pathname === '/api/tasks') return send(res, 200, await createTask(await readBody(req)));

  if (m === 'GET' && url.pathname === '/api/people/search') return send(res, 200, searchPeople(url.searchParams.get('q') || '', cfg, monday.snapshot()));

  if (m === 'GET' && url.pathname === '/api/monday') {
    if (url.searchParams.get('refresh')) await refreshMonday(url.searchParams.get('project') || undefined);
    return send(res, 200, monday.snapshot());
  }

  if (m === 'POST' && (url.pathname === '/api/monday/assign' || url.pathname === '/api/monday/create')) {
    const b = await readBody(req);
    if (!project(b.projectId)) return send(res, 400, { error: 'Unknown project.' });
    const person = b.person ? directory(cfg, monday.snapshot()).find(x => x.name === b.person) : null;
    if (b.person && !person) return send(res, 400, { error: `${b.person} is not in the people list.` });
    let out;
    if (url.pathname.endsWith('/assign')) {
      if (!person) return send(res, 400, { error: 'Pick who to assign it to.' });
      out = await monday.assign(b.projectId, b.itemId, person);
    } else {
      const name = String(b.name || '').trim();
      if (!name) return send(res, 400, { error: 'Give the ticket a name.' });
      out = await monday.createItem(b.projectId, { name: name.slice(0, 250), description: String(b.description || '').slice(0, 4000), role: roleById(b.role) ? b.role : '', person });
    }
    emit('monday', monday.snapshot());
    return send(res, 200, out);
  }

  if (parts[1] === 'tasks' && parts[2]) {
    const t = S.tasks.find(x => x.id === parts[2]);
    if (!t) return send(res, 404, { error: 'No such task.' });
    const action = parts[3];
    if (m === 'POST' && action === 'followup') {
      const { text } = await readBody(req);
      if (!String(text || '').trim()) return send(res, 400, { error: 'Write the follow-up first.' });
      if (t.status === 'running' || t.status === 'queued') return send(res, 409, { error: 'The agent is still on this task. Wait for it to finish.' });
      if (t.cleaned) return send(res, 409, { error: 'This task\'s worktree was cleaned up. Assign a new task instead.' });
      t.pendingFollowup = String(text).trim().slice(0, 8000);
      t.status = 'queued';
      t.queuedAt = Date.now();
      touchTask(t);
      pump();
      return send(res, 200, t);
    }
    if (m === 'POST' && action === 'cancel') {
      if (t.status === 'queued') { t.status = 'cancelled'; t.pendingFollowup = ''; touchTask(t); }
      const h = running.get(t.id);
      if (h) { h.cancelled = true; if (h.kill) h.kill(); }
      return send(res, 200, t);
    }
    if (m === 'POST' && action === 'monday-update') {
      if (!t.ticket) return send(res, 400, { error: 'This task is not linked to a monday.com ticket.' });
      if (!t.result) return send(res, 400, { error: 'There is no report to post yet.' });
      const lines = [`<b>${roleById(t.role).name} (Dev Crew)</b>: ${t.status === 'done' ? 'finished' : t.status}`, '', (t.summary || '').replace(/\n/g, '<br>')];
      if (t.branch) lines.push('', `Branch: ${t.branch}${t.git ? ` (${t.git.commits.length} commit(s), ${t.git.shortstat || 'no changes'})` : ''}. Not pushed yet; waiting for review.`);
      const r = await monday.postUpdate(t.projectId, t.ticket.itemId, lines.join('<br>'));
      t.ticket.postedAt = Date.now();
      log(t.id, 'sys', r.demo ? 'Report posted to the demo ticket.' : 'Report posted to the monday.com ticket.');
      touchTask(t);
      return send(res, 200, t);
    }
    if (m === 'POST' && action === 'cleanup') {
      if (running.has(t.id) || t.status === 'queued') return send(res, 409, { error: 'Cancel the task first.' });
      if (t.worktree && !t.cleaned) {
        const p = project(t.projectId);
        const repo = p && p.repos.find(r => r.name === t.repo);
        if (repo) await G.removeWorktree(repo.path, t.worktree);
        t.cleaned = true;
        log(t.id, 'sys', `Worktree removed. Branch ${t.branch} is kept in the repo.`);
        touchTask(t);
      }
      return send(res, 200, t);
    }
    if (m === 'DELETE' && !action) {
      if (running.has(t.id) || t.status === 'queued') return send(res, 409, { error: 'Cancel the task first.' });
      if (t.worktree && !t.cleaned) {
        const p = project(t.projectId);
        const repo = p && p.repos.find(r => r.name === t.repo);
        if (repo) await G.removeWorktree(repo.path, t.worktree);
      }
      S.tasks = S.tasks.filter(x => x !== t);
      store.save();
      emit('task-removed', { id: t.id });
      return send(res, 200, { ok: true });
    }
  }

  if (m === 'POST' && url.pathname === '/api/reports/run') {
    const { projectId } = await readBody(req);
    return send(res, 200, queueReports(projectId || null, 'manual'));
  }

  if (m === 'POST' && parts[1] === 'reports' && parts[3] === 'cancel') {
    const r = S.reports.find(x => x.id === parts[2]);
    if (!r) return send(res, 404, { error: 'No such report.' });
    if (r.status === 'queued') { r.status = 'cancelled'; touchReport(r); }
    const h = running.get(r.id);
    if (h) { h.cancelled = true; if (h.kill) h.kill(); }
    return send(res, 200, r);
  }

  if (m === 'POST' && url.pathname === '/api/reload') {
    cfg = loadConfig();
    emit('reload', {});
    return send(res, 200, { ok: true, problems: cfg.problems });
  }

  return send(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

const shutdown = () => {
  for (const h of running.values()) if (h.kill) h.kill();
  store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(cfg.settings.port, '127.0.0.1', async () => {
  const f = await claudeFeatures(cfg.settings.claudeCommand);
  console.log(`\nDev Crew → http://localhost:${cfg.settings.port}`);
  console.log(`  config:    ${cfg.file}`);
  console.log(`  workspace: ${cfg.settings.workspacePath}`);
  for (const p of cfg.projects) {
    console.log(`  · ${p.name.padEnd(22)} ${p.exists ? `${p.repos.length} repo(s): ${p.repos.map(r => r.name).join(', ') || '—'}` : `folder missing (${p.path})`}`);
  }
  for (const pr of cfg.problems) console.log(`  ! ${pr}`);
  console.log(`  claude:    ${f.found ? f.version : 'NOT FOUND — install Claude Code and log in'}`);
  const dr = cfg.settings.dailyReport;
  console.log(`  stand-up:  ${dr.enabled ? `daily at ${dr.at}${dr.weekdaysOnly ? ' on weekdays' : ''}` : 'off'} · ${cfg.settings.maxConcurrent} agent(s) at a time\n`);
  pump();
  setTimeout(checkDaily, 5000);
  refreshMonday().then(() => {
    const snap = monday.snapshot();
    console.log(`  monday:    ${snap.connected ? `connected · ${Object.values(snap.boards).filter(b => !b.demo).length} board(s)` : 'not connected (demo tickets) · set MONDAY_API_TOKEN to connect'}`);
  }).catch(e => console.warn(e.message));
});
