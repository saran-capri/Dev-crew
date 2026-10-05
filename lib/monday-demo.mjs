// Demo tickets used until a monday.com token and board are configured, so every agent in the
// office has something on "the board" to talk about.

const TEMPLATES = {
  architect: [
    ['Review service boundaries before the Q4 features', 'Working on it', 'High'],
    ['ADR: caching strategy for read-heavy endpoints', 'Not started', 'Medium'],
  ],
  frontend: [
    ['Loading and error states on the main list view', 'Working on it', 'High'],
    ['List view breaks below 400px wide', 'Stuck', 'Medium'],
  ],
  backend: [
    ['Return 404 for unknown ids instead of an empty 200', 'Done', 'High'],
    ['Rate-limit the public endpoints', 'Not started', 'Medium'],
  ],
  database: [
    ['Index for the slow 30-day revenue query', 'Working on it', 'High'],
    ['Write and test a rollback for the last migration', 'Not started', 'Low'],
  ],
  qa: [
    ['Regression tests for the reported checkout bugs', 'Not started', 'High'],
    ['Find and quarantine the flaky tests', 'Stuck', 'Medium'],
  ],
  devops: [
    ['Run tests on every pull request in the pipeline', 'Working on it', 'High'],
    ['Pin Docker base image versions', 'Not started', 'Low'],
  ],
};

const ROLE_LABEL = { architect: 'Architect', frontend: 'Frontend', backend: 'Backend', database: 'Database', qa: 'QA', devops: 'DevOps' };

export function demoTickets(project, people = []) {
  const who = role => people.filter(p => (p.projects || []).some(x => x === project.id || x === '*') && (p.roles || []).some(r => String(r).toLowerCase().startsWith(role.slice(0, 4)))).map(p => p.name);
  const out = [];
  let n = 100;
  const day = 864e5;
  for (const [role, list] of Object.entries(TEMPLATES)) {
    list.forEach(([name, status, priority], i) => {
      n++;
      const due = new Date(Date.now() + (i * 3 + (n % 4) - 1) * day);
      out.push({
        id: `demo-${project.id}-${n}`,
        name,
        url: '',
        group: status === 'Done' ? 'Done' : 'This sprint',
        status,
        priority,
        due: due.toISOString().slice(0, 10),
        roles: [role],
        roleText: ROLE_LABEL[role],
        people: (w => (w.length ? [w[i % w.length]] : []))(who(role)),
        updatedAt: new Date(Date.now() - (n % 5) * day).toISOString(),
        updates: status === 'Stuck' ? [{ at: new Date().toISOString(), by: 'Team lead', text: 'Blocked until we agree the approach. Can the crew propose one?' }] : [],
      });
    });
  }
  return out;
}
