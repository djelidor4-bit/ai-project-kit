# ai-project-kit

A reusable **project working model** for AI-assisted projects, for **Claude Code** and **Codex**. It installs into any project folder: a main agent orchestrating seven professional agents, nine process skills, documentation discipline, an engineering operating model and an autonomy switch.

Version **2.0.0** (2026-10-23). Kit content is in Hebrew; this README is the English overview.

## Why: the operating model in six points

- **Main Agent First.** Owner → main agent → only the relevant professional agents → main agent (synthesis) → owner. Only the main agent writes; the others analyze and recommend.
- **Decisions have lock levels.** Every decision carries one of four: `chat-only` → `readiness-direction` → `owner-approved` → `final-locked`. Unknowns go to open questions, never invented.
- **Git is what the system is; the task source is what the team does.** The task source is `docs/tasks.md`, or Jira once both read and write are verified. Weekly sprint, one goal, a human owner for every task.
- **Definition of Done.** Commit in every repo touched; free regression before push: 0 failed, 0 "not checked" (a skip is not a success); a known red becomes a task; verified live; config changes logged by name, never value.
- **Privacy by default.** Request IDs only from the edge server; JSON log lines without personal data, conversation text or keys; secrets never in git.
- **Autonomy switch.** Three levels: `strict`, `balanced` (default) and `autonomous`. Every level has hard stops: money, legal text, passwords/2FA/secrets, production DDL or data writes, irreversible deletion, and messages to people. The owner-approval list applies at every level: autonomy covers execution inside an approved item, not decisions.

## Structure

```
START-HERE.md   Install protocol for Claude Code or Codex (Hebrew)
GUIDE-HE.md     Owner's guide (Hebrew) · CHANGELOG.md (Hebrew)
AGENTS.md       Kit maintenance rules (+ CLAUDE.md) for a session opened here; not installed
kit.json        Manifest: version, modules, file mapping, placeholders
core/           AGENTS.md (constitution), CLAUDE.md, 8 agents, 9 skills, docs templates
modules/        web · jira · ai-product (optional)
tools/          install · check · build-bundle (.mjs, Node >= 18, no deps)
dist/           ai-project-kit-<version>.zip, the whole kit in one file (generated)
```

## Quick start

**Owner.** Open the project folder in Claude Code or Codex and say (in Hebrew):
`קרא את הקובץ <KIT_ROOT>\START-HERE.md ותתקין את ערכת העבודה בפרויקט הזה` (the owner's local path is in `GUIDE-HE.md` §2).
The AI asks one batch of questions (name, stage, modules, team, autonomy, tools, frozen areas; and, only if git has no identity, the owner's name and email for a repo-local `git config`, never `--global` without approval), runs the installer and `node .kit/check.mjs`, and reports.
One approval before the install covers the install, the merge plan (when it has no conflicts) and the docs. The report ends with one question: the status "הותקן — ממתין לבדיקות קבלה" (installed, awaiting acceptance tests) and the local commit. Once the acceptance tests pass in a session of each tool, the status becomes "הותקן ואומת" (installed and verified).

**Collaborators / manual install:**

```
node <kit>/tools/install.mjs --target <project> [--tools claude,codex] [--modules web,jira,ai-product]
      [--values <file.json>] [--docs-repo <repo>] [--update] [--force] [--dry-run] [--kit-root <dir>]
node <project>/.kit/check.mjs [--target <project>] [--fix]
node <kit>/tools/check.mjs --kit
node <kit>/tools/build-bundle.mjs
```

An existing `AGENTS.md`/`CLAUDE.md` is not overwritten: the installer writes `AGENTS.kit.md`/`CLAUDE.kit.md` to merge. The project's own rules go verbatim, in their own language, into a `## כללי הפרויקט` (project rules) section right after the header; conflicts with kit rules are decided by the owner. `check.mjs` then verifies that every kit section heading and module marker survived the merge. Only on the first install, `--force` replaces them after a backup. Docs are copied only when missing.

**Several repos?** Full install in the docs repo; in each code repo, `--docs-repo <docs repo name or relative path>` installs everything except `docs/` and points `AGENTS.md` to the docs repo.

**No folder access** (e.g. a cloud session)? Upload `dist/ai-project-kit-<version>.zip` (~1 MB) and have the AI extract it outside the project and follow `ai-project-kit/START-HERE.md` (wording: `GUIDE-HE.md` §10). Needs a filesystem and Node >= 18. If no folder outside the project is writable, the kit goes to `.kit/kit-src/` (git-ignored by `.kit/.gitignore`; deleted with the owner's OK after the check).

## Tool compatibility

| | Claude Code | Codex |
| :--- | :--- | :--- |
| Instructions | `CLAUDE.md`, whose first line `@AGENTS.md` imports the shared constitution | `AGENTS.md` (root to cwd; 32 KiB default cap, the kit stays ≤ 24 KiB) |
| Agents | `.claude/agents/*.md` (canonical) | `.codex/agents/*.toml`, generated (none for `agent-manager`) |
| Skills | `.claude/skills/<name>/` (canonical) | `.agents/skills/<name>/`, a verified copy (no symlinks) |
| Write exclusivity | The `tools:` whitelist (professional agents: `Read, Glob, Grep`) | By instruction only (TOML cannot make an agent read-only) |
| Jira (optional) | claude.ai Atlassian connector, or `claude mcp add` | `codex mcp add atlassian` (full commands: `START-HERE.md` §3ה) |

After editing an agent or skill: `node .kit/check.mjs --fix` regenerates the TOML and the skills mirror (never hand-edit them).

## Modules

| Module | Adds |
| :--- | :--- |
| core (always) | `agent-manager` + seven professional agents, nine process skills, docs (status, decisions, questions, tasks, scope, engineering model, environments, ADR) |
| `web` | `web-builder` agent, six design skills, a locked design-language template, frontend/API guidelines |
| `jira` | Standing rule: after every completed part, comment and transition (or create) the item. The owner connects; the AI never logs in or deletes items |
| `ai-product` | Prompts and JSON as versioned engineering assets: PR review, release checklist, paid evaluations only with an owner budget |

## Licenses

Third-party design skills in `modules/web/skills/` keep their upstream licenses:

- MIT (`LICENSE-upstream`): `ui-ux-pro-max` (Next Level Builder, `nextlevelbuilder/ui-ux-pro-max-skill`), `design-craft` (derived from it), `design-system`, `taste-frontend`, `redesign-premium` (external packs).
- Apache-2.0 (`LICENSE.txt`): `frontend-design` (Anthropic).

## Credit

The engineering operating model is based on "MVP Engineering Operating Plan" (תוכנית תפעול הנדסית ל-MVP) by Alexey, tech lead. The docs installed into projects cite the plan by title only: the personal credit stays in the kit-level files (`README.md`, `GUIDE-HE.md`, `CHANGELOG.md`).

## Local only

The kit lives on the owner's machine: not published, no network calls, and installing or updating it never creates a Jira item. Optional CLI acceptance runs use the tool's quota, only with the owner's OK.
