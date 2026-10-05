// monday.com boards → each agent's tickets. One board per project; a column on the board (default
// "Agent") says which crew role a ticket belongs to ("Backend", "QA", "DevOps", …).
// Without an API token this serves demo tickets so the office still has something to show.
import { ROLES } from './roles.mjs';
import { demoTickets } from './monday-demo.mjs';

const splitNames = t => String(t || '').split(',').map(x => x.trim()).filter(Boolean);

const API = 'https://api.monday.com/v2';

const ALIASES = {
  architect: ['architect', 'solutions architect', 'arch', 'sa', 'architecture'],
  frontend: ['frontend', 'front end', 'front-end', 'fe', 'ui', 'web'],
  backend: ['backend', 'back end', 'back-end', 'be', 'api', 'server'],
  database: ['database', 'db', 'dba', 'data', 'sql'],
  qa: ['qa', 'test', 'tester', 'testing', 'quality', 'qa / test'],
  devops: ['devops', 'ops', 'cloud', 'infra', 'infrastructure', 'sre', 'platform', 'devops & cloud'],
};

/** "Backend, QA" → ['backend', 'qa'] */
export function rolesFromText(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/[,;/|]+/)) {
    const tok = raw.trim().toLowerCase();
    if (!tok) continue;
    for (const r of ROLES) {
      if (ALIASES[r.id].includes(tok) || tok === r.name.toLowerCase() || tok.includes(r.name.toLowerCase())) out.add(r.id);
    }
  }
  return [...out];
}

const ITEM_FIELDS = 'id name url updated_at group { title } column_values { id type text column { title } }';

export function createMonday(getConfig) {
  const boards = new Map(); // projectId -> { boardName, items, error, fetchedAt, demo }
  const demoPosts = new Map(); // itemId -> [{ at, body }]

  const token = () => process.env.MONDAY_API_TOKEN || ((getConfig().settings.monday || {}).token) || '';
  const connected = () => !!token();

  async function gql(query, variables) {
    const headers = { 'content-type': 'application/json', authorization: token() };
    const v = (getConfig().settings.monday || {}).apiVersion;
    if (v) headers['API-Version'] = v;
    const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors || body.error_message) {
      const msg = (body.errors && body.errors.map(e => e.message).join('; ')) || body.error_message || `HTTP ${res.status}`;
      throw new Error(`monday.com: ${msg}`);
    }
    return body.data;
  }

  function normalise(item, project) {
    const m = project.monday || {};
    const byTitle = {};
    for (const c of item.column_values || []) {
      const title = (c.column && c.column.title) || c.id;
      byTitle[title.toLowerCase()] = c;
    }
    const col = (name, type) => {
      if (name && byTitle[name.toLowerCase()]) return byTitle[name.toLowerCase()].text || '';
      const found = type && (item.column_values || []).find(c => c.type === type);
      return found ? found.text || '' : '';
    };
    const roleText = col(m.roleColumn || 'Agent');
    const peopleCols = m.peopleColumn
      ? [byTitle[m.peopleColumn.toLowerCase()]].filter(Boolean)
      : (item.column_values || []).filter(c => c.type === 'people');
    return {
      id: String(item.id),
      name: item.name,
      url: item.url || '',
      group: item.group ? item.group.title : '',
      status: col(m.statusColumn || 'Status', 'status'),
      priority: col(m.priorityColumn || 'Priority'),
      due: col(m.dueColumn || 'Due date', 'date'),
      roles: rolesFromText(roleText),
      roleText,
      people: [...new Set(peopleCols.flatMap(c => splitNames(c.text)))],
      updatedAt: item.updated_at || '',
    };
  }

  async function fetchBoard(project) {
    const boardId = String(project.monday.boardId);
    const first = await gql(`query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type } items_page(limit: 200) { cursor items { ${ITEM_FIELDS} } } } }`, { ids: [boardId] });
    const board = first.boards && first.boards[0];
    if (!board) throw new Error(`monday.com: board ${boardId} not found, or the token can't see it.`);
    let items = board.items_page.items;
    let cursor = board.items_page.cursor;
    for (let page = 0; cursor && page < 4; page++) {
      const next = await gql(`query ($c: String!) { next_items_page(limit: 200, cursor: $c) { cursor items { ${ITEM_FIELDS} } } }`, { c: cursor });
      items = items.concat(next.next_items_page.items);
      cursor = next.next_items_page.cursor;
    }
    const groups = (project.monday.groups || []).map(g => String(g).toLowerCase());
    return {
      boardName: board.name,
      boardId,
      columns: board.columns || [],
      items: items.map(i => normalise(i, project)).filter(i => !groups.length || groups.includes(i.group.toLowerCase())),
    };
  }

  async function refresh(projectId) {
    const cfg = getConfig();
    for (const p of cfg.projects) {
      if (projectId && p.id !== projectId) continue;
      if (!connected() || !p.monday || !p.monday.boardId) {
        const prev = boards.get(p.id);
        boards.set(p.id, prev && prev.demo ? { ...prev, fetchedAt: Date.now() } : { demo: true, boardName: `${p.name} (demo board)`, items: demoTickets(p, cfg.people || []), error: '', fetchedAt: Date.now() });
        continue;
      }
      try {
        boards.set(p.id, { demo: false, ...(await fetchBoard(p)), error: '', fetchedAt: Date.now() });
      } catch (e) {
        const prev = boards.get(p.id);
        boards.set(p.id, { demo: false, boardName: prev ? prev.boardName : '', items: prev ? prev.items : [], error: e.message, fetchedAt: Date.now() });
      }
    }
    return snapshot();
  }

  function snapshot() {
    return { connected: connected(), boards: Object.fromEntries(boards) };
  }

  function item(projectId, itemId) {
    const b = boards.get(projectId);
    return b ? b.items.find(i => i.id === String(itemId)) : null;
  }

  /** Everything the agent should read about a ticket: its columns and latest updates. */
  async function details(projectId, itemId) {
    const it = item(projectId, itemId);
    if (!it) throw new Error('That ticket is not on the project\'s board (refresh the board and try again).');
    const b = boards.get(projectId);
    if (b.demo) return { ...it, columns: { Status: it.status, Priority: it.priority, 'Due date': it.due, Agent: it.roleText }, updates: it.updates || [] };
    const d = await gql(`query ($ids: [ID!]) { items(ids: $ids) { id name url column_values { text column { title } } updates(limit: 5) { text_body created_at creator { name } } } }`, { ids: [String(itemId)] });
    const full = d.items && d.items[0];
    if (!full) return { ...it, columns: {}, updates: [] };
    const columns = {};
    for (const c of full.column_values || []) if (c.text) columns[(c.column && c.column.title) || ''] = c.text;
    return {
      ...it,
      columns,
      updates: (full.updates || []).map(u => ({ at: u.created_at, by: u.creator ? u.creator.name : '', text: (u.text_body || '').slice(0, 1500) })),
    };
  }

  /** Post a comment (an "update") on the ticket. Only ever called from an explicit button press. */
  async function postUpdate(projectId, itemId, body) {
    const b = boards.get(projectId);
    if (!b || b.demo) {
      const list = demoPosts.get(String(itemId)) || [];
      list.push({ at: Date.now(), body });
      demoPosts.set(String(itemId), list);
      return { demo: true };
    }
    const d = await gql('mutation ($id: ID!, $body: String!) { create_update(item_id: $id, body: $body) { id } }', { id: String(itemId), body });
    return { demo: false, id: d.create_update && d.create_update.id };
  }

  /* ---------- writing: only ever from an explicit button press ---------- */

  function column(b, project, wantTitle, type) {
    const cols = b.columns || [];
    if (wantTitle) {
      const c = cols.find(x => x.title.toLowerCase() === wantTitle.toLowerCase());
      if (c) return c;
    }
    return type ? cols.find(x => x.type === type) : null;
  }

  async function userId(person) {
    if (person.email) {
      const d = await gql('query ($e: [String]) { users(emails: $e) { id name } }', { e: [person.email] });
      if (d.users && d.users[0]) return d.users[0].id;
    }
    const d = await gql('query ($n: String) { users(name: $n) { id name } }', { n: person.name });
    const exact = (d.users || []).find(u => u.name.toLowerCase() === person.name.toLowerCase()) || (d.users || [])[0];
    if (!exact) throw new Error(`${person.name} isn't a user on your monday.com account (add them as a member or guest first).`);
    return exact.id;
  }

  function roleValue(col, label) {
    if (!col) return null;
    if (col.type === 'status') return { label };
    if (col.type === 'dropdown') return { labels: [label] };
    return label;
  }

  /** Put a person on an existing ticket (added to whoever is already on it). */
  async function assign(projectId, itemId, person) {
    const project = getConfig().projects.find(p => p.id === projectId);
    const b = boards.get(projectId);
    const it = item(projectId, itemId);
    if (!project || !b || !it) throw new Error('That ticket is not on the board any more. Refresh and try again.');
    if (b.demo) {
      if (!it.people.includes(person.name)) it.people.push(person.name);
      return { demo: true, item: it };
    }
    const col = column(b, project, (project.monday || {}).peopleColumn, 'people');
    if (!col) throw new Error('The board has no People column to assign someone with.');
    const ids = [await userId(person)];
    const value = { personsAndTeams: ids.map(id => ({ id: Number(id), kind: 'person' })) };
    await gql('mutation ($b: ID!, $i: ID!, $c: String!, $v: JSON!) { change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id } }',
      { b: b.boardId, i: String(itemId), c: col.id, v: JSON.stringify(value) });
    await refresh(projectId);
    return { demo: false, item: item(projectId, itemId) };
  }

  /** Create a new ticket for a person (and a crew role) on the project's board. */
  async function createItem(projectId, { name, description, role, person }) {
    const project = getConfig().projects.find(p => p.id === projectId);
    const b = boards.get(projectId);
    if (!project || !b) throw new Error('Unknown project board.');
    const roleLabel = role ? ({ architect: 'Architect', frontend: 'Frontend', backend: 'Backend', database: 'Database', qa: 'QA', devops: 'DevOps' })[role] : '';
    if (b.demo) {
      const it = {
        id: `demo-${projectId}-n${Date.now().toString(36)}`, name, url: '', group: 'This sprint', status: 'Not started', priority: '',
        due: '', roles: role ? [role] : [], roleText: roleLabel, people: person ? [person.name] : [], updatedAt: new Date().toISOString(),
        updates: description ? [{ at: new Date().toISOString(), by: 'You', text: description }] : [],
      };
      b.items.unshift(it);
      return { demo: true, item: it };
    }
    const m = project.monday || {};
    const values = {};
    const peopleCol = column(b, project, m.peopleColumn, 'people');
    if (person && peopleCol) values[peopleCol.id] = { personsAndTeams: [{ id: Number(await userId(person)), kind: 'person' }] };
    const roleCol = column(b, project, m.roleColumn || 'Agent');
    if (roleLabel && roleCol) values[roleCol.id] = roleValue(roleCol, roleLabel);
    const d = await gql('mutation ($b: ID!, $n: String!, $v: JSON) { create_item(board_id: $b, item_name: $n, column_values: $v, create_labels_if_missing: true) { id } }',
      { b: b.boardId, n: name, v: JSON.stringify(values) });
    const id = d.create_item && d.create_item.id;
    if (id && description) await gql('mutation ($id: ID!, $body: String!) { create_update(item_id: $id, body: $body) { id } }', { id: String(id), body: description });
    await refresh(projectId);
    return { demo: false, item: item(projectId, id) || { id, name } };
  }

  return { refresh, snapshot, item, details, postUpdate, assign, createItem, connected };
}
