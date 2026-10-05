// Everything the agents are told. Kept in one place so the wording is easy to tune.
import { ROLES, roleById } from './roles.mjs';

function projectBlock(project) {
  const lines = [`Project: ${project.name}`];
  if (project.stack) lines.push(`Tech stack: ${project.stack}`);
  if (project.context) lines.push(`Context: ${project.context}`);
  if (project.repos.length) lines.push(`Repositories: ${project.repos.map(r => `${r.name} (${r.path})`).join('; ')}`);
  return lines.join('\n');
}

export function taskSystemPrompt(project, roleId, mode, info) {
  const role = roleById(roleId);
  const notes = (project.roles[roleId] || {}).notes;
  const rules = mode === 'change'
    ? `How you work on this task:
- You are in a dedicated git worktree at ${info.cwd} on branch "${info.branch}", created from "${info.base}". Change files only inside this directory.
- Commit your work in small logical commits with messages starting "[${role.short}] ". Leave nothing uncommitted when you finish.
- Never push, merge, rebase, reset, switch branches or change git config; the owner reviews and pushes your branch.
- Run the relevant build, lint and test commands that exist in the repo and report the real results. If a command is blocked or unavailable, say so instead of guessing.
- Shell commands: you are already in the working directory, so never prefix a command with cd. Run one command per call, with no ";", "&&" or "|" chaining; permissions are checked per command and chained ones are refused. Use the Glob, Grep and Read tools to explore files instead of shell listings.
- Never deploy, apply infrastructure, connect to real databases or cloud accounts, or print secrets.
- If the task is ambiguous, do the safe, clearly-intended part and list your questions.`
    : `How you work on this task:
- This is a read-only task. Do not modify, create or delete any files. Investigate and report.
- Use git history (log, diff, show, blame) as evidence where it helps. Run one git command per call with no cd prefix and no chaining; explore files with Glob, Grep and Read.
- Never deploy, connect to real databases or cloud accounts, or print secrets.`;
  return `${role.prompt}

${projectBlock(project)}${notes ? `\nNotes from the owner for your role: ${notes}` : ''}

You are one of six engineers on this project's crew: ${ROLES.map(r => r.name).join(', ')}. Stay inside your role; when something belongs to another role, say which role and what they should do.

${rules}

Finish every task with this report, in Markdown, nothing after it:
## Summary
Two or three sentences: what you did and the outcome.
## ${mode === 'change' ? 'Changes' : 'Findings'}
Bullets with file paths.
## ${mode === 'change' ? 'Tests' : 'Recommendations'}
${mode === 'change' ? 'What you ran and the exact results.' : 'Concrete next steps, each tagged with the role that should do it.'}
## Risks and follow-ups
## Questions for the owner
"None" if there are none.`;
}

export function taskPrompt(task) {
  return `Task from the owner: ${task.title}${task.details ? `\n\nDetails:\n${task.details}` : ''}`;
}

export function reportSystemPrompt(project) {
  return `You are the crew lead (Solutions Architect) of ${project.name}, writing the daily stand-up the owner reads each morning. The owner runs five projects and has two minutes for yours: be specific, short and honest. Use the facts you are given; you may open files or run read-only git commands to check something, but keep that to a handful of calls. Do not modify any file.

${projectBlock(project)}`;
}

export function reportPrompt(project, facts) {
  const repoText = facts.repos.map(r => `### Repo ${r.name}
Checked-out branch: ${r.branch || '?'} · uncommitted files: ${r.uncommitted}
Recently active branches: ${r.branches.join(', ') || 'none'}
Commits in the last 26 hours (all branches):
${r.commits.length ? r.commits.map(c => '- ' + c).join('\n') : '- none'}`).join('\n\n') || 'No repositories found in the project folder.';

  const taskText = facts.tasks.length
    ? facts.tasks.map(t => `- [${t.role}] "${t.title}" — ${t.status}${t.branch ? ` · branch ${t.branch}` : ''}${t.commits ? ` · ${t.commits} commit(s)` : ''}${t.summary ? `\n  Result: ${t.summary.replace(/\n+/g, ' ').slice(0, 600)}` : ''}${t.error ? `\n  Error: ${t.error.slice(0, 200)}` : ''}`).join('\n')
    : '- No crew tasks in this period.';

  return `Write today's stand-up for ${project.name} (${facts.date}).

## Facts: crew tasks (last 3 days and anything still open)
${taskText}

## Facts: open tickets on the monday.com board
${(facts.tickets || []).length ? facts.tickets.map(t => `- [${t.roles.join(', ') || 'unassigned'}] "${t.name}" — ${t.status || 'no status'}${t.due ? ` · due ${t.due}` : ''}${t.people.length ? ` · ${t.people.join(', ')}` : ''}`).join('\n') : '- No board connected or no open tickets.'}

## Facts: repository activity
${repoText}

## Write exactly this, in Markdown
First line: HEALTH: green|amber|red — one short reason

## Headline
One or two sentences.

## Crew updates
One short section per role, in this order: ${ROLES.map(r => r.name).join(', ')}. For each: **Done**, **In progress**, **Blocked** (omit empty ones). A role with no tasks gets one useful observation from the repos instead, or "Idle".

## Risks and blockers

## Decisions needed from you
Numbered; "None" if none.

## Suggested tasks for tomorrow
Then a fenced json block with 2 to 6 tasks the owner can assign with one click:
\`\`\`json
[{"role": "${ROLES.map(r => r.id).join('|')}", "mode": "change|analyze", "repo": "<repo name, or * for the whole project>", "title": "short imperative title", "details": "what done looks like"}]
\`\`\``;
}

/** Pull the health, the suggestions JSON and the readable Markdown out of a report. */
export function parseReport(text) {
  const out = { health: 'unknown', healthReason: '', markdown: text || '', suggestions: [] };
  const h = /HEALTH:\s*(green|amber|red)\b\s*[—–-]?\s*(.*)/i.exec(text || '');
  if (h) {
    out.health = h[1].toLowerCase();
    out.healthReason = h[2].trim();
    out.markdown = out.markdown.replace(h[0], '').trim();
  }
  const blocks = [...(text || '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    try {
      const arr = JSON.parse(last[1]);
      if (Array.isArray(arr)) {
        out.suggestions = arr
          .filter(s => s && roleById(s.role) && s.title)
          .map(s => ({ role: s.role, mode: s.mode === 'analyze' ? 'analyze' : 'change', repo: String(s.repo || '*'), title: String(s.title).slice(0, 200), details: String(s.details || '').slice(0, 2000) }));
      }
    } catch { /* leave the block in the text */ }
    if (out.suggestions.length) out.markdown = out.markdown.replace(last[0], '').trim();
  }
  return out;
}

/** The "## Summary" paragraph of a task report, or the first lines. */
export function summaryOf(text) {
  if (!text) return '';
  const m = /##\s*Summary\s*\n([\s\S]*?)(\n##\s|$)/i.exec(text);
  return (m ? m[1] : text).trim().slice(0, 800);
}
