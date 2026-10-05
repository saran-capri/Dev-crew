// Loads crew.config.json (or crew.config.local.json, which wins) and finds the git repos in
// each project folder. Paths in the config are relative to settings.workspace, which is
// relative to this app's folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_IDS } from './roles.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_SETTINGS = {
  port: 4610,
  workspace: './workspace',
  model: 'sonnet',
  reportModel: 'sonnet',
  maxConcurrent: 2,
  dailyReport: { enabled: true, at: '09:00', weekdaysOnly: true },
  claudeCommand: 'claude',
  permissionMode: '',
  strictMcp: false,
};

export function configFile() {
  const local = path.join(ROOT, 'crew.config.local.json');
  return fs.existsSync(local) ? local : path.join(ROOT, 'crew.config.json');
}

export function loadConfig() {
  const file = configFile();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read ${path.basename(file)}: ${e.message}`);
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(raw.settings || {}),
    dailyReport: { ...DEFAULT_SETTINGS.dailyReport, ...((raw.settings || {}).dailyReport || {}) },
  };
  settings.workspacePath = path.resolve(ROOT, settings.workspace);

  const problems = [];
  const seen = new Set();
  const projects = (raw.projects || []).map((p, i) => {
    const id = String(p.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`Project #${i + 1}: "id" must be lower-case letters, digits and dashes.`);
    if (seen.has(id)) problems.push(`Project id "${id}" is used twice.`);
    seen.add(id);
    const folder = p.folder || p.path || id;
    const projectPath = path.resolve(settings.workspacePath, folder);
    const roles = {};
    for (const [k, v] of Object.entries(p.roles || {})) {
      if (!ROLE_IDS.includes(k)) problems.push(`Project "${id}": unknown role "${k}" (use ${ROLE_IDS.join(', ')}).`);
      else roles[k] = { repo: v.repo || '', notes: v.notes || '', model: v.model || '' };
    }
    return {
      id,
      name: p.name || id,
      path: projectPath,
      stack: p.stack || '',
      context: p.context || '',
      roles,
      allowCommands: Array.isArray(p.allowCommands) ? p.allowCommands.map(String) : [],
      explicitRepos: Array.isArray(p.repos) ? p.repos : null,
      monday: p.monday && p.monday.boardId ? p.monday : null,
      repos: [],
      exists: false,
    };
  });
  for (const p of projects) refreshRepos(p);
  const people = Array.isArray(raw.people) ? raw.people.filter(x => x && x.name) : [];
  return { file, settings, projects, people, problems };
}

/** Fill project.repos: the explicit list from the config, or every git repo found in the folder. */
export function refreshRepos(project) {
  project.exists = fs.existsSync(project.path);
  if (project.explicitRepos) {
    project.repos = project.explicitRepos.map(r => {
      const p = path.resolve(project.path, r.path || r.name);
      return { name: r.name || path.basename(p), path: p, exists: isGitRepo(p) };
    });
    return project;
  }
  const repos = [];
  if (project.exists) {
    if (isGitRepo(project.path)) repos.push({ name: path.basename(project.path), path: project.path, exists: true });
    else {
      for (const d1 of safeDirs(project.path)) {
        const p1 = path.join(project.path, d1);
        if (isGitRepo(p1)) { repos.push({ name: d1, path: p1, exists: true }); continue; }
        for (const d2 of safeDirs(p1)) {
          const p2 = path.join(p1, d2);
          if (isGitRepo(p2)) repos.push({ name: `${d1}/${d2}`, path: p2, exists: true });
        }
      }
    }
  }
  project.repos = repos;
  return project;
}

function isGitRepo(p) {
  return fs.existsSync(path.join(p, '.git'));
}

function safeDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name);
  } catch {
    return [];
  }
}
