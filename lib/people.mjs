// "Who should I ask?" — the people (staff and contractors) behind each project and role.
// Two sources: the `people` list in the config, and whoever is assigned to tickets on the
// project's monday.com board for that role. Queries are plain English, parsed locally:
//   "who do I ask backend questions in inventory service"  → project inventory, role backend
import { ROLES } from './roles.mjs';
import { rolesFromText } from './monday.mjs';

const STOP = new Set(('who whom whose is are the a an to for of in on at about with and or i me my we our should can could would ' +
  'ask asking question questions right person people contact talk speak go handles handle owns own owner responsible ' +
  'help needs need know knows best service project team guy girl someone anybody anyone').split(' '));

const words = s => String(s || '').toLowerCase().split(/[^a-z0-9#+.]+/).filter(Boolean);

export function parseQuery(q, projects) {
  const text = String(q || '').toLowerCase();
  const toks = words(text);
  // project: the one whose name/id/folder words appear most in the query
  let project = null;
  let best = 0;
  for (const p of projects) {
    const keys = new Set([p.id, ...words(p.name)].filter(w => w.length > 2 && !STOP.has(w)));
    const hits = [...keys].filter(k => toks.includes(k) || text.includes(k)).length;
    if (hits > best) { best = hits; project = p; }
  }
  // roles: any alias phrase in the query
  const roles = new Set(rolesFromText(text.replace(/\b(and|or)\b/g, ',')));
  for (const t of toks) for (const r of rolesFromText(t)) roles.add(r);
  for (const [phrase, r] of [['front end', 'frontend'], ['back end', 'backend'], ['data base', 'database'], ['ci/cd', 'devops'], ['pipeline', 'devops'], ['deploy', 'devops'], ['migration', 'database'], ['schema', 'database'], ['design', 'architect'], ['test', 'qa']]) {
    if (text.includes(phrase)) roles.add(r);
  }
  const projectWords = project ? new Set([project.id, ...words(project.name)]) : new Set();
  const terms = toks.filter(t => t.length > 1 && !STOP.has(t) && !projectWords.has(t) && !rolesFromText(t).length);
  return { projectId: project ? project.id : '', roles: [...roles], terms };
}

/** Everyone we know about, with where they come from. */
export function directory(config, mondaySnapshot) {
  const people = new Map();
  const key = n => String(n || '').trim().toLowerCase();
  for (const raw of config.people || []) {
    if (!raw || !raw.name) continue;
    people.set(key(raw.name), {
      name: String(raw.name),
      company: String(raw.company || ''),
      contractor: !!raw.contractor || /contract/i.test(raw.company || ''),
      title: String(raw.title || ''),
      email: String(raw.email || ''),
      teams: String(raw.teams || ''),
      phone: String(raw.phone || ''),
      hours: String(raw.hours || ''),
      notes: String(raw.notes || ''),
      projects: (raw.projects || ['*']).map(String),
      roles: (raw.roles || []).flatMap(r => rolesFromText(r)),
      skills: (raw.skills || []).map(String),
      tickets: [],
    });
  }
  // monday: people assigned to tickets, per project and role
  for (const [pid, board] of Object.entries((mondaySnapshot && mondaySnapshot.boards) || {})) {
    for (const it of board.items || []) {
      for (const n of it.people || []) {
        let person = people.get(key(n));
        if (!person) {
          person = { name: n, company: '', contractor: false, title: '', email: '', teams: '', phone: '', hours: '', notes: '', projects: [], roles: [], skills: [], tickets: [], fromBoard: true };
          people.set(key(n), person);
        }
        person.tickets.push({ projectId: pid, itemId: it.id, name: it.name, status: it.status, roles: it.roles, url: it.url });
      }
    }
  }
  return [...people.values()];
}

export function search(q, config, mondaySnapshot) {
  const parsed = parseQuery(q, config.projects);
  const all = directory(config, mondaySnapshot);
  const pname = id => (config.projects.find(p => p.id === id) || {}).name || id;
  const rname = id => (ROLES.find(r => r.id === id) || {}).name || id;
  const results = [];
  for (const p of all) {
    let score = 0;
    const why = [];
    const inProject = parsed.projectId && (p.projects.includes(parsed.projectId) || p.tickets.some(t => t.projectId === parsed.projectId));
    const everywhere = p.projects.includes('*');
    if (parsed.projectId) {
      if (inProject) { score += 6; } else if (everywhere) { score += 2; } else continue;
    }
    const roleHits = parsed.roles.filter(r => p.roles.includes(r));
    if (parsed.roles.length && roleHits.length) { score += 6 * roleHits.length; }
    const tix = p.tickets.filter(t => (!parsed.projectId || t.projectId === parsed.projectId) && (!parsed.roles.length || t.roles.some(r => parsed.roles.includes(r))));
    if (tix.length) score += Math.min(6, tix.length * 2);
    const hay = [p.name, p.company, p.title, p.notes, ...p.skills].join(' ').toLowerCase();
    const termHits = parsed.terms.filter(t => hay.includes(t));
    score += termHits.length * 3;
    if (parsed.roles.length && !roleHits.length && !tix.length) score -= 4;
    if (!parsed.projectId && !parsed.roles.length && !termHits.length) continue;
    if (score <= 0) continue;

    if (roleHits.length) why.push(`${roleHits.map(rname).join(' and ')}${inProject ? ` on ${pname(parsed.projectId)}` : everywhere ? ' across all projects' : ''}`);
    else if (inProject) why.push(`Works on ${pname(parsed.projectId)}`);
    else if (everywhere && parsed.projectId) why.push('Covers every project');
    if (tix.length) why.push(`${tix.length} matching ticket${tix.length > 1 ? 's' : ''} on the monday board`);
    if (termHits.length) why.push(`Knows ${termHits.join(', ')}`);
    results.push({ person: p, score, why, tickets: tix.slice(0, 4) });
  }
  results.sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name));
  return { query: q, parsed: { ...parsed, projectName: parsed.projectId ? pname(parsed.projectId) : '', roleNames: parsed.roles.map(rname) }, results: results.slice(0, 8) };
}

/** People for one project + role, best first (used on the agent's card). */
export function contactsFor(projectId, roleId, config, mondaySnapshot) {
  return directory(config, mondaySnapshot)
    .map(p => {
      const direct = p.roles.includes(roleId) && (p.projects.includes(projectId) || p.projects.includes('*'));
      const tix = p.tickets.filter(t => t.projectId === projectId && t.roles.includes(roleId)).length;
      return { p, score: (direct ? 10 : 0) + (p.projects.includes(projectId) ? 2 : 0) + tix };
    })
    .filter(x => x.score >= 10 || x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(x => x.p);
}
