// `npm run doctor`: checks everything Dev Crew needs on this machine and says what to fix.
import { loadConfig } from '../lib/config.mjs';
import { claudeFeatures } from '../lib/claude.mjs';
import { gitVersion } from '../lib/git.mjs';

const ok = s => console.log(`  ✓ ${s}`);
const bad = s => { console.log(`  ✗ ${s}`); process.exitCode = 1; };

console.log('\nDev Crew doctor\n');
const [major] = process.versions.node.split('.').map(Number);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — install Node 20 or newer`);

const g = await gitVersion();
g ? ok(g) : bad('git not found — install Git for Windows / git');

let cfg;
try {
  cfg = loadConfig();
  ok(`Config: ${cfg.file}`);
  for (const p of cfg.problems) bad(p);
} catch (e) {
  bad(e.message);
  process.exit(1);
}

const f = await claudeFeatures(cfg.settings.claudeCommand);
if (f.found) {
  ok(`Claude Code ${f.version} (${f.path})`);
  if (!f.dontAsk) console.log('    note: this Claude Code has no "dontAsk" mode; agents run in acceptEdits mode. Update with: claude update');
} else {
  bad('Claude Code not found — npm i -g @anthropic-ai/claude-code, then run `claude` once to log in');
}

console.log(`\n  Workspace: ${cfg.settings.workspacePath}`);
for (const p of cfg.projects) {
  if (!p.exists) bad(`${p.name}: folder not found (${p.path})`);
  else if (!p.repos.length) bad(`${p.name}: no git repos inside ${p.path}`);
  else ok(`${p.name}: ${p.repos.map(r => r.name).join(', ')}`);
  for (const [role, v] of Object.entries(p.roles)) {
    if (v.repo && !p.repos.some(r => r.name === v.repo)) bad(`${p.name}: role "${role}" points at repo "${v.repo}", which isn't there`);
  }
}
console.log(process.exitCode ? '\nFix the ✗ lines, then run npm start.\n' : '\nAll good. Run npm start.\n');
const token = process.env.MONDAY_API_TOKEN || (cfg.settings.monday || {}).token;
const boards = cfg.projects.filter(p => p.monday).length;
console.log(token
  ? `  monday.com: token set · ${boards} of ${cfg.projects.length} project(s) have a board id`
  : '  monday.com: not connected — demo tickets are shown (set MONDAY_API_TOKEN to connect)');
console.log(`  people: ${cfg.people.length} in the config\n`);
