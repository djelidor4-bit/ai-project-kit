#!/usr/bin/env node
// ai-project-kit — install.mjs
// Installs (or updates) the kit into a project folder, for Claude Code and/or Codex.
//
//   node tools/install.mjs --target <dir> [--tools claude,codex] [--modules web,jira,ai-product]
//                          [--values <file.json>] [--docs-repo <path-or-name>] [--update] [--force] [--dry-run]
//                          [--kit-root <dir>]
//
// Node >= 18 · ES module · zero dependencies · no shell calls · Windows-safe paths.
// Shares its TOML generator, mirror and parsers with check.mjs, so generated files are byte-identical.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readText, readJson, isFile, isDir, absIn, listFiles, listSubdirs, listMd, compareDirs, mirrorDir, makeBackup,
  composeAgentsMd, syncCodexAgents, readAgentSources, agentBaseName, agentSourceDirRel, canonicalSkillsDirRel,
  findPlaceholders, RE_PH_UPPER, normalizeEol, bytesOf, todayIso, CODEX_DOC_HARD_LIMIT, AGENTS_SOFT_LIMIT,
  docsRepoBlock, RE_DOCS_REPO_VALUE, DOCS_REPO_MARKER, agentsStructureOf, structureMarkers,
} from './check.mjs';

const HELP = `ai-project-kit install

  node tools/install.mjs --target <dir> [options]

  --target <dir>       project folder to install into (created if missing)
  --tools <list>       claude,codex (default: both; on a project that has the kit: the tools in .kit/kit.config.json)
  --modules <list>     optional modules: web,jira,ai-product, or none (core is always installed; modules already
                       installed stay installed — removing a module is manual)
                       A list may use commas, spaces or both: --modules web,jira · --modules web jira · --modules=web jira
  --values <file>      JSON object { "PROJECT_NAME": "...", ... } — fills the matching placeholders in AGENTS.md, CLAUDE.md and docs/
                       (default: <target>/.kit/values.json when it exists). UTF-8 (no BOM); a value that breaks its rule
                       in kit.json placeholderRules (e.g. AUTONOMY_LEVEL not strict|balanced|autonomous, a "|" or a line
                       break in a one-line value) stops the install — under --dry-run it is only reported.
  --docs-repo <repo>   multi-repo project: this is a code repo, and the management docs (decisions log, open questions,
                       tasks, project status, engineering operating model) live in the docs repo <repo> — a repo name
                       or a relative path; it is written into the committed AGENTS.md. Installs AGENTS.md, CLAUDE.md,
                       agents, skills and .kit/ but no docs/; AGENTS.md ends with a "<!-- docs-repo -->" block that
                       points to <repo>. Recorded in .kit/kit.config.json (docsRepo) and kept by later runs.
                       Install the docs repo itself without this option.
  --update             refresh agents and skills from the kit (previous versions backed up), never docs;
                       AGENTS.md / CLAUDE.md → AGENTS.kit.md / CLAUDE.kit.md for a manual merge.
  --force              first install: back up and replace an existing AGENTS.md/CLAUDE.md; any run: back up and replace
                       agents/skills that differ from the kit. Backups go to .kit/backup/<YYYYMMDD-HHMMSS>[-N]/.
                       Once the kit is installed (.kit/kit.config.json exists) AGENTS.md / CLAUDE.md are never
                       overwritten — the installer writes AGENTS.kit.md / CLAUDE.kit.md to merge.
  --dry-run            print what would happen, write nothing
  --kit-root <dir>     kit folder (default: the parent of this tools/ folder). Extract the kit OUTSIDE the project; when
                       no such folder is writable, <project>/.kit/kit-src/ is the one place inside it that
                       .kit/.gitignore keeps out of git (check.mjs [8] warns until it is deleted).

  Every run rewrites .kit/kit.config.json, including agentsStructure: the "## " headings of the kit's core AGENTS.md
  and the <!-- module:… --> / <!-- docs-repo --> markers of the blocks it adds. check.mjs [10] verifies that the
  AGENTS.md the project merged still has all of them (order free, the project's own sections allowed).

  Exit: 0 done (conflicts and leftover placeholders do not fail — read the summary, then run check.mjs)
        · 1 hard error (kit.json missing, values file unreadable / not UTF-8 / breaking a rule) · 2 bad arguments`;

class UsageError extends Error {}
class HardError extends Error {}

// ---------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { target: null, tools: null, modules: null, values: null, docsRepo: null, update: false, force: false, dryRun: false, kitRoot: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    const val = () => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`missing value for ${a}`);
      return v;
    };
    // comma and/or space separated: "web,jira", "web jira" (PowerShell splits an unquoted web,jira into two
    // arguments), "--modules=web jira". There are no positional arguments, so following bare words belong to the list.
    const list = () => {
      const items = [inline !== null ? inline : (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : '')];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) items.push(argv[++i]);
      return items.join(',').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    };
    switch (a) {
      case '--target': o.target = val(); break;
      case '--tools': o.tools = list(); break;
      case '--modules': o.modules = list(); break;
      case '--values': o.values = val(); break;
      case '--docs-repo': o.docsRepo = val(); break;
      case '--kit-root': o.kitRoot = val(); break;
      case '--update': o.update = true; break;
      case '--force': o.force = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------
function applyValues(text, values) {
  let out = text;
  // a few passes, so a value may itself contain another placeholder (e.g. TEAM_SECTION mentions the OWNER_NAME placeholder)
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [k, v] of Object.entries(values)) {
      const tok = `{{${k}}}`;
      if (out.includes(tok)) { out = out.split(tok).join(v); changed = true; }
    }
    if (!changed) break;
  }
  return out;
}

function loadValues(file, warn) {
  let raw;
  try { raw = readJson(file); } catch (e) { throw new HardError(`cannot read values file ${file}: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HardError(`values file must contain a JSON object: ${file}`);
  const values = {};
  for (const [k0, v] of Object.entries(raw)) {
    const k = k0.replace(/^\s*\{\{\s*|\s*\}\}\s*$/g, '').trim();
    if (typeof v === 'string') values[k] = normalizeEol(v);
    else if (typeof v === 'number' || typeof v === 'boolean') values[k] = String(v);
    else warn(`values: "${k0}" is not a string — ignored`);
  }
  // a file saved in an ANSI code page decodes to U+FFFD and would write garbled Hebrew into the constitution
  const bad = Object.entries(values).filter(([k, v]) => k.includes('�') || v.includes('�')).map(([k]) => k);
  if (bad.length) throw new HardError(`values.json is not UTF-8 — save as UTF-8 without BOM (${file}; unreadable characters in: ${bad.join(', ')})`);
  return values;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  if (!o.target) throw new UsageError('--target is required');

  const kitRoot = path.resolve(o.kitRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const kitJsonPath = path.join(kitRoot, 'kit.json');
  if (!isFile(kitJsonPath)) throw new HardError(`kit.json not found in ${kitRoot} (use --kit-root)`);
  let kit;
  try { kit = readJson(kitJsonPath); } catch (e) { throw new HardError(`kit.json is not valid JSON: ${e.message}`); }
  if (!kit.modules || !kit.modules.core) throw new HardError('kit.json has no modules.core');

  const target = path.resolve(o.target);
  const rel = path.relative(kitRoot, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new HardError(`refusing to install into the kit folder itself: ${target}`);
  if (isFile(target)) throw new HardError(`--target is a file, not a folder: ${target}`);
  const kitInTarget = path.relative(target, kitRoot); // the fallback: the zip was extracted inside the project

  const dry = o.dryRun;
  const rep = { created: [], updated: [], unchanged: 0, skipped: [], conflicts: [], merge: [], removed: [], notes: [], warnings: [] };
  const warn = (m) => rep.warnings.push(m);
  const note = (m) => rep.notes.push(m);
  const written = []; // {rel, content} of text files the installer wrote (for the placeholder report)

  // previous install
  const cfgRel = '.kit/kit.config.json';
  let prev = null;
  const installed = isFile(absIn(target, cfgRel)); // the kit was installed here before (even if the config is damaged)
  if (installed) {
    try { prev = readJson(absIn(target, cfgRel)); } catch (e) { warn(`${cfgRel} exists but is not valid JSON (${e.message}) — it will be rewritten`); }
  }
  // the kit folder inside the project (fallback: no folder outside it was writable) — reported after .kit/.gitignore (step 6)
  const kitCopyRel = kitInTarget && !kitInTarget.startsWith('..') && !path.isAbsolute(kitInTarget) ? kitInTarget.split(path.sep).join('/') : null;
  if (o.update && !prev) warn('--update: no previous install found (.kit/kit.config.json) — installing fresh, with update rules for existing files');
  if (!o.update && prev) note(`kit ${prev.kitVersion || '?'} is already installed here — existing files are kept; use --update to refresh agents and skills`);
  if (o.update && o.force) note('--force does not overwrite AGENTS.md / CLAUDE.md in --update mode — they always go to *.kit.md for a manual merge');
  else if (o.force && installed) note('--force does not overwrite AGENTS.md / CLAUDE.md once the kit is installed — merge AGENTS.kit.md (and CLAUDE.kit.md); agents/skills that differ are still backed up and replaced');

  // tools
  const KNOWN_TOOLS = ['claude', 'codex'];
  let tools = o.tools;
  if (!tools && prev && Array.isArray(prev.tools) && prev.tools.length) { tools = prev.tools; note(`tools kept from .kit/kit.config.json: ${prev.tools.join(', ')}`); }
  if (!tools) tools = Array.isArray(kit.defaultTools) ? kit.defaultTools : ['claude', 'codex'];
  const badTools = tools.filter((t) => !KNOWN_TOOLS.includes(t));
  if (badTools.length) throw new UsageError(`unknown tool(s): ${badTools.join(', ')} — use claude, codex`);
  tools = KNOWN_TOOLS.filter((t) => tools.includes(t));
  if (!tools.length) throw new UsageError('--tools must name at least one of: claude, codex');
  const claude = tools.includes('claude');
  const codex = tools.includes('codex');

  // modules
  const known = Object.keys(kit.modules);
  let requested = (o.modules || []).filter((m) => m !== 'core' && m !== 'none');
  const badMods = requested.filter((m) => !known.includes(m));
  if (badMods.length) throw new UsageError(`unknown module(s): ${badMods.join(', ')} — available: ${known.filter((m) => m !== 'core').join(', ')}`);
  const prevModules = prev && Array.isArray(prev.modules) ? prev.modules.filter((m) => known.includes(m)) : [];
  const dropped = o.modules ? prevModules.filter((m) => m !== 'core' && !requested.includes(m)) : [];
  if (dropped.length) note(`module removal is manual: ${dropped.join(', ')} stays installed`);
  requested = [...new Set([...requested, ...prevModules.filter((m) => m !== 'core')])]; // an installed module is never dropped
  const modules = known.filter((m) => m === 'core' || requested.includes(m));
  const newModules = new Set(modules.filter((m) => !prevModules.includes(m)));

  // docs repo (multi-repo project): this code repo gets the constitution, agents and skills — no docs/
  let docsRepo = null;
  if (o.docsRepo !== null) {
    docsRepo = o.docsRepo.trim();
    if (!docsRepo || !RE_DOCS_REPO_VALUE.test(docsRepo)) throw new UsageError(`--docs-repo needs one line without a backtick or "|" (got ${JSON.stringify(o.docsRepo)})`);
    if (prev && typeof prev.docsRepo === 'string' && prev.docsRepo.trim() && prev.docsRepo.trim() !== docsRepo) note(`docs repo changed: ${prev.docsRepo.trim()} → ${docsRepo}`);
  } else if (prev && typeof prev.docsRepo === 'string' && prev.docsRepo.trim()) {
    docsRepo = prev.docsRepo.trim();
    note(`docs repo kept from .kit/kit.config.json: ${docsRepo}`);
  }
  if (docsRepo && (path.isAbsolute(docsRepo) || /^[A-Za-z]:/.test(docsRepo) || docsRepo.startsWith('~'))) warn(`--docs-repo "${docsRepo}" is a local absolute path — it is written into the committed AGENTS.md and kit.config.json; prefer the repo name or a relative path (e.g. ../product-docs)`);
  if (docsRepo && prev && !prev.docsRepo && Array.isArray(prev.docs) && prev.docs.length) note(`docs/ of the earlier install is kept as it is — from now on the management docs live in the docs repo (${docsRepo}); move or remove docs/ only with the owner's approval`);

  // values
  let valuesFile = null;
  if (o.values) {
    const c1 = path.resolve(process.cwd(), o.values);
    const c2 = path.resolve(target, o.values);
    valuesFile = isFile(c1) ? c1 : isFile(c2) ? c2 : null;
    if (!valuesFile) throw new HardError(`values file not found: ${o.values}`);
  } else if (isFile(absIn(target, '.kit/values.json'))) {
    valuesFile = absIn(target, '.kit/values.json');
    note('using values from .kit/values.json');
  }
  const values = valuesFile ? loadValues(valuesFile, warn) : {};
  const groups = Object.entries(kit.placeholders || {}).filter(([g]) => g !== 'required');
  const declared = new Set([...((kit.placeholders || {}).required || []), ...groups.flatMap(([, v]) => v || [])]);
  for (const k of Object.keys(values)) if (!declared.has(k)) warn(`values: unknown key "${k}" (not declared in kit.json placeholders)`);
  if (!('KIT_VERSION' in values)) { values.KIT_VERSION = kit.version; note(`KIT_VERSION filled automatically: ${kit.version}`); }
  else if (o.update && values.KIT_VERSION !== kit.version) { note(`KIT_VERSION ${values.KIT_VERSION} → ${kit.version} (update)`); values.KIT_VERSION = kit.version; }
  if (!('INSTALL_DATE' in values)) {
    values.INSTALL_DATE = prev && typeof prev.installedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(prev.installedAt) ? prev.installedAt.slice(0, 10) : todayIso();
    note(`INSTALL_DATE filled automatically: ${values.INSTALL_DATE}`);
  }
  const ruleErrors = [];
  const shown = (v) => JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  for (const [k, rule] of Object.entries(kit.placeholderRules || {})) {
    if (!(k in values)) continue;
    const why = rule.note ? ` (${rule.note})` : '';
    if (Array.isArray(rule.enum) && !rule.enum.includes(values[k])) ruleErrors.push(`${k} = ${shown(values[k])} — expected one of: ${rule.enum.join(' | ')}${why}`);
    else if (rule.pattern && !new RegExp(rule.pattern).test(values[k])) ruleErrors.push(`${k} = ${shown(values[k])} — does not match ${rule.pattern}${why}`);
  }
  if (ruleErrors.length && !dry) throw new HardError(`values break kit.json placeholderRules — fix ${valuesFile} and run again:\n  - ${ruleErrors.join('\n  - ')}`);
  for (const e of ruleErrors) warn(`values: ${e} — a real install stops here`);
  const required = [...((kit.placeholders || {}).required || [])];
  for (const m of modules) { const g = kit.modules[m].placeholderGroup; if (g) required.push(...((kit.placeholders || {})[g] || [])); }
  const missingKeys = required.filter((k) => !(k in values));

  // write helpers
  let backup = null;
  const getBackup = () => (backup ||= makeBackup(target));
  const write = (r, content) => {
    if (dry) return;
    const p = absIn(target, r);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const saveBackup = (r) => { if (!dry) getBackup().save(r); };
  // mirrorDir never copies symlinks (Windows): report them and keep only the real file actions
  const fileActs = (acts) => { for (const a of acts) if (a.op === 'symlink') warn(`${a.path}: ${a.note}`); return acts.filter((a) => a.op !== 'symlink'); };

  // ---- 1. AGENTS.md / CLAUDE.md --------------------------------------------------------------
  const placeInstructionFile = (liveRel, kitRel, content) => {
    const p = absIn(target, liveRel);
    if (!isFile(p)) { write(liveRel, content); rep.created.push(liveRel); written.push({ rel: liveRel, content }); return; }
    if (normalizeEol(readText(p)) === content) { rep.unchanged++; return; }
    if (o.force && !o.update && !installed) { // first install only — an installed project's constitution is never overwritten
      saveBackup(liveRel); write(liveRel, content);
      rep.updated.push(`${liveRel} (--force; previous version backed up)`); written.push({ rel: liveRel, content });
      return;
    }
    write(kitRel, content); written.push({ rel: kitRel, content });
    rep.merge.push(`${kitRel} → merge into ${liveRel}`);
  };

  const core = kit.modules.core;
  for (const k of ['agentsMd', 'claudeMd']) if (!core[k] || !isFile(absIn(kitRoot, core[k]))) throw new HardError(`kit file missing: modules.core.${k} (${core[k] || 'not set'})`);
  const coreText = readText(absIn(kitRoot, core.agentsMd));
  const sectionTexts = [];
  const markers = []; // <!-- module:<m> --> of each section written, then <!-- docs-repo --> (agentsStructure)
  for (const m of modules) {
    const s = kit.modules[m].section;
    if (m === 'core' || !s) continue;
    if (!isFile(absIn(kitRoot, s))) { warn(`module ${m}: section file missing in the kit (${s}) — AGENTS.md is written without it`); continue; }
    const t = readText(absIn(kitRoot, s));
    sectionTexts.push(t);
    const mk = `<!-- module:${m} -->`;
    if (structureMarkers(t).includes(mk)) markers.push(mk);
    else warn(`module ${m}: its section has no ${mk} line — check.mjs cannot verify that a merged AGENTS.md keeps it`);
  }
  let agentsMd = applyValues(composeAgentsMd(coreText, sectionTexts), values);
  if (docsRepo) { agentsMd = composeAgentsMd(agentsMd, [docsRepoBlock(docsRepo)]); markers.push(DOCS_REPO_MARKER); } // after the module sections; the value is not a template
  // merge validation: the `## ` headings of the core constitution (filled, outside code fences) and the block markers;
  // check.mjs [10] verifies every one is still in AGENTS.md after the project merges AGENTS.kit.md. Refreshed on every run.
  const agentsStructure = agentsStructureOf(applyValues(normalizeEol(coreText), values), markers);
  if (!agentsStructure.headings.length) warn(`${core.agentsMd} has no "## " heading — agentsStructure is empty and check.mjs [10] will FAIL`);
  const agentsBytes = bytesOf(agentsMd);
  if (agentsBytes > CODEX_DOC_HARD_LIMIT) warn(`AGENTS.md would be ${agentsBytes} bytes > ${CODEX_DOC_HARD_LIMIT}: Codex silently drops the rest — move detail into docs/`);
  else if (agentsBytes > AGENTS_SOFT_LIMIT) warn(`AGENTS.md is ${agentsBytes} bytes > ${AGENTS_SOFT_LIMIT} budget`);
  placeInstructionFile('AGENTS.md', 'AGENTS.kit.md', agentsMd);

  if (claude) {
    const claudeMd = applyValues(normalizeEol(readText(absIn(kitRoot, core.claudeMd))), values);
    placeInstructionFile('CLAUDE.md', 'CLAUDE.kit.md', claudeMd);
  }

  // ---- 2. docs (copy only missing files — never overwrite; none in a code repo with --docs-repo) --
  const docsList = [];
  if (docsRepo) note(`docs/: not installed — the management docs live in the docs repo (${docsRepo}); AGENTS.md points there`);
  for (const m of docsRepo ? [] : modules) {
    const mod = kit.modules[m];
    if (!mod.docs) continue;
    const srcDir = absIn(kitRoot, mod.docs);
    if (!isDir(srcDir)) { warn(`module ${m}: docs folder missing in the kit (${mod.docs})`); continue; }
    const mayAdd = !o.update || !prev || newModules.has(m);
    for (const f of listFiles(srcDir)) {
      const r = `docs/${f}`;
      if (isFile(absIn(target, r))) { rep.skipped.push(r); docsList.push(r); continue; }
      if (!mayAdd) { note(`${r} is new in kit ${kit.version} — --update never adds docs of installed modules; copy it from the kit by hand if wanted`); continue; }
      const srcAbs = absIn(srcDir, f);
      if (/\.md$/i.test(f)) {
        const content = applyValues(normalizeEol(readText(srcAbs)), values);
        write(r, content); written.push({ rel: r, content });
      } else write(r, fs.readFileSync(srcAbs));
      rep.created.push(r); docsList.push(r);
    }
  }

  // ---- 3. agents (canonical .md) ---------------------------------------------------------------
  const agentDirRel = agentSourceDirRel(tools);
  const kitAgents = [];
  const planned = new Map(); // base → text written this run (dry-run overlay for TOML)
  const seeded = new Map();  // rel → Buffer adopted from the project's previous canonical source (dry-run overlay)
  for (const m of modules) {
    const mod = kit.modules[m];
    if (!mod.agents) continue;
    for (const f of listMd(absIn(kitRoot, mod.agents))) kitAgents.push({ base: agentBaseName(f), srcAbs: absIn(kitRoot, `${mod.agents}/${f}`) });
  }
  if (claude && isDir(absIn(target, '.kit/agents-src'))) {
    // codex-only → claude: the project's own agent sources move to .claude/agents first, so nothing it changed is lost
    let n = 0;
    for (const f of listMd(absIn(target, '.kit/agents-src'))) {
      const r = `.claude/agents/${f}`;
      if (isFile(absIn(target, r))) continue;
      const buf = fs.readFileSync(absIn(target, `.kit/agents-src/${f}`));
      write(r, buf); seeded.set(r, buf); planned.set(agentBaseName(f), buf.toString('utf8')); n++;
      rep.created.push(`${r} (from .kit/agents-src)`);
    }
    note(`.claude/agents is now the canonical agent source${n ? ` (${n} file(s) taken from .kit/agents-src)` : ''}; .kit/agents-src is no longer used — remove it after checking`);
  }
  for (const a of kitAgents) {
    const r = `${agentDirRel}/${a.base}.md`;
    const src = fs.readFileSync(a.srcAbs);
    const p = absIn(target, r);
    const cur = seeded.get(r) || (isFile(p) ? fs.readFileSync(p) : null);
    if (!cur) { write(r, src); rep.created.push(r); planned.set(a.base, src.toString('utf8')); continue; }
    const strip = (b) => normalizeEol(b.toString('utf8').replace(/^\uFEFF/, ''));
    if (strip(cur) === strip(src)) { rep.unchanged++; continue; }
    if (o.update || o.force) { saveBackup(r); write(r, src); rep.updated.push(`${r} (previous version backed up)`); planned.set(a.base, src.toString('utf8')); continue; }
    rep.conflicts.push(`${r} — differs from the kit's version; kept (use --update to replace it, with a backup)`);
  }

  // ---- 4. skills (whole folders, recursive) ----------------------------------------------------
  const skillsRel = canonicalSkillsDirRel(tools);
  const kitSkills = [];
  const adoptedFrom = new Map(); // rel → folder the project's own copy comes from (dry-run overlay)
  if (claude && codex && isDir(absIn(target, '.agents/skills'))) {
    // .claude/skills becomes the canonical source of the mirror: adopt skill folders that exist only in .agents/skills,
    // so the mirror never deletes the project's own skills or its edits to them
    for (const s of listSubdirs(absIn(target, '.agents/skills'))) {
      const r = `.claude/skills/${s}`;
      if (isDir(absIn(target, r))) continue;
      const from = absIn(target, `.agents/skills/${s}`);
      fileActs(mirrorDir(from, absIn(target, r), { dstRel: r, dryRun: dry }));
      adoptedFrom.set(r, from);
      rep.created.push(`${r}/ (from .agents/skills)`);
    }
  }
  for (const m of modules) {
    const mod = kit.modules[m];
    if (!mod.skills) continue;
    for (const s of listSubdirs(absIn(kitRoot, mod.skills))) {
      kitSkills.push(s);
      const srcAbs = absIn(kitRoot, `${mod.skills}/${s}`);
      const r = `${skillsRel}/${s}`;
      const dstAbs = absIn(target, r);
      const current = dry && adoptedFrom.has(r) ? adoptedFrom.get(r) : dstAbs;
      if (!isDir(current)) {
        const acts = fileActs(mirrorDir(srcAbs, dstAbs, { dstRel: r, dryRun: dry }));
        rep.created.push(`${r}/ (${acts.length} file(s))`);
        continue;
      }
      const c = compareDirs(srcAbs, current);
      if (c.same) { rep.unchanged++; continue; }
      if (o.update || o.force) {
        const acts = fileActs(mirrorDir(srcAbs, dstAbs, { dstRel: r, dryRun: dry, backup: dry ? null : getBackup() }));
        rep.updated.push(`${r}/ (${dry ? c.missing.length + c.different.length + c.extra.length : acts.length} file(s) changed; previous versions backed up)`);
        continue;
      }
      rep.conflicts.push(`${r}/ — differs from the kit's version (${c.different.length} different, ${c.missing.length} missing, ${c.extra.length} extra${c.symlinks.length ? `, ${c.symlinks.length} symlink(s)` : ''}); kept (use --update)`);
    }
  }

  // ---- 5. Codex: TOML agents + skills mirror ---------------------------------------------------
  if (codex) {
    const sources = new Map();
    for (const s of readAgentSources(target, agentDirRel)) sources.set(s.base, s);
    if (dry) for (const [base, text] of planned) sources.set(base, { base, rel: `${agentDirRel}/${base}.md`, text: text.replace(/^\uFEFF/, '') });
    const list = [...sources.values()].sort((x, y) => (x.base < y.base ? -1 : x.base > y.base ? 1 : 0));
    for (const a of syncCodexAgents(target, list, { dryRun: dry, backup: dry ? null : getBackup() })) {
      if (a.op === 'create') rep.created.push(a.path);
      else if (a.op === 'overwrite') rep.updated.push(`${a.path} (regenerated)`);
      else if (a.op === 'delete') rep.removed.push(`${a.path} — ${a.note} (backed up)`);
      else note(`${a.path}: ${a.note}`);
    }
    if (claude) {
      if (dry) note('would mirror .claude/skills → .agents/skills (exact copy; extra files in .agents/skills are backed up and removed)');
      else if (!isDir(absIn(target, '.claude/skills'))) warn('.claude/skills is missing — .agents/skills was not mirrored');
      else {
        const before = new Set(listSubdirs(absIn(target, '.agents/skills')));
        const acts = fileActs(mirrorDir(absIn(target, '.claude/skills'), absIn(target, '.agents/skills'), { dstRel: '.agents/skills', backup: getBackup() }));
        const byFolder = new Map();
        for (const a of acts) {
          if (a.op === 'delete') { rep.removed.push(`${a.path} — not in .claude/skills (backed up)`); continue; }
          const folder = a.path.split('/').slice(0, 3).join('/');
          byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
        }
        for (const [folder, n] of byFolder) {
          const name = folder.split('/')[2];
          (before.has(name) ? rep.updated : rep.created).push(`${folder}/ (mirrored, ${n} file(s))`);
        }
        if (!acts.length) rep.unchanged++;
      }
    }
  }

  // ---- 6. .kit/check.mjs + .kit/kit.config.json ------------------------------------------------
  const checkSrc = absIn(kitRoot, (kit.files && kit.files.check) || 'tools/check.mjs');
  if (!isFile(checkSrc)) warn('tools/check.mjs missing in the kit — .kit/check.mjs not copied');
  else {
    const buf = fs.readFileSync(checkSrc);
    const p = absIn(target, '.kit/check.mjs');
    if (!isFile(p)) { write('.kit/check.mjs', buf); rep.created.push('.kit/check.mjs'); }
    else if (!fs.readFileSync(p).equals(buf)) { write('.kit/check.mjs', buf); rep.updated.push('.kit/check.mjs'); }
    else rep.unchanged++;
  }
  if (valuesFile) { // keep the values beside the install, so a later --update fills AGENTS.kit.md the same way
    const keepRel = '.kit/values.json';
    const keepAbs = absIn(target, keepRel);
    const same = process.platform === 'win32' ? path.resolve(valuesFile).toLowerCase() === path.resolve(keepAbs).toLowerCase() : path.resolve(valuesFile) === path.resolve(keepAbs);
    if (!same) {
      const buf = fs.readFileSync(valuesFile);
      if (!isFile(keepAbs)) { write(keepRel, buf); rep.created.push(`${keepRel} (copy of ${o.values}; reused by --update)`); }
      else if (!fs.readFileSync(keepAbs).equals(buf)) { saveBackup(keepRel); write(keepRel, buf); rep.updated.push(`${keepRel} (from ${o.values}; previous version backed up)`); }
      else rep.unchanged++;
    }
  }
  const now = new Date().toISOString();
  // kit.config.json is committed with the project: no local paths in it (the kit folder goes to the git-ignored local.json)
  const config = {
    kitVersion: kit.version,
    installedAt: prev && prev.installedAt ? prev.installedAt : now,
    ...(prev ? { updatedAt: now } : {}),
    tools,
    modules,
    agents: [...new Set(kitAgents.map((a) => a.base))].sort(),
    skills: [...new Set(kitSkills)].sort(),
    docs: [...new Set(docsList)].sort(),
    placeholders: [...declared].sort(), // check.mjs [1]: only these names count as leftovers
    ...(docsRepo ? { docsRepo } : {}),  // check.mjs: the docs checks are N/A by design in a code repo
    agentsStructure,                    // check.mjs [10]: kit headings + block markers a merged AGENTS.md must keep
  };
  write(cfgRel, `${JSON.stringify(config, null, 2)}\n`);
  (prev ? rep.updated : rep.created).push(cfgRel);
  const localRel = '.kit/local.json';
  const localText = `${JSON.stringify({ kitRoot, note: 'this computer only — git-ignored by .kit/.gitignore; used to find the kit for --update' }, null, 2)}\n`;
  if (!isFile(absIn(target, localRel))) { write(localRel, localText); rep.created.push(`${localRel} (kit folder on this computer; not committed)`); }
  else if (readText(absIn(target, localRel)) !== localText) { write(localRel, localText); rep.updated.push(localRel); }
  else rep.unchanged++;
  const ignoreRel = '.kit/.gitignore';
  // kit-src/: a kit copy extracted inside the project when no folder outside it was writable — never committed
  const IGNORE = ['backup/', 'local.json', 'kit-src/'];
  const IGNORE_HEAD = '# ai-project-kit — local files that are not committed';
  let ignoresKitCopy = true; // .kit/.gitignore lists (or will list) kit-src/
  if (!isFile(absIn(target, ignoreRel))) {
    write(ignoreRel, `${IGNORE_HEAD}\n${IGNORE.join('\n')}\n`);
    rep.created.push(`${ignoreRel} (${IGNORE.join(', ')})`);
  } else {
    const cur = normalizeEol(readText(absIn(target, ignoreRel)));
    const have = new Set(cur.split('\n').map((l) => l.trim()));
    const lack = IGNORE.filter((x) => !have.has(x) && !have.has(`/${x}`));
    if (!lack.length) rep.unchanged++;
    else if (cur.startsWith(IGNORE_HEAD)) { // the kit wrote this file (an earlier version): add the new lines
      write(ignoreRel, `${cur.replace(/\n*$/, '\n')}${lack.join('\n')}\n`);
      rep.updated.push(`${ignoreRel} (+ ${lack.join(', ')})`);
    } else {
      ignoresKitCopy = !lack.includes('kit-src/');
      warn(`${ignoreRel} exists but does not list ${lack.join(', ')} — add ${lack.length > 1 ? 'them' : 'it'} so backups, local paths and kit copies are not committed`);
    }
  }
  if (kitCopyRel) {
    const r = kitCopyRel;
    const git = r !== '.kit/kit-src' ? ' — only .kit/kit-src/ is git-ignored; prefer a folder outside the project'
      : ignoresKitCopy ? ' (.kit/.gitignore keeps it out of git)' : ' — .kit/.gitignore does not list kit-src/ yet: add it before any commit';
    note(`the kit folder is inside the project (${r}/) — delete it with the owner's approval once node .kit/check.mjs passes, and never commit it${git}`);
  }

  // ---- 7. placeholders -------------------------------------------------------------------------
  const leftovers = [];
  for (const w of written) for (const h of findPlaceholders(w.content, RE_PH_UPPER)) leftovers.push(`${w.rel}:${h.line}  ${h.token}`);

  // ---- summary ---------------------------------------------------------------------------------
  const out = (s = '') => console.log(s);
  const section = (title, items, mark) => {
    if (!items.length) return;
    out(`${title} (${items.length}):`);
    for (const it of items) out(`  ${mark} ${it}`);
  };
  out(`ai-project-kit ${kit.version} → ${target}${dry ? '   [dry-run — nothing was written]' : ''}`);
  out(`mode: ${o.update ? 'update' : 'install'} · tools: ${tools.join(', ')} · modules: ${modules.join(', ')}${docsRepo ? ` · docs repo: ${docsRepo} (no docs/ here)` : ''}${valuesFile ? ` · values: ${valuesFile}` : ''}`);
  out(`AGENTS.md: ${agentsBytes} bytes (budget ${AGENTS_SOFT_LIMIT}, Codex cap ${CODEX_DOC_HARD_LIMIT})`);
  out('');
  section('Created', rep.created, '+');
  section('Updated', rep.updated, '*');
  section(o.update ? 'Kept — docs are never overwritten' : 'Skipped — already exist, kept', rep.skipped, '=');
  section('Conflicts — existing differs from the kit, kept', rep.conflicts, '!');
  section('Merge needed', rep.merge, '~');
  section('Removed', rep.removed, '-');
  if (rep.unchanged) out(`Unchanged: ${rep.unchanged} item(s) already identical`);
  if (backup && backup.saved.length) out(`Backup: ${backup.rootRel}/ (${backup.saved.length} file(s)) — not committed (.kit/.gitignore)`);
  section('Notes', rep.notes, 'i');
  section('Warnings', rep.warnings, '⚠');
  out('');
  if (missingKeys.length) out(`Placeholders still missing — no value given (${missingKeys.length}): ${missingKeys.join(', ')}`);
  if (leftovers.length) {
    out(`Placeholders still in written files (${leftovers.length}) — fill them, or turn them into "⏳ למלא:" lines:`);
    for (const l of leftovers.slice(0, 30)) out(`  ? ${l}`);
    if (leftovers.length > 30) out(`  … and ${leftovers.length - 30} more`);
  } else if (written.length) out('Placeholders: none left in the files written by this run.');
  out('');
  out('Next:');
  if (rep.merge.length) out('  •  Merge each *.kit.md into its live file (keep the project\'s own rules; CLAUDE.md keeps @AGENTS.md as its first line), then delete the *.kit.md file.');
  if (rep.conflicts.length) out('  •  Conflicts were kept as they are. Review them; re-run with --update to take the kit\'s version (with a backup).');
  out(`  •  Verify: node .kit/check.mjs   (in ${target})`);
  if (docsRepo) out(`  •  The management docs live in the docs repo (${docsRepo}) — install the kit there without --docs-repo, if not done yet.`);
  if (codex && claude) out('  •  After editing an agent or a skill in .claude/: node .kit/check.mjs --fix  (regenerates .codex/agents/*.toml, mirrors .agents/skills)');
  else if (codex) out('  •  After editing an agent in .kit/agents-src/: node .kit/check.mjs --fix  (regenerates .codex/agents/*.toml)');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof UsageError) { console.error(`error: ${e.message}\n\n${HELP}`); process.exitCode = 2; }
  else if (e instanceof HardError) { console.error(`error: ${e.message}`); process.exitCode = 1; }
  else { console.error(`unexpected error: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; }
}
