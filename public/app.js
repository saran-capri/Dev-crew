// Dev Crew dashboard. No framework: state from /api/state, live updates from /api/events,
// views are re-rendered from that state.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null;
const activity = {};          // task id -> last thing the agent did
let drawer = null;            // { kind: 'task'|'report', id }
const ui = { taskFilter: 'all', roleFilter: '' };
const feed = [];              // latest agent activity across all projects, newest first
let office = null;            // the 3D office, created on first visit
let officeEl = null;

/* ---------------- data ---------------- */

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function load() {
  S = await api('/api/state');
  render();
  if (drawer) refreshDrawer();
}

function upsert(list, item) {
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.unshift(item);
}

function connect() {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.onopen = () => { if (dropped) { dropped = false; load(); } };
  es.onerror = () => { dropped = true; };
  es.addEventListener('task', e => {
    const t = JSON.parse(e.data);
    upsert(S.tasks, t);
    if (t.status !== 'running') delete activity[t.id];
    schedule();
    if (drawer && drawer.id === t.id) refreshDrawer();
  });
  es.addEventListener('task-removed', e => {
    const { id } = JSON.parse(e.data);
    S.tasks = S.tasks.filter(t => t.id !== id);
    if (drawer && drawer.id === id) closeDrawer();
    schedule();
  });
  es.addEventListener('report', e => {
    const r = JSON.parse(e.data);
    upsert(S.reports, r);
    schedule();
    if (drawer && drawer.id === r.id) refreshDrawer();
  });
  es.addEventListener('log', e => {
    const l = JSON.parse(e.data);
    if (l.kind === 'tool' || l.kind === 'say') {
      activity[l.id] = l.text.split('\n')[0];
      const t = S.tasks.find(x => x.id === l.id);
      if (t) { feed.unshift({ at: l.at, task: t.id, projectId: t.projectId, role: t.role, text: activity[l.id] }); feed.length = Math.min(feed.length, 40); }
      schedule();
    }
    if (drawer && drawer.id === l.id) appendLog([l]);
  });
  es.addEventListener('reload', () => load());
  es.addEventListener('monday', () => load());
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

/* ---------------- helpers ---------------- */

const roleOf = id => S.roles.find(r => r.id === id) || { id, name: id, short: id, color: '#888' };
const projOf = id => S.projects.find(p => p.id === id);
const tasksOf = pid => S.tasks.filter(t => t.projectId === pid);
const latestReport = pid => S.reports.find(r => r.projectId === pid && r.status === 'done');
const isToday = ms => new Date(ms).toDateString() === new Date().toDateString();
const needsReview = t => t.mode === 'change' && t.status === 'done' && !t.cleaned && t.git && t.git.commits.length > 0;

function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
const fmtTime = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const money = n => (n ? `$${n.toFixed(2)}` : '');

function roleChip(roleId, cls = '') {
  const r = roleOf(roleId);
  return `<span class="role-chip ${cls}" style="--rc:${r.color}" title="${esc(r.name)}">${esc(r.short)}</span>`;
}

function statusPill(t) {
  if (t.status === 'running') return '<span class="pill blue">Working</span>';
  if (t.status === 'queued') return '<span class="pill blue">Queued</span>';
  if (t.status === 'failed') return '<span class="pill red">Failed</span>';
  if (t.status === 'cancelled') return '<span class="pill">Cancelled</span>';
  if (needsReview(t)) return '<span class="pill amber">Review</span>';
  return '<span class="pill green">Done</span>';
}

function healthPill(r) {
  if (!r) return '<span class="pill">No stand-up yet</span>';
  const label = { green: 'On track', amber: 'Watch', red: 'At risk' }[r.health] || 'Reported';
  return `<span class="pill ${r.health}">${label}</span>`;
}

function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = 'toast'; }, err ? 5000 : 2600);
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
}

/* ---------------- markdown (small, escapes everything first) ---------------- */

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const isBlock = l => /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\|)/.test(l) || /^\s*(---+|\*\*\*+)\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      const lvl = Math.min(4, Math.max(2, h[1].length));
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { html += '<hr>'; i++; continue; }
    if (/^\s*[-*+]\s/.test(l) || /^\s*\d+[.)]\s/.test(l)) {
      const ordered = /^\s*\d+[.)]\s/.test(l);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      html += ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`;
      continue;
    }
    if (l.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      html += `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    const para = [l];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) para.push(lines[i++]);
    html += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return `<div class="md">${html}</div>`;
}

/* ---------------- layout ---------------- */

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'p' && parts[1]) return { view: 'project', id: parts[1], tab: parts[2] || 'crew' };
  if (parts[0] === 'today') return { view: 'today' };
  return { view: 'office' };
}

function render() {
  if (!S) return;
  renderTop();
  renderSidebar();
  const r = route();
  const main = $('#main');
  if (r.view === 'office') return renderOffice();
  main.classList.remove('full');
  closeAgentCard();
  if (office && office.stop) office.stop();
  if (officeEl && main.contains(officeEl)) main.replaceChildren();
  const scroll = window.scrollY;
  if (r.view === 'project' && projOf(r.id)) main.innerHTML = projectView(projOf(r.id), r.tab);
  else main.innerHTML = todayView();
  window.scrollTo(0, scroll);
}

function renderTop() {
  const running = S.tasks.filter(t => t.status === 'running').length + S.reports.filter(r => r.status === 'running').length;
  const queued = S.tasks.filter(t => t.status === 'queued').length + S.reports.filter(r => r.status === 'queued').length;
  const review = S.tasks.filter(needsReview).length;
  const spent = S.tasks.filter(t => isToday(t.startedAt)).reduce((a, t) => a + (t.costUsd || 0), 0)
    + S.reports.filter(r => isToday(r.startedAt)).reduce((a, r) => a + (r.costUsd || 0), 0);
  $('#topStats').innerHTML = `
    <span><b>${running}</b> working</span>
    <span><b>${queued}</b> queued</span>
    <span><b>${review}</b> to review</span>
    ${spent ? `<span title="API-equivalent cost reported by Claude Code"><b>${money(spent)}</b> today</span>` : ''}`;
}

function renderSidebar() {
  const r = route();
  const items = S.projects.map(p => {
    const rep = latestReport(p.id);
    const live = tasksOf(p.id).filter(t => t.status === 'running' || t.status === 'queued').length;
    return `<a class="nav-item ${r.view === 'project' && r.id === p.id ? 'active' : ''}" href="#/p/${p.id}">
      <span class="dot ${rep ? rep.health : ''}"></span>
      <span class="grow">${esc(p.name)}</span>
      ${live ? `<span class="count live">${live}</span>` : ''}
    </a>`;
  }).join('');
  const dr = S.settings.dailyReport;
  $('#sidebar').innerHTML = `
    <a class="nav-item ${r.view === 'office' ? 'active' : ''}" href="#/office"><span class="grow">Office</span></a>
    <a class="nav-item ${r.view === 'today' ? 'active' : ''}" href="#/today"><span class="grow">Today</span></a>
    <div class="nav-label">Projects</div>
    ${items || '<div class="empty">No projects in the config.</div>'}
    <div class="nav-foot">
      <div>Stand-up: ${dr.enabled ? (S.nextDaily ? fmtTime(S.nextDaily) : dr.at) : 'off'}</div>
      <div>${S.claude.found ? esc(S.claude.version) : '<span style="color:var(--red)">Claude Code not found</span>'}</div>
      <div title="${esc(S.settings.workspacePath)}">${esc(S.settings.configFile)} · ${S.settings.maxConcurrent} at a time</div>
    </div>`;
}

function problemsNotice() {
  const out = [];
  if (!S.claude.found) out.push('<b>Claude Code was not found.</b> Install it (<code>npm i -g @anthropic-ai/claude-code</code>), run <code>claude</code> once to log in, then restart Dev Crew.');
  for (const p of S.problems) out.push(`<b>Config:</b> ${esc(p)}`);
  const missing = S.projects.filter(p => !p.exists);
  if (missing.length) out.push(`<b>Folder not found</b> for ${missing.map(p => esc(p.name)).join(', ')}. Clone the repos into <code>${esc(S.settings.workspacePath)}</code> or edit <code>${esc(S.settings.configFile)}</code>.`);
  return out.map(x => `<div class="notice">${x}</div>`).join('');
}

/* ---------------- Office (3D) ---------------- */

function renderOffice() {
  const main = $('#main');
  main.classList.add('full');
  if (!officeEl) {
    officeEl = document.createElement('div');
    officeEl.className = 'office-wrap';
    officeEl.innerHTML = `
      <div class="office-stage" id="officeStage"></div>
      <div class="office-head">
        <h1>The office</h1>
        <p>Your crews at their desks. Click someone to give them work or see what they are doing; click a floor to open that project.</p>
        <ul class="legend">
          <li><i class="lg working"></i>Working</li>
          <li><i class="lg review"></i>Waiting for your review</li>
          <li><i class="lg failed"></i>Needs attention</li>
        </ul>
      </div>
      <div class="office-tools">
        <button class="icon-btn" data-office="in" aria-label="Zoom in">+</button>
        <button class="icon-btn" data-office="out" aria-label="Zoom out">−</button>
        <button class="btn sm" data-office="fit">Fit</button>
      </div>
      <section class="office-feed" aria-label="Live activity"><h2>Live</h2><ol id="officeFeed"></ol></section>`;
  }
  if (!main.contains(officeEl)) main.replaceChildren(officeEl);
  if (!office) {
    office = 'loading';
    import('./office3d.js').then(m => {
      office = m.createOffice($('#officeStage'), {
        onAgent: (pid, role) => openAgentCard(pid, role),
        onZone: pid => { location.hash = `#/p/${pid}`; },
        onHub: () => { location.hash = '#/today'; },
      });
      if (!office) {
        $('#officeStage').innerHTML = '<div class="notice" style="margin:96px 24px 0">This browser could not start 3D graphics (WebGL). The <a href="#/today">Today</a> page shows the same information.</div>';
        office = { update() {}, start() {}, stop() {}, fit() {}, zoomBy() {} };
      }
      if (route().view === 'office') renderOffice();
    }).catch(e => {
      office = null;
      $('#officeStage').innerHTML = `<div class="notice" style="margin:96px 24px 0">Could not load the 3D office: ${esc(e.message)}</div>`;
    });
    return;
  }
  if (office === 'loading') return;
  office.update(S, activity);
  office.start();
  refreshAgentCard();
  const items = feed.slice(0, 7).map(f => {
    const p = projOf(f.projectId);
    return `<li data-task="${f.task}">${roleChip(f.role)}<span class="f-text"><b>${esc(p ? p.name : '')}</b> ${esc(f.text)}</span><time>${ago(f.at)}</time></li>`;
  }).join('');
  const running = S.tasks.filter(t => t.status === 'running');
  $('#officeFeed').innerHTML = items || (running.length
    ? running.map(t => `<li data-task="${t.id}">${roleChip(t.role)}<span class="f-text"><b>${esc((projOf(t.projectId) || {}).name || '')}</b> ${esc(t.title)}</span></li>`).join('')
    : '<li class="f-empty">Quiet right now. Assign a task and the work shows up here as it happens.</li>');
}

/* ---------------- monday tickets, the agent card, people ---------------- */

const boardOf = pid => (S.monday && S.monday.boards && S.monday.boards[pid]) || null;
const isDone = s => /^(done|complete|completed|closed|resolved)$/i.test(String(s || '').trim());
function ticketPill(status) {
  const s = String(status || '');
  const cls = isDone(s) ? 'green' : /stuck|block/i.test(s) ? 'red' : /work|progress|review|doing/i.test(s) ? 'amber' : '';
  return `<span class="pill ${cls}">${esc(s || 'No status')}</span>`;
}
const ticketsFor = (pid, role) => {
  const b = boardOf(pid);
  return b ? b.items.filter(i => i.roles.includes(role)).sort((x, y) => isDone(x.status) - isDone(y.status)) : [];
};
const taskForTicket = (pid, itemId) => S.tasks.find(t => t.projectId === pid && t.ticket && t.ticket.itemId === itemId);
const personByName = n => (S.people || []).find(p => p.name === n);

/** What the agent says when you walk up to them. */
function agentSays(pid, role) {
  const mine = tasksOf(pid).filter(t => t.role === role);
  const run = mine.find(t => t.status === 'running');
  const queued = mine.filter(t => t.status === 'queued');
  const last = mine.find(t => t.status !== 'running' && t.status !== 'queued');
  const open = ticketsFor(pid, role).filter(i => !isDone(i.status));
  const stuck = open.find(i => /stuck|block/i.test(i.status));
  if (run) {
    const tk = run.ticket ? `the “${run.ticket.name}” ticket` : `“${run.title}”`;
    return `I'm on ${tk}. Right now: ${activity[run.id] || 'getting started'}.${queued.length ? ` After that I have ${queued.length} more lined up.` : ''}`;
  }
  if (last && last.status === 'failed') return `I got stuck on “${last.title}”: ${String(last.error || '').split('\n')[0].slice(0, 140)} Send me a follow-up and I'll pick it up again.`;
  if (last && needsReview(last)) return `I finished “${last.title}”. It's on branch ${last.branch}, ${last.git.commits.length} commit${last.git.commits.length > 1 ? 's' : ''}, waiting for your review.`;
  if (queued.length) return `I have ${queued.length} task${queued.length > 1 ? 's' : ''} lined up. Next: “${queued[queued.length - 1].title}”.`;
  if (open.length) return `I'm free. ${open.length} ticket${open.length > 1 ? 's are' : ' is'} open for my role on the board${stuck ? `; “${stuck.name}” is stuck and could use me` : ''}. Pick one and I'll start.`;
  return 'I\'m free, and nothing on the board is waiting for my role. Give me something to do.';
}

function agentCardHtml(pid, role) {
  const p = projOf(pid);
  const r = roleOf(role);
  const b = boardOf(pid);
  const items = ticketsFor(pid, role).slice(0, 5);
  const contacts = ((S.contacts || {})[pid] || {})[role] || [];
  const mine = tasksOf(pid).filter(t => t.role === role);
  const current = mine.find(t => t.status === 'running') || mine.find(t => t.status === 'failed' || needsReview(t));
  const rows = items.map(i => {
    const t = taskForTicket(pid, i.id);
    let act = `<button class="btn sm" data-ticket-work="${esc(i.id)}">Work on it</button>`;
    if (t && (t.status === 'running' || t.status === 'queued')) act = `<button class="btn sm ghost" data-task="${t.id}">${t.status === 'running' ? 'Working' : 'Queued'}</button>`;
    else if (t && t.status === 'done' && !t.ticket.postedAt) act = `<button class="btn sm" data-ticket-post="${t.id}" title="Post the agent's report as an update on the ticket">Post report</button>`;
    else if (t) act = `<button class="btn sm ghost" data-task="${t.id}">View task</button>`;
    return `<li><div class="tk-main">${ticketPill(i.status)}<span class="tk-name" title="${esc(i.name)}">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.name)}</a>` : esc(i.name)}</span></div>
      <div class="tk-meta">${i.due ? `Due ${esc(i.due)}` : ''}${i.people.length ? `${i.due ? ' · ' : ''}${esc(i.people.join(', '))}` : ''}</div>${act}</li>`;
  }).join('');
  return `<div class="ac" style="--rc:${r.color}">
    <header><span class="avatar sm">${esc(r.short)}</span><div class="ac-who"><b>${esc(r.name)}</b><span>${esc(p ? p.name : pid)}</span></div><button class="icon-btn" data-card-close aria-label="Close">✕</button></header>
    <p class="say">${esc(agentSays(pid, role))}</p>
    <section><h4>On the board${b && b.demo ? ' <span class="demo-tag" title="Connect monday.com in the config to see your real board">demo</span>' : ''}</h4>
      ${items.length ? `<ul class="tickets">${rows}</ul>` : '<p class="muted">No tickets for this role.</p>'}
      ${b && b.error ? `<p class="err-line">${esc(b.error)}</p>` : ''}</section>
    ${contacts.length ? `<section><h4>Ask a person</h4><div class="contacts">${contacts.map(n => {
      const pp = personByName(n) || { name: n };
      return `<button class="contact" data-person="${esc(n)}"><b>${esc(n)}</b><span>${esc([pp.title, pp.company].filter(Boolean).join(', '))}${pp.contractor ? ' · contractor' : ''}</span></button>`;
    }).join('')}</div></section>` : ''}
    <footer>
      <button class="btn sm primary" data-act="assign" data-project="${pid}" data-role="${role}">Assign a task</button>
      ${current ? `<button class="btn sm" data-task="${current.id}">Open current task</button>` : ''}
      <a class="btn sm ghost" href="#/p/${pid}/tasks" data-rolefilter="${role}">History</a>
    </footer>
  </div>`;
}

function openAgentCard(pid, role) {
  if (!office || !office.focus) return openAssign({ projectId: pid, role });
  ui.card = { pid, role };
  if (!ui.cardEl) ui.cardEl = document.createElement('div');
  ui.cardEl.innerHTML = agentCardHtml(pid, role);
  office.focus(pid, role);
  office.attachCard(ui.cardEl, pid, role);
}
function closeAgentCard() {
  if (!ui.card) return;
  ui.card = null;
  if (office && office.release) { office.release(); office.detachCard(); }
}
function refreshAgentCard() {
  if (!ui.card || !ui.cardEl) return;
  if (ui.card.kind === 'person') return;
  const html = agentCardHtml(ui.card.pid, ui.card.role);
  if (ui.cardEl.innerHTML !== html) ui.cardEl.innerHTML = html;
}

/* ---------- "Who should I ask?" ---------- */

let searchTimer = 0;
let lastSearch = null;

function contactLinks(p) {
  const links = [];
  if (p.email) links.push(`<a class="btn sm" href="mailto:${encodeURIComponent(p.email)}">Email</a>`);
  if (p.teams || p.email) links.push(`<a class="btn sm" href="https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(p.teams || p.email)}" target="_blank" rel="noopener">Chat in Teams</a>`);
  if (p.email) links.push(`<button class="btn sm ghost" data-copy="${esc(p.email)}">Copy email</button>`);
  return links.join('');
}

function personCardHtml(res, parsed) {
  const p = res.person;
  return `<div class="pc">
    <div class="pc-name">${esc(p.name)}</div>
    <div class="pc-sub">${esc([p.title, p.company].filter(Boolean).join(', '))}${p.contractor ? ' <span class="pill amber">Contractor</span>' : ''}</div>
    <ul class="pc-why">${res.why.map(w => `<li>${esc(w)}</li>`).join('')}${p.hours ? `<li>Available ${esc(p.hours)}</li>` : ''}</ul>
    ${res.tickets && res.tickets.length ? `<div class="pc-tix">${res.tickets.map(t => `<div>${ticketPill(t.status)} ${esc(t.name)}</div>`).join('')}</div>` : ''}
    <div class="pc-actions">${contactLinks(p)}
      <button class="btn sm primary" data-person-assign="${esc(p.name)}" data-project="${esc(parsed.projectId || '')}" data-role="${esc((parsed.roles || [])[0] || '')}">Assign a ticket</button>
    </div>
  </div>`;
}

async function runSearch(q) {
  const pop = $('#peoplePop');
  if (!q.trim()) { pop.hidden = true; return; }
  let r;
  try { r = await api(`/api/people/search?q=${encodeURIComponent(q)}`); } catch (e) { toast(e.message, true); return; }
  lastSearch = r;
  const scope = [r.parsed.roleNames.join(' and '), r.parsed.projectName && `on ${r.parsed.projectName}`].filter(Boolean).join(' ');
  if (!r.results.length) {
    pop.innerHTML = `<div class="pp-empty">Nobody listed${scope ? ` for ${esc(scope)}` : ''}. Add people to the <code>people</code> list in <code>${esc(S.settings.configFile)}</code>, or put them on tickets in the monday board.</div>`;
  } else {
    const [top, ...rest] = r.results;
    const strong = rest.filter(x => x.score >= 8);
    const weak = rest.filter(x => x.score < 8).slice(0, 4);
    pop.innerHTML = `<div class="pp-head">${scope ? `Best person for ${esc(scope)}` : 'Best match'}</div>
      ${personCardHtml(top, r.parsed)}
      ${strong.length ? `<div class="pp-head">Also</div>${strong.map(x => `<button class="pp-row" data-pick="${esc(x.person.name)}"><b>${esc(x.person.name)}</b><span>${esc(x.why.join('; '))}</span></button>`).join('')}` : ''}
      ${weak.length ? `<div class="pp-head">Others${r.parsed.projectName ? ` on ${esc(r.parsed.projectName)}` : ''}</div>${weak.map(x => `<button class="pp-row" data-pick="${esc(x.person.name)}"><b>${esc(x.person.name)}</b><span>${esc([x.person.title, x.person.company].filter(Boolean).join(', '))}</span></button>`).join('')}` : ''}`;
    // in the office, walk the camera over to that desk and pin the name above the agent
    const role = r.parsed.roles[0] || (top.person.roles || [])[0];
    const pid = r.parsed.projectId || (top.person.projects || []).find(x => x !== '*') || (top.tickets[0] || {}).projectId;
    if (route().view === 'office' && office && office.focus && pid && role) {
      ui.card = { kind: 'person', pid, role };
      if (!ui.cardEl) ui.cardEl = document.createElement('div');
      ui.cardEl.innerHTML = `<div class="ac name-tag" style="--rc:${roleOf(role).color}"><header><span class="avatar sm">${esc(roleOf(role).short)}</span><div class="ac-who"><span>Ask about ${esc(roleOf(role).name.toLowerCase())} on ${esc((projOf(pid) || {}).name || pid)}</span><b class="big">${esc(top.person.name)}</b><span>${esc(top.person.company || '')}${top.person.contractor ? ' · contractor' : ''}</span></div><button class="icon-btn" data-card-close aria-label="Close">✕</button></header></div>`;
      office.focus(pid, role, { zoom: 2.2 });
      office.attachCard(ui.cardEl, pid, role);
    }
  }
  pop.hidden = false;
}

function pickPerson(name) {
  if (!lastSearch) return;
  const i = lastSearch.results.findIndex(x => x.person.name === name);
  if (i > 0) lastSearch.results.unshift(...lastSearch.results.splice(i, 1));
  const top = lastSearch.results[0];
  const pop = $('#peoplePop');
  pop.innerHTML = `<div class="pp-head">${esc(top.person.name)}</div>${personCardHtml(top, lastSearch.parsed)}`;
}

function showPerson(name, pid, role) {
  const p = personByName(name);
  if (!p) return;
  lastSearch = { parsed: { projectId: pid, roles: [role] }, results: [{ person: p, why: [`${roleOf(role).name} contact for ${(projOf(pid) || {}).name || pid}`], tickets: [] }] };
  $('#peopleQ').value = '';
  $('#peoplePop').innerHTML = `<div class="pp-head">Ask a person</div>${personCardHtml(lastSearch.results[0], lastSearch.parsed)}`;
  $('#peoplePop').hidden = false;
}

/* ---------- assign a ticket to a person (writes to monday.com) ---------- */

function openPersonAssign(name, projectId, role) {
  const person = personByName(name);
  const dlg = $('#assignDlg');
  const projects = S.projects.filter(p => !person || person.projects.includes('*') || person.projects.includes(p.id) || !person.projects.length);
  const pid = projectId || (projects[0] || S.projects[0]).id;
  dlg.innerHTML = `<form method="dialog" id="personForm">
    <div class="m-head"><h2>Assign a ticket to ${esc(name)}</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      <div class="field"><label>Project board</label><select name="projectId">${(projects.length ? projects : S.projects).map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="mode-pick">
        <label><input type="radio" name="kind" value="existing" checked><b>An existing ticket</b><span>Add ${esc(name.split(' ')[0])} to a ticket on the board.</span></label>
        <label><input type="radio" name="kind" value="new"><b>A new ticket</b><span>Create it on the board, assigned to ${esc(name.split(' ')[0])}.</span></label>
      </div>
      <div class="field" id="pfExisting"><label>Ticket</label><select name="itemId"></select></div>
      <div id="pfNew" hidden>
        <div class="field"><label>Ticket name</label><input type="text" name="name" maxlength="250" placeholder="e.g. Explain the reservation locking in Program.cs"></div>
        <div class="field"><label>Description <span style="font-weight:400;color:var(--faint)">(optional)</span></label><textarea name="description" rows="3"></textarea></div>
        <div class="field"><label>Crew role</label><select name="role"><option value="">None</option>${S.roles.map(r => `<option value="${r.id}" ${r.id === role ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      </div>
      <p class="hint" id="pfNote"></p>
    </div>
    <div class="m-foot"><span></span><div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" id="pfSubmit">Assign</button></div></div>
  </form>`;
  const form = $('#personForm');
  const F = form.elements;
  const fill = () => {
    const b = boardOf(F.projectId.value);
    const items = b ? b.items.filter(i => !isDone(i.status)) : [];
    items.sort((x, y) => (y.roles.includes(role) ? 1 : 0) - (x.roles.includes(role) ? 1 : 0));
    F.itemId.innerHTML = items.map(i => `<option value="${esc(i.id)}">${esc(i.name)} — ${esc(i.status || 'no status')}${i.people.length ? ` (${esc(i.people.join(', '))})` : ''}</option>`).join('') || '<option value="">No open tickets</option>';
    $('#pfNote').textContent = b && b.demo
      ? 'This is a demo board: the change stays in Dev Crew. Connect monday.com in the config to update your real board.'
      : `This updates the ticket on monday.com${b ? ` (${b.boardName})` : ''}.`;
  };
  const kind = () => {
    const isNew = F.kind.value === 'new';
    $('#pfExisting').hidden = isNew;
    $('#pfNew').hidden = !isNew;
    F.name.required = isNew;
  };
  F.projectId.addEventListener('change', fill);
  form.querySelectorAll('input[name=kind]').forEach(i => i.addEventListener('change', kind));
  form.addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const btn = $('#pfSubmit');
    btn.disabled = true;
    try {
      const isNew = F.kind.value === 'new';
      const body = isNew
        ? { projectId: F.projectId.value, person: name, name: F.name.value, description: F.description.value, role: F.role.value }
        : { projectId: F.projectId.value, person: name, itemId: F.itemId.value };
      if (!isNew && !body.itemId) throw new Error('There is no open ticket to pick. Create a new one instead.');
      const r = await api(isNew ? '/api/monday/create' : '/api/monday/assign', { method: 'POST', body });
      toast(`${isNew ? 'Created' : 'Assigned'} “${r.item ? r.item.name : body.name}” for ${name}${r.demo ? ' (demo board)' : ' on monday.com'}`);
      dlg.close();
      await load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  fill();
  kind();
  dlg.showModal();
}

/* ---------------- Today ---------------- */

function todayView() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const review = S.tasks.filter(needsReview);
  const failed = S.tasks.filter(t => t.status === 'failed' && Date.now() - (t.endedAt || t.createdAt) < 3 * 864e5);
  const todays = S.tasks.filter(t => isToday(t.createdAt) || t.status === 'running' || t.status === 'queued');

  const cards = S.projects.map(p => {
    const ts = tasksOf(p.id);
    const rep = latestReport(p.id);
    const runningRep = S.reports.find(r => r.projectId === p.id && (r.status === 'running' || r.status === 'queued'));
    const busy = new Set(ts.filter(t => t.status === 'running').map(t => t.role));
    const headline = rep ? (/##\s*Headline\s*\n+([^\n#][^\n]*)/i.exec(rep.markdown || '') || [])[1] || rep.healthReason : '';
    return `<div class="card proj-card">
      <div class="top"><h3><a href="#/p/${p.id}">${esc(p.name)}</a></h3>${healthPill(rep)}</div>
      <div class="stack">${esc(p.stack || '')}</div>
      <div class="headline ${headline ? '' : 'none'}">${runningRep ? 'Writing today\'s stand-up…' : headline ? inline(headline) + `<div style="color:var(--faint);font-size:11.5px;margin-top:4px">${rep.date} stand-up</div>` : 'No stand-up yet. Run one to get the crew\'s view.'}</div>
      <div class="stats">
        <div><b>${ts.filter(t => t.status === 'running').length}</b>working</div>
        <div><b>${ts.filter(t => t.status === 'queued').length}</b>queued</div>
        <div><b>${ts.filter(needsReview).length}</b>to review</div>
        <div><b>${ts.filter(t => t.status === 'done' && isToday(t.endedAt)).length}</b>done today</div>
      </div>
      <div class="crew-strip">${S.roles.map(r => roleChip(r.id, busy.has(r.id) ? 'busy' : 'idle')).join('')}</div>
      <div class="card-actions">
        <button class="btn sm" data-act="assign" data-project="${p.id}">Assign</button>
        <a class="btn sm ghost" href="#/p/${p.id}/standups">Stand-ups</a>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-head">
      <div><h1>${greet}</h1><div class="sub">${dateStr} · ${S.projects.length} projects · ${S.roles.length} roles each</div></div>
    </div>
    ${problemsNotice()}
    <div class="proj-grid">${cards}</div>
    ${review.length ? `<div class="section-title">Ready for your review (${review.length})</div><div class="card list">${review.map(t => taskRow(t, true)).join('')}</div>` : ''}
    ${failed.length ? `<div class="section-title">Failed (${failed.length})</div><div class="card list">${failed.map(t => taskRow(t, true)).join('')}</div>` : ''}
    <div class="section-title">Today's work</div>
    <div class="card list">${todays.length ? todays.map(t => taskRow(t, true)).join('') : '<div class="empty">Nothing assigned today. Press <b>+ Assign task</b>.</div>'}</div>`;
}

function taskRow(t, showProject) {
  const p = projOf(t.projectId);
  const where = t.mode === 'change' ? (t.branch || `${t.repo} · new branch`) : `${t.repo === '*' ? 'whole project' : t.repo} · read-only`;
  const live = t.status === 'running' && activity[t.id] ? ` — ${activity[t.id]}` : '';
  return `<div class="row" data-task="${t.id}">
    <div>${roleChip(t.role)}</div>
    <div style="min-width:0">
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${showProject && p ? esc(p.name) + ' · ' : ''}${esc(where)}${esc(live)}</div>
    </div>
    ${statusPill(t)}
    <div class="when">${ago(t.endedAt || t.startedAt || t.createdAt)}</div>
  </div>`;
}

/* ---------------- Project ---------------- */

function projectView(p, tab) {
  const tabs = [['crew', 'Crew'], ['tasks', 'Tasks'], ['standups', 'Stand-ups']];
  const body = tab === 'tasks' ? tasksTab(p) : tab === 'standups' ? standupsTab(p) : crewTab(p);
  return `
    <div class="page-head">
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="sub">${esc(p.stack)}${p.context ? ' — ' + esc(p.context) : ''}</div>
        <div class="repo-chips">${p.exists
          ? (p.repos.map(r => `<span class="repo-chip" title="${esc(r.path)}">${esc(r.name)}</span>`).join('') || '<span class="repo-chip missing">no git repos in folder</span>')
          : `<span class="repo-chip missing" title="${esc(p.path)}">folder not found</span>`}</div>
      </div>
      <div class="card-actions">
        <button class="btn" data-act="standup" data-project="${p.id}">Run stand-up</button>
        <button class="btn primary" data-act="assign" data-project="${p.id}">+ Assign</button>
      </div>
    </div>
    ${p.exists ? '' : problemsNotice()}
    <nav class="tabs">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? 'active' : ''}" href="#/p/${p.id}/${k}">${l}</a>`).join('')}</nav>
    ${body}`;
}

function crewTab(p) {
  const ts = tasksOf(p.id);
  return `<div class="crew-grid">${S.roles.map(r => {
    const mine = ts.filter(t => t.role === r.id);
    const run = mine.find(t => t.status === 'running');
    const queued = mine.filter(t => t.status === 'queued').length;
    const last = mine.find(t => t.status !== 'running' && t.status !== 'queued');
    const repo = (p.roles[r.id] || {}).repo;
    const status = run
      ? `<div class="status working"><b>Working:</b> <a href="#" data-task="${run.id}">${esc(run.title)}</a><div class="act">${esc(activity[run.id] || 'starting…')}</div></div>`
      : `<div class="status">${queued ? `${queued} task(s) queued` : 'Idle'}</div>`;
    return `<div class="card agent" style="--rc:${r.color}">
      <div class="who"><div class="avatar">${esc(r.short)}</div><div><h3>${esc(r.name)}</h3><div class="focus">${esc(r.focus)}</div></div></div>
      ${status}
      ${(((S.contacts || {})[p.id] || {})[r.id] || []).length ? `<div class="last">Ask: ${((S.contacts[p.id] || {})[r.id]).map(n => `<a href="#" data-person="${esc(n)}" data-project="${p.id}" data-role="${r.id}">${esc(n)}</a>`).join(', ')}</div>` : ''}
      <div class="last">${last ? `Last: <a href="#" data-task="${last.id}">${esc(last.title)}</a> · ${statusPill(last)} · ${ago(last.endedAt)}` : 'No tasks yet.'}${repo ? `<br>Usually works in <code>${esc(repo)}</code>` : ''}</div>
      <div class="card-actions">
        <button class="btn sm" data-act="assign" data-project="${p.id}" data-role="${r.id}">Assign</button>
        <a class="btn sm ghost" href="#/p/${p.id}/tasks" data-rolefilter="${r.id}">History (${mine.length})</a>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function tasksTab(p) {
  const f = ui.taskFilter;
  const filters = [['all', 'All'], ['active', 'Active'], ['review', 'To review'], ['done', 'Done'], ['failed', 'Failed']];
  let ts = tasksOf(p.id);
  if (ui.roleFilter) ts = ts.filter(t => t.role === ui.roleFilter);
  ts = ts.filter(t => f === 'all' || (f === 'active' && (t.status === 'running' || t.status === 'queued')) || (f === 'review' && needsReview(t))
    || (f === 'done' && t.status === 'done') || (f === 'failed' && (t.status === 'failed' || t.status === 'cancelled')));
  return `<div class="filters">
      ${filters.map(([k, l]) => `<button class="chip-btn ${f === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}
      <span style="width:12px"></span>
      <button class="chip-btn ${!ui.roleFilter ? 'on' : ''}" data-role-filter="">All roles</button>
      ${S.roles.map(r => `<button class="chip-btn ${ui.roleFilter === r.id ? 'on' : ''}" data-role-filter="${r.id}">${esc(r.short)}</button>`).join('')}
    </div>
    <div class="card list">${ts.length ? ts.map(t => taskRow(t, false)).join('') : '<div class="empty">No tasks match.</div>'}</div>`;
}

function standupsTab(p) {
  const reps = S.reports.filter(r => r.projectId === p.id);
  if (!reps.length) return `<div class="card empty">No stand-ups yet. They run ${S.settings.dailyReport.enabled ? `every ${S.settings.dailyReport.weekdaysOnly ? 'weekday' : 'day'} at ${esc(S.settings.dailyReport.at)}` : 'when you press Run stand-up'}.</div>`;
  return reps.slice(0, 30).map((r, i) => {
    const head = `<div class="report-head">
      <h3>${esc(r.date)}</h3>
      ${r.status === 'done' ? healthPill(r) : r.status === 'failed' ? '<span class="pill red">Failed</span>' : r.status === 'cancelled' ? '<span class="pill">Cancelled</span>' : '<span class="pill blue">Writing…</span>'}
      <span class="grow" style="color:var(--muted);font-size:12.5px">${esc(r.healthReason || '')}</span>
      <span style="color:var(--faint);font-size:12px">${r.trigger === 'scheduled' ? 'scheduled' : 'on demand'} · ${ago(r.endedAt || r.createdAt)}${r.costUsd ? ' · ' + money(r.costUsd) : ''}</span>
      ${r.status === 'running' || r.status === 'queued' ? `<button class="btn sm" data-report="${r.id}">Progress</button>` : ''}
    </div>`;
    if (r.status !== 'done') return `<div class="card report">${head}${r.error ? `<div class="err-box">${esc(r.error)}</div>` : ''}</div>`;
    const sugg = (r.suggestions || []).map((s, j) => `<div class="suggest-item">
        ${roleChip(s.role)}
        <div class="grow"><div>${esc(s.title)}</div><div class="d">${s.mode === 'analyze' ? 'Investigate' : 'Change'} · ${esc(s.repo === '*' ? 'whole project' : s.repo)}${s.details ? ' — ' + esc(s.details) : ''}</div></div>
        <button class="btn sm" data-suggest="${r.id}:${j}">Assign…</button>
      </div>`).join('');
    const content = `${md(r.markdown)}${sugg ? `<div class="suggest"><div class="report-head"><b class="grow">Suggested tasks for tomorrow</b><button class="btn sm primary" data-suggest-all="${r.id}">Assign all</button></div>${sugg}</div>` : ''}`;
    return `<div class="card report">${head}${i === 0 ? content : `<details><summary>Show stand-up</summary>${content}</details>`}</div>`;
  }).join('');
}

/* ---------------- drawer ---------------- */

function openDrawer(kind, id) {
  drawer = { kind, id };
  const el = $('#drawer');
  el.innerHTML = `<div class="d-head" id="dHead"></div>
    <div class="d-body"><div id="dInfo"></div>
      <div class="d-section"><h4>Activity <button class="btn sm ghost" id="logBottom">Latest ↓</button></h4><div class="log" id="dLog"></div></div>
    </div>
    <div class="d-foot" id="dFoot"></div>`;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('show');
  refreshDrawer(true);
  api(`/api/log/${id}`).then(lines => { $('#dLog').innerHTML = ''; appendLog(lines, true); }).catch(() => {});
}

function closeDrawer() {
  drawer = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('show');
}

function appendLog(lines, force) {
  const box = $('#dLog');
  if (!box) return;
  const atBottom = force || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.insertAdjacentHTML('beforeend', lines.map(l => `<div class="l ${l.kind}">${esc(l.text)}</div>`).join(''));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function refreshDrawer(first) {
  if (!drawer) return;
  if (drawer.kind === 'report') return refreshReportDrawer();
  const t = S.tasks.find(x => x.id === drawer.id);
  if (!t) return closeDrawer();
  const p = projOf(t.projectId);
  const r = roleOf(t.role);
  const repo = p && p.repos.find(x => x.name === t.repo);
  $('#dHead').innerHTML = `<div class="line1">${roleChip(t.role)} <span style="color:var(--muted);font-size:12.5px">${esc(r.name)} · ${esc(p ? p.name : t.projectId)}</span><span class="grow"></span>${statusPill(t)}<button class="icon-btn" data-close aria-label="Close">✕</button></div><h2>${esc(t.title)}</h2>`;

  const g = t.git;
  const cmds = repo && t.branch ? [
    ['See the commits', `git -C "${repo.path}" log --oneline ${(t.baseSha || '').slice(0, 10)}..${t.branch}`],
    ['See the diff', `git -C "${repo.path}" diff ${(t.baseSha || '').slice(0, 10)}...${t.branch}`],
    ['When you are happy, push it yourself', `git -C "${repo.path}" push -u origin ${t.branch}`],
  ] : [];
  $('#dInfo').innerHTML = `
    <dl class="kv">
      <dt>Mode</dt><dd>${t.mode === 'change' ? 'Changes code on its own branch' : 'Read-only investigation'}</dd>
      <dt>Repo</dt><dd>${esc(t.repo === '*' ? 'whole project' : t.repo)}${repo ? ` <span style="color:var(--faint)">${esc(repo.path)}</span>` : ''}</dd>
      ${t.branch ? `<dt>Branch</dt><dd><code>${esc(t.branch)}</code> from <code>${esc(t.base)}</code></dd>` : t.base ? `<dt>Base</dt><dd><code>${esc(t.base)}</code></dd>` : ''}
      ${t.worktree ? `<dt>Worktree</dt><dd>${t.cleaned ? '<i>removed (branch kept)</i>' : `<code>${esc(t.worktree)}</code>`}</dd>` : ''}
      <dt>Assigned</dt><dd>${fmtTime(t.createdAt)}${t.endedAt ? ` · finished ${ago(t.endedAt)}` : ''}</dd>
      ${t.turns ? `<dt>Usage</dt><dd>${t.turns} turns${t.costUsd ? ' · ' + money(t.costUsd) : ''}${t.model ? ' · ' + esc(t.model) : ''}</dd>` : ''}
    </dl>
    ${t.details ? `<div class="d-section"><h4>Details</h4><div class="box md">${md(t.details)}</div></div>` : ''}
    ${t.error && t.status !== 'done' ? `<div class="d-section"><div class="err-box">${esc(t.error)}</div></div>` : ''}
    ${g ? `<div class="d-section"><h4>Branch</h4><div class="box">
        <div style="margin-bottom:6px">${g.commits.length} commit(s)${g.shortstat ? ' · ' + esc(g.shortstat) : ''}${g.uncommitted ? ` · <span style="color:var(--amber)">${g.uncommitted} uncommitted file(s) in the worktree</span>` : ''}</div>
        ${g.commits.length ? `<div class="commits">${esc(g.commits.join('\n'))}</div>` : ''}
        ${g.files ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">Files</summary><div class="commits">${esc(g.files)}</div></details>` : ''}
      </div>${cmds.map(([label, c]) => `<div style="font-size:12px;color:var(--faint);margin-top:8px">${label}</div><div class="cmd"><span>${esc(c)}</span><button class="btn sm ghost" data-copy="${esc(c)}">Copy</button></div>`).join('')}</div>` : ''}
    ${t.result ? `<div class="d-section"><h4>Report</h4>${md(t.result)}</div>` : ''}
    ${(t.history || []).length > 1 ? `<div class="d-section"><h4>Earlier turns</h4>${t.history.slice(0, -1).map(h => `<details class="box" style="margin-bottom:6px"><summary style="cursor:pointer">${esc(h.prompt.slice(0, 120))} · ${ago(h.at)}</summary>${md(h.result)}</details>`).join('')}</div>` : ''}`;

  const active = t.status === 'running' || t.status === 'queued';
  const canFollow = !active && !t.cleaned;
  const foot = $('#dFoot');
  const draft = foot.querySelector('textarea') ? foot.querySelector('textarea').value : '';
  foot.innerHTML = `
    ${canFollow ? `<textarea id="followText" rows="2" placeholder="Follow up with the ${esc(r.name)}: ask a question, request changes, or say “continue”…"></textarea>` : ''}
    <div class="acts">
      <div class="card-actions">
        ${active ? '<button class="btn danger" data-task-act="cancel">Cancel</button>' : ''}
        ${!active && t.worktree && !t.cleaned ? '<button class="btn" data-task-act="cleanup" title="Delete the worktree folder; the branch stays in the repo">Remove worktree</button>' : ''}
        ${!active ? '<button class="btn ghost danger" data-task-act="delete">Delete</button>' : ''}
      </div>
      ${canFollow ? '<button class="btn primary" data-task-act="followup">Send follow-up</button>' : ''}
    </div>`;
  const ta = foot.querySelector('textarea');
  if (ta) {
    ta.value = draft;
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) taskAction('followup'); });
  }
  if (first && ta && t.status !== 'failed') ta.blur();
}

function refreshReportDrawer() {
  const r = S.reports.find(x => x.id === drawer.id);
  if (!r) return closeDrawer();
  const p = projOf(r.projectId);
  $('#dHead').innerHTML = `<div class="line1"><span style="color:var(--muted);font-size:12.5px">Stand-up · ${esc(p ? p.name : r.projectId)}</span><span class="grow"></span><span class="pill ${r.status === 'failed' ? 'red' : 'blue'}">${esc(r.status)}</span><button class="icon-btn" data-close aria-label="Close">✕</button></div><h2>${esc(r.date)}</h2>`;
  $('#dInfo').innerHTML = r.error ? `<div class="err-box">${esc(r.error)}</div>` : r.status === 'done' ? '<p>Done. It is on the Stand-ups tab.</p>' : '';
  $('#dFoot').innerHTML = r.status === 'running' || r.status === 'queued' ? '<div class="acts"><button class="btn danger" data-report-cancel>Cancel</button></div>' : '';
}

async function taskAction(act) {
  const id = drawer && drawer.id;
  if (!id) return;
  try {
    if (act === 'followup') {
      const text = ($('#followText') || {}).value || '';
      if (!text.trim()) return toast('Write the follow-up first', true);
      await api(`/api/tasks/${id}/followup`, { method: 'POST', body: { text } });
      $('#followText').value = '';
      toast('Sent — the agent picks it up next');
    } else if (act === 'cancel') {
      await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
    } else if (act === 'cleanup') {
      await api(`/api/tasks/${id}/cleanup`, { method: 'POST' });
      toast('Worktree removed; the branch is still in the repo');
    } else if (act === 'delete') {
      const t = S.tasks.find(x => x.id === id);
      if (!confirm(`Delete "${t.title}"?${t.worktree && !t.cleaned ? '\nIts worktree folder is removed too; the branch stays in the repo.' : ''}`)) return;
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      closeDrawer();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- assign dialog ---------------- */

function openAssign(pre = {}) {
  const dlg = $('#assignDlg');
  const r0 = route();
  const projectId = pre.projectId || (r0.view === 'project' ? r0.id : (S.projects[0] || {}).id);
  const role = pre.role || 'backend';
  const mode = pre.mode || roleOf(role).defaultMode || 'change';
  dlg.innerHTML = `<form method="dialog" id="assignForm">
    <div class="m-head"><h2>Assign a task</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      <div class="field"><label>Project</label>
        <select name="projectId">${S.projects.map(p => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Who</label>
        <div class="role-pick">${S.roles.map(r => `<label style="--rc:${r.color}"><input type="radio" name="role" value="${r.id}" ${r.id === role ? 'checked' : ''}><span class="sw"></span>${esc(r.name)}</label>`).join('')}</div></div>
      <div class="field"><label>Kind of task</label>
        <div class="mode-pick">
          <label><input type="radio" name="mode" value="change" ${mode === 'change' ? 'checked' : ''}><b>Make changes</b><span>Works on its own new branch and commits. Never pushes.</span></label>
          <label><input type="radio" name="mode" value="analyze" ${mode === 'analyze' ? 'checked' : ''}><b>Investigate &amp; report</b><span>Read-only: review, plan, audit, explain.</span></label>
        </div></div>
      <div class="grid2">
        <div class="field"><label>Repo</label><select name="repo"></select></div>
        <div class="field" id="baseField"><label>Start from branch</label><select name="base"></select></div>
      </div>
      ${pre.ticketId ? `<div class="linked">Linked to the monday.com ticket <b>${esc(pre.ticketName || '')}</b>. The agent reads the ticket and its latest updates.<input type="hidden" name="ticketId" value="${esc(pre.ticketId)}"></div>` : ''}
      <div class="field"><label>Task</label><input type="text" name="title" maxlength="200" required placeholder="e.g. Add pagination to GET /invoices" value="${esc(pre.title || '')}"></div>
      <div class="field"><label>Details <span style="font-weight:400;color:var(--faint)">(optional)</span></label>
        <textarea name="details" rows="4" placeholder="Acceptance criteria, ticket text, links, constraints…">${esc(pre.details || '')}</textarea></div>
      <div class="field"><label>Model</label>
        <select name="model"><option value="">Default (${esc(S.settings.model)})</option><option value="sonnet">Sonnet</option><option value="opus">Opus — hardest tasks</option><option value="haiku">Haiku — quick, cheap</option></select></div>
    </div>
    <div class="m-foot">
      <label class="check"><input type="checkbox" name="more"> Keep open to assign another</label>
      <div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" id="assignSubmit">Assign</button></div>
    </div>
  </form>`;
  const form = $('#assignForm');
  const F = form.elements;
  let modeTouched = !!pre.mode;
  const fillRepos = () => {
    const p = projOf(F.projectId.value);
    const roleRepo = (p.roles[F.role.value] || {}).repo;
    const want = pre.repo && pre.repo !== '*' ? pre.repo : roleRepo;
    const analyze = F.mode.value === 'analyze';
    const opts = p.repos.map(r => `<option value="${esc(r.name)}" ${r.name === want ? 'selected' : ''}>${esc(r.name)}</option>`);
    if (analyze) opts.unshift(`<option value="*" ${pre.repo === '*' || !want ? 'selected' : ''}>Whole project (all repos)</option>`);
    F.repo.innerHTML = opts.join('') || '<option value="">No repos found</option>';
    $('#baseField').style.display = analyze ? 'none' : '';
    fillBranches();
  };
  const fillBranches = async () => {
    const p = projOf(F.projectId.value);
    const repo = F.repo.value;
    F.base.innerHTML = '<option value="">Current branch</option>';
    if (!repo || repo === '*') return;
    try {
      const b = await api(`/api/branches?project=${encodeURIComponent(p.id)}&repo=${encodeURIComponent(repo)}`);
      F.base.innerHTML = b.branches.filter(x => !x.startsWith('agent/')).map(x => `<option value="${esc(x)}" ${x === b.current ? 'selected' : ''}>${esc(x)}${x === b.current ? ' (checked out)' : ''}</option>`).join('')
        || '<option value="">Current branch</option>';
    } catch { /* keep the default */ }
  };
  F.projectId.addEventListener('change', () => { pre = {}; fillRepos(); });
  F.repo.addEventListener('change', fillBranches);
  form.querySelectorAll('input[name=mode]').forEach(i => i.addEventListener('change', () => { modeTouched = true; fillRepos(); }));
  form.querySelectorAll('input[name=role]').forEach(i => i.addEventListener('change', () => {
    if (!modeTouched) form.querySelector(`input[name=mode][value=${roleOf(F.role.value).defaultMode}]`).checked = true;
    fillRepos();
  }));
  form.addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const btn = $('#assignSubmit');
    btn.disabled = true;
    try {
      await api('/api/tasks', { method: 'POST', body });
      toast(`Assigned to ${roleOf(body.role).name}`);
      if (F.more.checked) { F.title.value = ''; F.details.value = ''; F.title.focus(); }
      else dlg.close();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  fillRepos();
  dlg.showModal();
  F.title.focus();
}

/* ---------------- events ---------------- */

document.addEventListener('click', async e => {
  const ob = e.target.closest('[data-office]');
  if (ob && office && office.zoomBy) {
    const a = ob.dataset.office;
    if (a === 'in') office.zoomBy(1.25); else if (a === 'out') office.zoomBy(0.8); else office.fit();
    return;
  }
  const pe = e.target.closest('[data-card-close],[data-ticket-work],[data-ticket-post],[data-person],[data-person-assign],[data-pick]');
  if (pe) {
    const d = pe.dataset;
    if (d.cardClose !== undefined) return closeAgentCard();
    if (d.pick) return pickPerson(d.pick);
    if (d.person) { e.preventDefault(); return showPerson(d.person, d.project || (ui.card && ui.card.pid), d.role || (ui.card && ui.card.role)); }
    if (d.personAssign) { $('#peoplePop').hidden = true; return openPersonAssign(d.personAssign, d.project, d.role); }
    if (d.ticketWork && ui.card) {
      const it = (boardOf(ui.card.pid) || { items: [] }).items.find(i => i.id === d.ticketWork);
      if (it) openAssign({ projectId: ui.card.pid, role: ui.card.role, title: it.name, ticketId: it.id, ticketName: it.name });
      return;
    }
    if (d.ticketPost) {
      const t = S.tasks.find(x => x.id === d.ticketPost);
      const b = boardOf(t.projectId);
      if (!confirm(`Post the ${roleOf(t.role).name}'s report as an update on “${t.ticket.name}”${b && !b.demo ? ' on monday.com' : ' (demo board)'}?`)) return;
      try { await api(`/api/tasks/${t.id}/monday-update`, { method: 'POST' }); toast('Report posted to the ticket'); } catch (err) { toast(err.message, true); }
      return;
    }
  }
  const el = e.target.closest('[data-act],[data-task],[data-report],[data-filter],[data-role-filter],[data-rolefilter],[data-close],[data-copy],[data-task-act],[data-report-cancel],[data-suggest],[data-suggest-all],#logBottom');
  if (!el) {
    if (e.target.closest('.nav-item')) $('#sidebar').classList.remove('open');
    return;
  }
  const d = el.dataset;
  if (d.task && !d.taskAct) { e.preventDefault(); return openDrawer('task', d.task); }
  if (d.report) return openDrawer('report', d.report);
  if (d.close !== undefined) return closeDrawer();
  if (d.copy) return copy(d.copy);
  if (d.taskAct) return taskAction(d.taskAct);
  if (el.id === 'logBottom') { const b = $('#dLog'); b.scrollTop = b.scrollHeight; return; }
  if (d.reportCancel !== undefined) return api(`/api/reports/${drawer.id}/cancel`, { method: 'POST' }).catch(err => toast(err.message, true));
  if (d.filter) { ui.taskFilter = d.filter; return render(); }
  if (d.roleFilter !== undefined) { ui.roleFilter = d.roleFilter; return render(); }
  if (d.rolefilter) { ui.roleFilter = d.rolefilter; ui.taskFilter = 'all'; return; }
  if (d.act === 'assign') return openAssign({ projectId: d.project, role: d.role });
  if (d.act === 'standup') {
    try {
      const made = await api('/api/reports/run', { method: 'POST', body: { projectId: d.project } });
      toast(made.length ? 'Stand-up queued' : 'A stand-up is already running');
      location.hash = `#/p/${d.project}/standups`;
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (d.suggest) {
    const [rid, j] = d.suggest.split(':');
    const r = S.reports.find(x => x.id === rid);
    const s = r.suggestions[+j];
    return openAssign({ projectId: r.projectId, ...s });
  }
  if (d.suggestAll) {
    const r = S.reports.find(x => x.id === d.suggestAll);
    if (!confirm(`Assign all ${r.suggestions.length} suggested tasks for ${projOf(r.projectId).name}?`)) return;
    let ok = 0;
    for (const s of r.suggestions) {
      try { await api('/api/tasks', { method: 'POST', body: { projectId: r.projectId, ...s } }); ok++; }
      catch (err) { toast(`${s.title}: ${err.message}`, true); }
    }
    if (ok) toast(`Assigned ${ok} task(s)`);
  }
});

$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('pointerdown', e => {
  const pop = $('#peoplePop');
  if (!pop.hidden && !e.target.closest('#peoplePop,#peopleQ,#assignDlg')) pop.hidden = true;
});
$('#peopleQ').addEventListener('input', e => { clearTimeout(searchTimer); const q = e.target.value; searchTimer = setTimeout(() => runSearch(q), 350); });
$('#peopleQ').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); }
  if (e.key === 'Escape') { $('#peoplePop').hidden = true; e.target.blur(); }
});
$('#peopleQ').addEventListener('focus', () => { if (lastSearch && $('#peopleQ').value) $('#peoplePop').hidden = false; });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#peopleQ').focus(); $('#peopleQ').select(); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('#assignDlg').open) return;
  if (drawer) closeDrawer(); else if (ui.card) closeAgentCard();
});
$('#assignBtn').addEventListener('click', () => openAssign());
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#standupAllBtn').addEventListener('click', async () => {
  if (!confirm(`Write a stand-up for all ${S.projects.length} projects now? Each one is a Claude run.`)) return;
  try {
    const made = await api('/api/reports/run', { method: 'POST', body: {} });
    toast(`${made.length} stand-up(s) queued`);
  } catch (err) { toast(err.message, true); }
});

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('devcrew-theme', t || ''); } catch { /* private mode */ }
}
try { setTheme(localStorage.getItem('devcrew-theme') || ''); } catch { /* ignore */ }
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(dark ? 'light' : 'dark');
});

window.addEventListener('hashchange', () => { closeDrawer(); render(); window.scrollTo(0, 0); $('#sidebar').classList.remove('open'); });
setInterval(() => { if (S) schedule(); }, 30000); // keep "5m ago" honest

load().then(connect).catch(e => {
  $('#main').innerHTML = `<div class="notice"><b>Could not reach the Dev Crew server.</b> ${esc(e.message)}</div>`;
});
