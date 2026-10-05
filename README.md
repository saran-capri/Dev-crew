# Dev-crew

Multiple AI agents: a developer crew for each of your projects.

A crew of six AI engineers for each of your projects: **Solutions Architect, Frontend, Backend,
Database, QA / Test, and DevOps & Cloud**. Assign them tasks each day, and each morning get a
stand-up per project: what got done, what's blocked, the risks, and suggested tasks you can
assign in one click.

Every agent is a headless [Claude Code](https://claude.com/claude-code) session running on your
machine with your own Claude login. Nothing is hosted anywhere.

## How it keeps your repos safe

- **Agents never touch your checkout.** A "Make changes" task gets its own **git worktree** and a
  new branch, `agent/<role>/<date>-<title>`, created from the branch you pick. Your working copy,
  its branch and its uncommitted files are left alone.
- **Agents commit. They never push, merge, rebase, reset or switch branches.** You review the
  branch, then push it yourself. The task panel gives you the exact commands.
- **"Investigate & report" tasks are read-only.** The agent can read files, search and run
  read-only git commands. It cannot edit anything.
- **Locked-down tools.** Agents may run build, test and lint commands for common stacks (npm,
  pnpm, yarn, dotnet, maven, gradle, pytest, go, cargo, terraform fmt/validate, and so on).
  Anything else is refused automatically and shown in the task log. `git push`,
  `terraform apply`, `kubectl`, `rm -rf` and similar are always denied.
- The server only listens on `127.0.0.1`.

## Set up on your work laptop

You need **Node 20+**, **git**, and **Claude Code** logged in:

```powershell
npm install -g @anthropic-ai/claude-code
claude          # log in once, then exit
```

Copy this `dev-crew` folder to the laptop, then tell it where your projects are. Copy
`crew.config.json` to **`crew.config.local.json`**; that file is yours and wins over the
shipped one. Edit it like this:

```json
{
  "settings": {
    "workspace": "C:/Work",
    "model": "sonnet",
    "maxConcurrent": 2,
    "dailyReport": { "enabled": true, "at": "09:00", "weekdaysOnly": true }
  },
  "projects": [
    {
      "id": "billing",
      "name": "Billing Platform",
      "folder": "billing",
      "stack": "Angular 17, .NET 8 API, Azure SQL, AKS via Azure DevOps pipelines",
      "context": "Invoicing for enterprise customers. Release train every second Tuesday.",
      "roles": {
        "frontend": { "repo": "billing-web", "notes": "Use the shared design system in libs/ui." },
        "backend":  { "repo": "billing-api" },
        "database": { "repo": "billing-api", "notes": "Migrations are EF Core, in src/Data/Migrations." },
        "devops":   { "repo": "billing-infra", "model": "opus" }
      },
      "allowCommands": ["npm run e2e"]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `workspace` | The folder that holds your project folders. |
| `folder` | The project's folder inside the workspace (or an absolute path). Every git repo inside it, up to two levels deep, is found automatically. You can also list them: `"repos": [{"name": "web", "path": "src/web"}]`. |
| `stack`, `context` | Read by every agent before every task. Be specific: this is what makes the answers yours. |
| `roles.<role>.repo` | The repo this role usually works in (it's preselected when you assign). |
| `roles.<role>.notes` | Standing instructions for that role on that project. |
| `roles.<role>.model` | `sonnet`, `opus` or `haiku` for that role (a task can still override it). |
| `allowCommands` | Extra command prefixes the agents may run in that project. |

Role ids: `architect`, `frontend`, `backend`, `database`, `qa`, `devops`.

Then:

```powershell
npm run doctor    # checks Node, git, Claude Code, and that every project folder and repo is found
npm start         # → http://localhost:4610
```

To try it with no repos, `npm run demo` creates five sample projects in `demo-workspace/`, which is
what the shipped `crew.config.json` points at.

## The office

The dashboard opens on a 3D office: one floor per project around a central stand-up hub, six
desks per floor, one agent per desk in their role's colour.

- Free agents get up and wander: along the aisles, to the water cooler, to a teammate's desk,
  over to the stand-up hub. When work arrives they walk back and sit down.
- An agent who is **working** types at their desk under a pulsing ring, with what they are doing
  right now floating above them. The **Live** panel lists each step as it happens.
- An amber marker means a branch is **waiting for your review**; red means the last task **failed**.
- **Click an agent**: the camera flies to them, they turn and wave, and a card shows what they
  are doing in their own words, their monday.com tickets, and the person to ask about their area.
  **Click a floor** to open that project; click the hub for the Today overview.
- Drag to pan, scroll to zoom, double-click (or **Fit**) to see the whole office. A floor's rim
  takes the colour of its latest stand-up: green, amber or red.

## monday.com tickets

Each project can point at its monday.com board. A column on the board says which crew role a
ticket belongs to (default column name **Agent**, with values like *Backend*, *QA*, *DevOps*,
*Frontend*, *Database*, *Architect*). Click an agent in the office and the card shows their tickets.
**Work on it** turns a ticket into a task: the agent reads the ticket, its columns and its
latest updates. When the task is done, **Post report** adds the agent's summary as an update on
the ticket. Nothing is written to monday.com unless you press a button that says so.

1. In monday.com: your avatar → **Developers** → **My access tokens** → copy the token.
2. Set it as an environment variable before `npm start` (keeps it out of files):
   ```powershell
   setx MONDAY_API_TOKEN "your-token"     # once; open a new terminal afterwards
   ```
   or put it in `crew.config.local.json` under `settings.monday.token`.
3. In each project, add the board id (the number in the board's URL) and your column names:
   ```json
   "monday": { "boardId": "1234567890", "roleColumn": "Agent", "peopleColumn": "Owner", "statusColumn": "Status" }
   ```

Until a token and board are set, every project shows demo tickets, marked *demo*.

## Who should I ask?

Type a question in the search box at the top (or press **Ctrl+K**):
*"who do I ask backend questions in inventory service"*, *"database inventory"*,
*"terraform"*, *"who handles the pipeline for internal tools"*. The best person pops up with
why they match, their hours, their tickets, and buttons to **email** them, **chat in Teams**,
or **assign them a ticket** (an existing one on the board, or a new one created for them).
In the office, the camera also walks over to that team's desk and pins their name there.

People come from the `people` list in the config, and from whoever is on tickets in the
board's People column (matched by role). Add your staff and contractors:

```json
"people": [
  { "name": "Ravi Menon", "company": "Bluepeak Consulting", "contractor": true, "title": "Senior .NET developer",
    "email": "ravi@bluepeak.example", "teams": "ravi@bluepeak.example", "hours": "Mon–Fri, 9:00–17:30 IST",
    "projects": ["inventory"], "roles": ["backend"], "skills": [".NET 8", "EF Core"] }
]
```

`projects: ["*"]` means every project. To assign monday tickets to someone, they must be a
member or guest on your monday.com account (matched by email, then by name).

## Your day

1. **Morning.** At 09:00 (weekdays), each project gets a stand-up written by its crew lead. It
   covers health (on track / watch / at risk), each role's updates, risks, decisions needed from
   you, and suggested tasks. Open **Today** for all five projects at once, and press **Assign**
   on a suggestion to hand it out.
2. **Assign.** Press **+ Assign task**, pick the project, the role, *Make changes* or
   *Investigate & report*, the repo and the branch to start from. Tick "Keep open" to hand out
   several in a row. Up to `maxConcurrent` agents work at once; the rest queue.
3. **Watch.** The crew page shows who is working on what, live. Click a task to see the agent's
   activity log as it happens.
4. **Review.** Finished change tasks show up under *Ready for your review*, with the commits, the
   diff stats and copy-ready `git log` / `git diff` / `git push` commands.
5. **Follow up.** Type into the task panel ("the test is wrong, …", "also handle X", "continue").
   The agent resumes the same session on the same branch, with everything it already knows.
6. **Tidy.** *Remove worktree* deletes the working folder but keeps the branch.

**Run stand-up** (per project) or **Run all stand-ups** gives you one whenever you want. The
first start doesn't fire a stand-up; the schedule starts the next morning. If the laptop was
off at 09:00, the stand-up runs as soon as Dev Crew starts that day.

## Keep it running

The stand-ups only happen while the server runs. To start it automatically when you log in to
Windows:

```powershell
schtasks /create /tn "Dev Crew" /sc onlogon /tr "cmd /c cd /d C:\path\to\dev-crew && node server.mjs"
```

## Cost

Each task and stand-up is a Claude Code run, billed to your Claude plan (or API key). The top bar
shows today's cost as Claude Code reports it. Sonnet is the default. Pick **Haiku** in the assign
dialog for quick chores and **Opus** for hard ones. A stand-up is usually a few cents to a few
tens of cents.

## Files

```
server.mjs          queue, scheduler, API, live events
lib/roles.mjs       the six roles and their instructions (edit to tune them)
lib/prompts.mjs     task, report and stand-up prompts
lib/claude.mjs      runs `claude -p`, and the allow/deny tool lists
lib/git.mjs         worktrees, branch summaries, repo activity
lib/config.mjs      reads the config and discovers repos
public/             the dashboard (plain HTML/CSS/JS, no build step)
public/office3d.js  the 3D office (three.js, bundled in public/vendor, MIT licence)
data/               tasks, stand-ups, logs, worktrees (created at runtime)
```

## Before you use it at work

Agents send the code they read to Anthropic's API through Claude Code. Check that your
organisation allows Claude Code on these repositories, and use the account (Claude for
Work / Enterprise, or the API key) your organisation approves.
