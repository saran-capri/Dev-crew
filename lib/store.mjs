// Tasks, reports and per-task logs, kept as JSON files under data/.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  const file = path.join(dir, 'state.json');
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  let state = { tasks: [], reports: [], meta: { lastDaily: '' } };
  if (fs.existsSync(file)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      fs.copyFileSync(file, file + '.broken-' + Date.now());
      console.warn(`data/state.json was unreadable (${e.message}); kept a copy and started fresh.`);
    }
  }

  let timer = null;
  const flush = () => {
    timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 150); };

  const logFile = id => path.join(logDir, `${id.replace(/[^a-z0-9-]/gi, '')}.jsonl`);

  return {
    state,
    save,
    flush: () => { if (timer) { clearTimeout(timer); flush(); } },
    appendLog(id, entry) {
      fs.appendFileSync(logFile(id), JSON.stringify(entry) + '\n');
    },
    readLog(id, limit = 1500) {
      const f = logFile(id);
      if (!fs.existsSync(f)) return [];
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
  };
}

export const newId = (prefix = '') =>
  prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
