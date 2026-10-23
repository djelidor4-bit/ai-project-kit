#!/usr/bin/env node
// ai-project-kit — check.mjs
// Project mode (default): verifies a project the kit was installed into.   node .kit/check.mjs [--target <dir>] [--fix]
//                         [1] placeholders · [2] instruction files · [3] codex agents · [4] skills · [5] frontmatter ·
//                         [6] kit config · [7] write exclusivity · [8] pending merge · [9] docs · [10] constitution structure
// Kit mode:               verifies the kit itself (run at the kit root).    node tools/check.mjs --kit [--kit-root <dir>]
// Also the shared library of install.mjs and build-bundle.mjs: frontmatter parser, TOML generator, skills mirror,
// the docs-repo block, and the zip helpers (file list, CRC-32, reader).
// Node >= 18 · ES module · zero dependencies · no shell calls · Windows-safe paths.
// A check that cannot run is a FAIL, never a skip.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------
export const DEFERRED_MARKER = '⏳ למלא:';
export const GENERATED_PREFIX = '# GENERATED from ';
export const MANAGER_AGENT = 'agent-manager';
export const CODEX_DOC_HARD_LIMIT = 32768; // Codex project_doc_max_bytes default (32 KiB): content past it is silently dropped
export const AGENTS_SOFT_LIMIT = 24576;     // our budget for AGENTS.md (core + module sections)
// allowlist: a professional agent holds exactly these Claude Code tools (AGENTS.md: "Read, Glob, Grep בלבד").
// Anything else is a FAIL: Write, Edit, Bash, PowerShell, NotebookEdit, mcp__… connectors can modify state, and
// WebFetch / WebSearch reach the network — only the main agent holds more.
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const ROUTING_SUFFIX = 'מופעל דרך הסוכן הראשי (`agent-manager`)';
// the autonomy switch line in AGENTS.md (spec §3.4) and its mirror in docs/project-status.md
export const AUTONOMY_LEVELS = ['strict', 'balanced', 'autonomous'];
export const RE_AUTONOMY_LINE = /^\*\*רמת העצמאות הנוכחית:\*\* `(strict|balanced|autonomous)`$/;
const RE_AUTONOMY_ANY = /^\*\*רמת העצמאות הנוכחית:\*\* `([^`]*)`/;
const BOM_MSG = 'starts with a BOM — save as UTF-8 without BOM';
const FM_FIX = 'quote the value or remove ": " / " #"';
// multi-repo projects (install.mjs --docs-repo): a code repo gets no docs/; AGENTS.md ends with this block
export const DOCS_REPO_MARKER = '<!-- docs-repo -->';
export const RE_DOCS_REPO_VALUE = /^[^`|\r\n]+$/; // written inside a code span in AGENTS.md
const DOCS_NA = 'N/A by design (docs repo)';
// the distributable zip (build-bundle.mjs)
export const ZIP_TOP = 'ai-project-kit';
export const DEFAULT_BUNDLE = 'dist/ai-project-kit-{version}.zip';
export const LEGACY_BUNDLE = 'dist/PORTABLE-KIT.md';

// identifier-like placeholder in any case (kit mode, kit-authored files)
export const RE_PH_ANY = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
// upper-case placeholder (project mode leftovers; skills in kit mode — avoids JSX like {{ once: true }})
export const RE_PH_UPPER = /\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g;

// ---------------------------------------------------------------------------------------------
// small fs/text helpers
// ---------------------------------------------------------------------------------------------
export function stripBom(s) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }
export function normalizeEol(s) { return s.replace(/\r\n?/g, '\n'); }
export function readText(p) { return stripBom(fs.readFileSync(p, 'utf8')); }
export function hasBom(p) { return fs.readFileSync(p, 'utf8').charCodeAt(0) === 0xfeff; }
export function bytesOf(s) { return Buffer.byteLength(s, 'utf8'); }
export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
export function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function absIn(root, rel) { return path.join(root, ...String(rel).split('/').filter(Boolean)); }
export function readJson(p) { return JSON.parse(readText(p)); }

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function todayIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Sorted posix relative paths of all regular files under dir (recursive). Symlinks are not followed. */
export function listFiles(dir, opts = {}) {
  const out = [];
  if (!isDir(dir)) return out;
  const walk = (absDir, rel) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((x, y) => cmp(x.name, y.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = path.join(absDir, e.name);
      if (e.isSymbolicLink()) { if (opts.symlinks) opts.symlinks.push(r); continue; }
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** Direct sub-directories of dir, sorted. */
export function listSubdirs(dir) {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(cmp);
}

/** *.md files directly inside dir, sorted. */
export function listMd(dir) {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort(cmp);
}

function fileHash(p) { return sha256(fs.readFileSync(p)); }

/**
 * Compare two directory trees by relative file list + sha256.
 * Symlinks (incl. Windows junctions) are never followed or copied; they are reported in `symlinks`
 * ("a/<rel>" or "b/<rel>") and make the trees count as not the same.
 */
export function compareDirs(a, b) {
  const la = [], lb = [];
  const fa = listFiles(a, { symlinks: la }), fb = listFiles(b, { symlinks: lb });
  const sa = new Set(fa), sb = new Set(fb);
  const missing = fa.filter((f) => !sb.has(f));   // in a, not in b
  const extra = fb.filter((f) => !sa.has(f));     // in b, not in a
  const different = fa.filter((f) => sb.has(f) && fileHash(absIn(a, f)) !== fileHash(absIn(b, f)));
  const symlinks = [...la.map((f) => `a/${f}`), ...lb.map((f) => `b/${f}`)];
  return { missing, extra, different, symlinks, same: !missing.length && !extra.length && !different.length && !symlinks.length };
}

function removeEmptyDirs(dir, keepRoot = true) {
  if (!isDir(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name), false);
  }
  if (!keepRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Backup helper: copies a project file to .kit/backup/<ts>/<rel> before it is overwritten or removed.
 * The folder is claimed atomically on the first save; when <ts> is taken (two backups in the same second,
 * or a parallel session) it becomes <ts>-2, <ts>-3, … — an earlier backup is never overwritten.
 */
export function makeBackup(target, ts = timestamp()) {
  const base = `.kit/backup/${ts}`;
  let claimed = null;
  const saved = [];
  const claim = () => {
    if (claimed) return claimed;
    fs.mkdirSync(absIn(target, '.kit/backup'), { recursive: true });
    for (let n = 1; ; n++) {
      const rel = n === 1 ? base : `${base}-${n}`;
      try { fs.mkdirSync(absIn(target, rel)); claimed = rel; return rel; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  };
  return {
    get rootRel() { return claimed || base; },
    saved,
    save(rel) {
      const src = absIn(target, rel);
      if (!isFile(src)) return;
      const dst = absIn(target, `${claim()}/${rel}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      saved.push(rel);
    },
  };
}

/**
 * Make dstAbs an exact copy of srcAbs (copy missing/different files, delete extra files).
 * Every overwritten or deleted file is backed up first when a backup is given.
 * keepTop: names of top-level folders of dstAbs whose extra files are kept, never deleted.
 * Symlinks on either side are not copied or deleted; each is reported as {op:'symlink'}.
 * Returns the list of actions [{op, path, note?}] (path = dstRel/<file>).
 */
export function mirrorDir(srcAbs, dstAbs, { dstRel, dryRun = false, backup = null, keepTop = null } = {}) {
  if (!isDir(srcAbs)) throw new Error(`mirror source is missing: ${srcAbs}`); // never empty the mirror from a missing source
  const c = compareDirs(srcAbs, dstAbs);
  const actions = [];
  const missing = new Set(c.missing);
  for (const f of [...c.missing, ...c.different].sort(cmp)) {
    const rel = `${dstRel}/${f}`;
    actions.push({ op: missing.has(f) ? 'copy' : 'overwrite', path: rel });
    if (dryRun) continue;
    if (!missing.has(f) && backup) backup.save(rel);
    const d = absIn(dstAbs, f);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(absIn(srcAbs, f), d);
  }
  for (const f of c.extra) {
    const rel = `${dstRel}/${f}`;
    if (keepTop && keepTop.has(f.split('/')[0])) continue;
    actions.push({ op: 'delete', path: rel });
    if (dryRun) continue;
    if (backup) backup.save(rel);
    fs.unlinkSync(absIn(dstAbs, f));
  }
  for (const s of c.symlinks) {
    const side = s.startsWith('a/') ? 'source' : 'mirror';
    actions.push({ op: 'symlink', path: `${side === 'source' ? '(source)' : dstRel}/${s.slice(2)}`, note: 'symlinks are not mirrored on Windows — replace with a file' });
  }
  if (!dryRun && actions.some((a) => a.op !== 'symlink')) removeEmptyDirs(dstAbs, true);
  return actions;
}

// ---------------------------------------------------------------------------------------------
// docs repo block (install.mjs --docs-repo) — appended to AGENTS.md after the module sections
// ---------------------------------------------------------------------------------------------
export function docsRepoBlock(value) {
  return [
    DOCS_REPO_MARKER,
    '## מאגר התיעוד',
    '',
    `מסמכי הניהול של המוצר (יומן החלטות, שאלות פתוחות, משימות, מצב הפרויקט, מודל העבודה ההנדסי) נמצאים במאגר התיעוד: \`${value}\`. קוראים וכותבים אותם שם — לא יוצרים עותק כאן. החלטה שנוגעת במאגר הזה נרשמת ביומן של מאגר התיעוד עם שם המאגר.`,
    'כל הפניה ל-`docs/…` בקובץ הזה היא למאגר התיעוד.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// distributable zip (shared with build-bundle.mjs): what goes in, CRC-32, DOS time, reader
// ---------------------------------------------------------------------------------------------
const ZIP_SKIP_TOP = new Set(['dist']);                       // generated output — the zip itself lives here
const ZIP_SKIP_ANY = new Set(['.git', 'node_modules']);       // at any depth
const ZIP_SKIP_FILE = new Set(['.claude/settings.local.json']); // local tool state of a maintenance session
const ZIP_SKIP_NAME = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** The zip path of the current kit version: kit.json files.bundle with {version} filled. */
export function bundleRelFor(kit) {
  return String((kit && kit.files && kit.files.bundle) || DEFAULT_BUNDLE).split('{version}').join(String(kit && kit.version));
}

/**
 * Kit files that go into the zip — the whole kit folder except dist/, .git/, node_modules/ and local tool state.
 * Posix paths relative to the kit root, sorted. Symlinks are never followed (reported in opts.symlinks).
 */
export function kitZipFiles(kitRoot, opts = {}) {
  const out = [];
  const walk = (absDir, rel) => {
    for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { if (opts.symlinks) opts.symlinks.push(r); continue; }
      if (e.isDirectory()) {
        if (ZIP_SKIP_ANY.has(e.name) || (!rel && ZIP_SKIP_TOP.has(e.name))) continue;
        walk(path.join(absDir, e.name), r);
      } else if (e.isFile() && !ZIP_SKIP_NAME.has(e.name) && !ZIP_SKIP_FILE.has(r)) out.push(r);
    }
  };
  walk(kitRoot, '');
  return out.sort(cmp);
}

let CRC_TABLE = null;
export function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time of YYYY-MM-DD at 00:00:00 — the fixed timestamp of every zip entry (reproducible builds). */
export function dosDateTime(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
  if (!m) throw new Error(`kit.json "released" must be YYYY-MM-DD (got ${JSON.stringify(isoDate)})`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1980 || y > 2107 || mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`kit.json "released" is outside the zip date range: ${isoDate}`);
  return { date: ((y - 1980) << 9) | (mo << 5) | d, time: 0 };
}

/** A zip entry name that would extract outside the target folder (or that Windows cannot create). */
export function unsafeZipName(name) {
  return !name || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0')
    || name.split('/').some((p, i, a) => p === '..' || p === '.' || (p === '' && i < a.length - 1));
}

/**
 * Read a zip back and verify it: end record → central directory → every local header; each entry is inflated and
 * checked against its CRC-32 and size. Returns [{name, method, flags, date, time, crc, size, compSize, data}].
 * Throws on any structural problem. Supports stored/deflate, single disk, no ZIP64, no encryption.
 */
export function readZip(buf) {
  const SIG_END = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === SIG_END) { e = i; break; }
  if (e < 0) throw new Error('no end-of-central-directory record — not a zip, or truncated');
  const count = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOff = buf.readUInt32LE(e + 16);
  if (buf.readUInt16LE(e + 4) !== 0 || buf.readUInt16LE(e + 6) !== 0 || buf.readUInt16LE(e + 8) !== count) throw new Error('multi-disk zips are not supported');
  if (cdOff + cdSize > e) throw new Error('the central directory lies outside the file');
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOff + cdSize || buf.readUInt32LE(p) !== SIG_CEN) throw new Error(`central directory entry ${n + 1}: bad signature`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const enc = flags & 0x0800 ? 'utf8' : 'latin1';
    const name = buf.subarray(p + 46, p + 46 + nl).toString(enc);
    p += 46 + nl + xl + cl;
    if (flags & 0x0001) throw new Error(`${name}: encrypted entries are not supported`);
    if (lho + 30 > cdOff || buf.readUInt32LE(lho) !== SIG_LOC) throw new Error(`${name}: local header missing`);
    const lnl = buf.readUInt16LE(lho + 26), lxl = buf.readUInt16LE(lho + 28);
    const lname = buf.subarray(lho + 30, lho + 30 + lnl).toString(enc);
    if (lname !== name) throw new Error(`${name}: the local header names "${lname}"`);
    const start = lho + 30 + lnl + lxl;
    if (start + compSize > cdOff) throw new Error(`${name}: data runs past the central directory`);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) { try { data = zlib.inflateRawSync(raw); } catch (err) { throw new Error(`${name}: cannot inflate (${err.message})`); } }
    else throw new Error(`${name}: compression method ${method} is not supported`);
    if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, the header says ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 mismatch`);
    out.push({ name, method, flags, date, time, crc, size, compSize, data });
  }
  if (p !== cdOff + cdSize) throw new Error('the central directory size does not match its entries');
  return out;
}

// ---------------------------------------------------------------------------------------------
// frontmatter (minimal YAML: top-level `key: value` lines, quoted strings, block scalars, simple lists)
// ---------------------------------------------------------------------------------------------
function unquote(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    try { return JSON.parse(v); } catch { return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const RE_FM_KEY = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*?))?[ \t]*$/;
const RE_FM_NESTED_KEY = /^[ \t]+[A-Za-z0-9_.-]+:(?:[ \t]|$)/;
const RE_FM_BLOCK = /^[|>][1-9+-]{0,2}(?:[ \t]+#.*)?$/;

/** YAML line folding of a plain (or quoted) multi-line scalar: line breaks → one space, each empty line → "\n". */
function foldLines(lines) {
  let out = '';
  let breaks = 0;
  for (const l of lines.map((x) => x.trim())) {
    if (l === '') { breaks++; continue; }
    out = out === '' ? l : `${out}${breaks ? '\n'.repeat(breaks) : ' '}${l}`;
    breaks = 0;
  }
  return out;
}

/** A plain scalar line ends at a YAML comment (" #…"). */
function plainLine(l) { const k = l.search(/[ \t]#/); return (k < 0 ? l : l.slice(0, k)).trim(); }

function scalarValue(raw, cont) {
  if (RE_FM_BLOCK.test(raw)) {
    const items = cont.map((l) => l.trim());
    return raw[0] === '|' ? items.join('\n') : items.filter(Boolean).join(' ');
  }
  if (raw === '') {
    const nonEmpty = cont.filter((l) => l.trim() !== '');
    if (!nonEmpty.length) return '';
    // the first line decides, as in YAML: "- " → list, "key:" → nested map, otherwise a (quoted or plain) scalar
    const list = nonEmpty.map((l) => l.trim()).filter((l) => l.startsWith('- '));
    if (list.length && list.length === nonEmpty.length) return list.map((l) => unquote(l.slice(2).trim())).join(', ');
    if (/^-( |$)/.test(nonEmpty[0].trim()) || RE_FM_NESTED_KEY.test(nonEmpty[0])) return { nested: true };
    const q = nonEmpty[0].trim()[0];
    if (q === '"' || q === "'") return unquote(foldLines(nonEmpty)); // quoted scalar on the next line
    return foldLines(cont.map(plainLine)); // plain multi-line scalar starting on the next line
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean).join(', ');
  }
  if (raw[0] === '"' || raw[0] === "'") return unquote(cont.length ? foldLines([raw, ...cont]) : raw);
  return cont.length ? foldLines([raw, ...cont].map(plainLine)) : plainLine(raw);
}

/**
 * Strictness gate for the frontmatter: flags what real YAML parsers (Claude Code, Codex) reject or read differently
 * from parseFrontmatter. For every top-level key whose value is an unquoted plain scalar: no ": " / " #", no TAB,
 * no trailing ":", and no YAML indicator as the first character. Quoted values must close properly; block (| >)
 * values and a [a, b] flow list on `tools` are accepted; nested maps and "- " lists are not linted.
 * Returns problem strings (empty = clean). parseFrontmatter reports a missing/unclosed block itself.
 */
export function lintFrontmatter(text) {
  const lines = normalizeEol(stripBom(text)).split('\n');
  if (lines[0].trim() !== '---') return [];
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return [];
  const problems = [];
  const seen = new Set();
  let i = 1;
  while (i < end) {
    const lineNo = i + 1;
    const line = lines[i];
    const m = RE_FM_KEY.exec(line);
    i++;
    if (!m) {
      if (!/^[ \t]/.test(line) && line.trim() !== '' && !line.trim().startsWith('#')) problems.push(`line ${lineNo}: not a "key: value" line ("${line.trim().slice(0, 40)}") — ${FM_FIX}`);
      continue;
    }
    const key = m[1];
    if (seen.has(key)) problems.push(`line ${lineNo}: duplicate key "${key}"`);
    seen.add(key);
    const cont = [];
    while (i < end && (/^[ \t]/.test(lines[i]) || lines[i].trim() === '')) { cont.push(lines[i]); i++; }
    while (cont.length && cont[cont.length - 1].trim() === '') cont.pop();
    let raw = m[2] === undefined ? '' : m[2];
    const at = `"${key}" (line ${lineNo})`;
    if (raw === '' && cont.length && /^["']/.test(cont.find((l) => l.trim() !== '').trim())) { // quoted scalar on the next line
      raw = cont.filter((l) => l.trim() !== '').map((l) => l.trim()).join(' ');
      cont.length = 0;
    }
    if (RE_FM_BLOCK.test(raw)) continue;                                   // | or > block scalar
    if (raw[0] === '"' || raw[0] === "'") {                                // quoted scalar, maybe multi-line
      const joined = cont.length ? [raw, ...cont.map((l) => l.trim())].join(' ') : raw;
      const ok = raw[0] === '"' ? /^"(?:[^"\\]|\\.)*"(?:[ \t]+#.*)?$/.test(joined) : /^'(?:[^']|'')*'(?:[ \t]+#.*)?$/.test(joined);
      if (!ok) problems.push(`${at}: quoted value is not closed properly (or has text after the closing quote) — ${FM_FIX}`);
      continue;
    }
    if (key === 'tools' && raw.startsWith('[')) {                          // tools: [Read, Glob, Grep]
      if (!/^\[[^[\]{}]*\]$/.test(raw) || cont.length) problems.push(`${at}: flow list must be one line "[a, b]"`);
      continue;
    }
    let plain = [raw, ...cont.map((l) => l.trim())];
    if (raw === '') {
      const nonEmpty = cont.filter((l) => l.trim() !== '');
      if (!nonEmpty.length) continue;                                      // empty value
      if (/^-( |$)/.test(nonEmpty[0].trim()) || RE_FM_NESTED_KEY.test(nonEmpty[0])) continue; // list / nested map (first line decides)
      plain = nonEmpty.map((l) => l.trim());
    }
    const first = plain.find((l) => l !== '') || '';
    const why = [];
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(first)) why.push(`starts with "${first[0]}"`);
    if (plain.some((l) => l.includes(': '))) why.push('contains ": "');
    if (plain.some((l) => /:$/.test(l))) why.push('ends a line with ":"');
    if (plain.some((l) => / #/.test(l))) why.push('contains " #" (YAML reads the rest as a comment)');
    if ([raw, ...cont].some((l) => l.includes('\t'))) why.push('contains a TAB');
    if (why.length) problems.push(`${at}: plain value ${why.join(', ')} — ${FM_FIX}`);
  }
  return problems;
}

export function parseFrontmatter(text) {
  const t = normalizeEol(stripBom(text));
  const lines = t.split('\n');
  if (lines[0].trim() !== '---') return { ok: false, data: {}, body: t, error: 'no frontmatter (first line must be ---)' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return { ok: false, data: {}, body: t, error: 'frontmatter is not closed (missing ---)' };
  const data = {};
  let i = 1;
  while (i < end) {
    const m = RE_FM_KEY.exec(lines[i]);
    i++;
    if (!m) continue;
    const cont = [];
    while (i < end && (/^[ \t]/.test(lines[i]) || lines[i].trim() === '')) { cont.push(lines[i]); i++; }
    while (cont.length && cont[cont.length - 1].trim() === '') cont.pop();
    data[m[1]] = scalarValue(m[2] === undefined ? '' : m[2], cont);
  }
  return { ok: true, data, body: lines.slice(end + 1).join('\n') };
}

function str(v) { return typeof v === 'string' ? v : ''; }

export function toolList(v) { return str(v).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean); }

// ---------------------------------------------------------------------------------------------
// TOML generation for Codex custom agents (.codex/agents/<name>.toml)
// ---------------------------------------------------------------------------------------------
function hex4(c) { return c.toString(16).toUpperCase().padStart(4, '0'); }

export function tomlBasicString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u${hex4(c)}`;
    else out += ch;
  }
  return `${out}"`;
}

function tomlMultilineString(body) {
  // body always ends with "\n", so the closing delimiter sits on its own line.
  const literalOk = !body.includes("'''") && !/[\u0000-\u0008\u000B-\u001F\u007F]/.test(body);
  if (literalOk) return `'''\n${body}'''`;
  let out = '';
  for (const ch of body) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n' || ch === '\t') out += ch;
    else if (c < 0x20 || c === 0x7f) out += `\\u${hex4(c)}`;
    else out += ch;
  }
  return `"""\n${out}"""`;
}

export function agentBaseName(file) { return path.basename(String(file)).replace(/\.md$/i, ''); }

/** The developer_instructions text: Markdown body after the frontmatter, LF, no leading blank lines, one final newline. */
export function agentBody(text) {
  const fm = parseFrontmatter(text);
  return `${normalizeEol(fm.body).replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

/**
 * Generate the Codex TOML for one agent source file. sourceRel is the project-relative posix path of the
 * canonical .md (e.g. ".claude/agents/qa.md"). The output is byte-identical wherever it is generated.
 * Claude-only frontmatter keys (tools, model) are not carried over: Codex model names differ, and Codex
 * cannot restrict a custom agent's tools — write exclusivity in Codex is by instruction only.
 */
export function generateToml(sourceRel, text) {
  const fm = parseFrontmatter(text);
  const name = str(fm.data.name) || agentBaseName(sourceRel);
  const description = str(fm.data.description);
  return [
    `${GENERATED_PREFIX}${sourceRel} — do not edit; run: node .kit/check.mjs --fix`,
    `name = ${tomlBasicString(name)}`,
    `description = ${tomlBasicString(description)}`,
    `developer_instructions = ${tomlMultilineString(agentBody(text))}`,
  ].join('\n') + '\n';
}

/** Minimal reader for the TOML this file generates (used by self-tests). Returns {name, description, developer_instructions}. */
export function parseGeneratedToml(toml) {
  const t = normalizeEol(toml);
  const out = {};
  let i = 0;
  const readBasic = () => { // at opening quote
    let s = ''; i++;
    while (i < t.length && t[i] !== '"') {
      if (t[i] === '\\') { s += unescapeAt(); continue; }
      s += t[i++];
    }
    i++; return s;
  };
  const unescapeAt = () => {
    const n = t[i + 1];
    const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
    if (n in map) { i += 2; return map[n]; }
    if (n === 'u') { const c = parseInt(t.slice(i + 2, i + 6), 16); i += 6; return String.fromCodePoint(c); }
    if (n === 'U') { const c = parseInt(t.slice(i + 2, i + 10), 16); i += 10; return String.fromCodePoint(c); }
    throw new Error(`bad escape at ${i}`);
  };
  while (i < t.length) {
    if (t[i] === '#') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (t[i] === '\n' || t[i] === ' ') { i++; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*) = /.exec(t.slice(i));
    if (!m) throw new Error(`unexpected text at ${i}`);
    const key = m[1]; i += m[0].length;
    if (t.startsWith("'''", i)) {
      i += 3; if (t[i] === '\n') i++;
      const end = t.indexOf("'''", i); if (end < 0) throw new Error('unterminated literal string');
      out[key] = t.slice(i, end); i = end + 3;
    } else if (t.startsWith('"""', i)) {
      i += 3; if (t[i] === '\n') i++;
      let s = '';
      while (i < t.length && !t.startsWith('"""', i)) {
        if (t[i] === '\\') { s += unescapeAt(); continue; }
        s += t[i++];
      }
      if (i >= t.length) throw new Error('unterminated multi-line string');
      out[key] = s; i += 3;
    } else if (t[i] === '"') {
      out[key] = readBasic();
    } else throw new Error(`unsupported value for ${key}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// project layout helpers (shared with install.mjs)
// ---------------------------------------------------------------------------------------------
export function agentSourceDirRel(tools) { return tools.includes('claude') ? '.claude/agents' : '.kit/agents-src'; }
export function canonicalSkillsDirRel(tools) { return tools.includes('claude') ? '.claude/skills' : '.agents/skills'; }

/** Read agent sources from a project dir: [{base, rel, text}] */
export function readAgentSources(target, srcRel) {
  return listMd(absIn(target, srcRel)).map((f) => ({ base: agentBaseName(f), rel: `${srcRel}/${f}`, text: readText(absIn(target, `${srcRel}/${f}`)) }));
}

function isGeneratedToml(p) {
  try { return normalizeEol(readText(p)).startsWith(GENERATED_PREFIX); } catch { return false; }
}

/**
 * The agent sources that become Codex custom agents: all except the main agent. agent-manager is the session itself
 * (AGENTS.md §1: it is never spawned as a subagent), so it gets no .codex/agents/agent-manager.toml — the Codex
 * session reads its role file from the agent sources instead.
 */
export function codexAgentSources(sources) { return sources.filter((s) => s.base !== MANAGER_AGENT); }
const MANAGER_TOML_NOTE = 'the main agent is the session itself — no Codex custom agent';

/**
 * Bring .codex/agents in line with the agent sources: write missing/outdated TOML, delete orphan GENERATED TOML
 * (including a generated agent-manager.toml from an earlier kit version).
 * TOML files without the GENERATED header and without a matching source belong to the project and are left alone.
 * Returns actions [{op, path, note?}].
 */
export function syncCodexAgents(target, sources, { dryRun = false, backup = null } = {}) {
  const actions = [];
  const dirRel = '.codex/agents';
  const dirAbs = absIn(target, dirRel);
  const wanted = new Set();
  for (const s of codexAgentSources(sources)) {
    const rel = `${dirRel}/${s.base}.toml`;
    wanted.add(`${s.base}.toml`);
    const want = generateToml(s.rel, s.text);
    const p = absIn(target, rel);
    const exists = isFile(p);
    if (exists && normalizeEol(readText(p)) === want) continue;
    actions.push({ op: exists ? 'overwrite' : 'create', path: rel });
    if (dryRun) continue;
    if (exists && backup) backup.save(rel);
    fs.mkdirSync(dirAbs, { recursive: true });
    fs.writeFileSync(p, want, 'utf8');
  }
  if (isDir(dirAbs)) {
    for (const f of fs.readdirSync(dirAbs).filter((x) => /\.toml$/i.test(x)).sort(cmp)) {
      if (wanted.has(f)) continue;
      const rel = `${dirRel}/${f}`;
      if (!isGeneratedToml(absIn(target, rel))) { actions.push({ op: 'keep', path: rel, note: 'not generated by the kit — left alone' }); continue; }
      actions.push({ op: 'delete', path: rel, note: f === `${MANAGER_AGENT}.toml` ? MANAGER_TOML_NOTE : 'orphan (no agent source)' });
      if (dryRun) continue;
      if (backup) backup.save(rel);
      fs.unlinkSync(absIn(target, rel));
    }
  }
  return actions;
}

/** AGENTS.md = core + "\n\n" + each module section (trailing whitespace trimmed, one final newline). */
export function composeAgentsMd(coreText, sectionTexts = []) {
  const parts = [coreText, ...sectionTexts].map((s) => normalizeEol(stripBom(s)).replace(/\s+$/, ''));
  return `${parts.join('\n\n')}\n`;
}

export function findPlaceholders(text, re) {
  const hits = [];
  const lines = normalizeEol(text).split('\n');
  lines.forEach((line, idx) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) hits.push({ line: idx + 1, token: m[0], name: m[1] });
  });
  return hits;
}

function countDeferred(text) {
  return normalizeEol(text).split('\n').filter((l) => l.includes(DEFERRED_MARKER)).length;
}

// ---------------------------------------------------------------------------------------------
// result collector / printer
// ---------------------------------------------------------------------------------------------
class Results {
  constructor() { this.items = []; }
  add(status, id, title, msg, details = []) { this.items.push({ status, id, title, msg, details }); }
  get failed() { return this.items.filter((x) => x.status === 'FAIL').length; }
  get warned() { return this.items.filter((x) => x.status === 'WARN').length; }
  print(maxDetails = 15) {
    for (const it of this.items) {
      console.log(`${it.status.padEnd(4)}  [${it.id}] ${it.title} — ${it.msg}`);
      const d = it.details || [];
      for (const line of d.slice(0, maxDetails)) console.log(`        - ${line}`);
      if (d.length > maxDetails) console.log(`        … and ${d.length - maxDetails} more`);
    }
    console.log('');
    console.log(`נכשלו: ${this.failed} · אזהרות: ${this.warned}   (failed: ${this.failed} · warnings: ${this.warned})`);
  }
}

// ---------------------------------------------------------------------------------------------
// frontmatter validation (shared by project and kit modes)
// ---------------------------------------------------------------------------------------------
/** BOM + YAML-strictness problems of one frontmatter file, prefixed with its path. */
function frontmatterTextProblems(raw, relPath) {
  const p = [];
  if (raw.charCodeAt(0) === 0xfeff) p.push(`${relPath}: ${BOM_MSG} (a BOM before "---" can hide the frontmatter)`);
  for (const l of lintFrontmatter(raw)) p.push(`${relPath}: frontmatter ${l}`);
  return p;
}

/** Tools of a professional agent that are outside the read-only allowlist. */
export function nonReadOnlyTools(toolsValue) { return toolList(toolsValue).filter((t) => !READ_ONLY_TOOLS.includes(t)); }

/** Allowlist tools a professional agent lacks (it cannot read the project without them). */
export function missingReadOnlyTools(toolsValue) { const t = toolList(toolsValue); return READ_ONLY_TOOLS.filter((x) => !t.includes(x)); }

/** One clear line for a professional agent that holds tools outside Read, Glob, Grep. */
export function extraToolsProblem(rel, bad) {
  const net = bad.filter((t) => NETWORK_TOOLS.has(t));
  const state = bad.filter((t) => !NETWORK_TOOLS.has(t));
  const why = [];
  if (state.length) why.push(`${state.join(' / ')} can modify state`);
  if (net.length) why.push(`${net.join(' / ')} reach${net.length === 1 ? 'es' : ''} the network`);
  return `${rel}: professional agent holds ${bad.join(' / ')} — ${why.join('; ')}. Professional agents hold exactly ${READ_ONLY_TOOLS.join(', ')} (AGENTS.md) and only analyze and recommend — remove ${bad.length === 1 ? 'it' : 'them'} from its tools line`;
}

// ---------------------------------------------------------------------------------------------
// constitution structure: install.mjs records it in .kit/kit.config.json (agentsStructure); project check [10]
// verifies that the AGENTS.md the project merged still has every kit heading and block marker
// ---------------------------------------------------------------------------------------------
const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const RE_STRUCT_MARKER = /^<!-- (?:module:[A-Za-z0-9_-]+|docs-repo) -->$/;

/** Lines of a Markdown text outside fenced code blocks (``` / ~~~), trailing whitespace trimmed. */
function linesOutsideFences(text) {
  const out = [];
  let fence = null;
  for (const raw of normalizeEol(stripBom(String(text))).split('\n')) {
    const l = raw.replace(/\s+$/, '');
    const m = RE_FENCE_OPEN.exec(l);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && l.trim() === m[1]) fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && l.slice(l.indexOf(m[1]) + m[1].length).includes('`'))) { fence = m[1]; continue; }
    out.push(l);
  }
  return out;
}

/** A `## ` (level-2 ATX) heading in its normal form "## <text>" (inner whitespace collapsed), or null. */
export function normalizeH2(line) {
  const m = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(String(line));
  return m ? `## ${m[1].replace(/\s+/g, ' ').trim()}` : null;
}

/** The `## ` headings of a Markdown text, outside code fences, in order. */
export function h2Headings(text) { return linesOutsideFences(text).map(normalizeH2).filter(Boolean); }

/** The block markers (<!-- module:<m> -->, <!-- docs-repo -->) on their own line, outside code fences. */
export function structureMarkers(text) { return linesOutsideFences(text).map((l) => l.trim()).filter((l) => RE_STRUCT_MARKER.test(l)); }

/** What install.mjs records as agentsStructure: the `## ` headings of the core constitution + the markers of the blocks it added. */
export function agentsStructureOf(coreText, markers = []) {
  return { headings: [...new Set(h2Headings(coreText))], markers: [...new Set(markers)] };
}

/** The `## ` heading that opens each marked block: the first one after a marker line, with only blank lines between. */
export function blockHeadings(text) {
  const out = [];
  let afterMarker = false;
  for (const l of linesOutsideFences(text)) {
    if (RE_STRUCT_MARKER.test(l.trim())) { afterMarker = true; continue; }
    if (!afterMarker || l.trim() === '') continue;
    const h = normalizeH2(l);
    if (h) out.push(h);
    afterMarker = false;
  }
  return out;
}

/** Recorded headings/markers that AGENTS.md no longer has (order is free; extra project sections are allowed). */
export function missingStructure(agentsText, structure) {
  const haveH = new Set(h2Headings(agentsText));
  const haveM = new Set(structureMarkers(agentsText));
  const headings = (structure.headings || []).filter((h) => !haveH.has(normalizeH2(h) || String(h).trim()));
  const markers = (structure.markers || []).filter((m) => !haveM.has(String(m).trim()));
  return { headings, markers };
}

function validateAgentFile(absPath, relPath, { requireTools }) {
  const problems = [];
  let fm;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    problems.push(...frontmatterTextProblems(raw, relPath));
    fm = parseFrontmatter(raw);
  } catch (e) { return { problems: [`${relPath}: cannot read (${e.message})`], fm: null }; }
  if (!fm.ok) return { problems: [...problems, `${relPath}: ${fm.error}`], fm };
  const base = agentBaseName(relPath);
  if (!str(fm.data.name)) problems.push(`${relPath}: missing name`);
  else if (fm.data.name !== base) problems.push(`${relPath}: name "${str(fm.data.name)}" ≠ file name "${base}"`);
  if (!str(fm.data.description).trim()) problems.push(`${relPath}: missing description`);
  if (requireTools && !str(fm.data.tools).trim()) problems.push(`${relPath}: missing tools (required for Claude Code)`);
  return { problems, fm };
}

function validateSkillDir(absDir, relDir) {
  const name = path.basename(absDir);
  const skillFile = path.join(absDir, 'SKILL.md');
  if (!isFile(skillFile)) return [`${relDir}: SKILL.md missing`];
  let fm;
  const problems = [];
  try {
    const raw = fs.readFileSync(skillFile, 'utf8');
    problems.push(...frontmatterTextProblems(raw, `${relDir}/SKILL.md`));
    fm = parseFrontmatter(raw);
  } catch (e) { return [`${relDir}/SKILL.md: cannot read (${e.message})`]; }
  if (!fm.ok) return [...problems, `${relDir}/SKILL.md: ${fm.error}`];
  if (!str(fm.data.name)) problems.push(`${relDir}/SKILL.md: missing name`);
  else if (fm.data.name !== name) problems.push(`${relDir}/SKILL.md: name "${str(fm.data.name)}" ≠ folder "${name}"`);
  if (!str(fm.data.description).trim()) problems.push(`${relDir}/SKILL.md: missing description`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// project mode
// ---------------------------------------------------------------------------------------------
function loadProjectConfig(target) {
  const p = absIn(target, '.kit/kit.config.json');
  if (!isFile(p)) return { config: null, error: '.kit/kit.config.json not found' };
  try { return { config: readJson(p), error: null }; } catch (e) { return { config: null, error: `.kit/kit.config.json is not valid JSON (${e.message})` }; }
}

function inferTools(target) {
  const t = [];
  if (isDir(absIn(target, '.claude/agents')) || isFile(absIn(target, 'CLAUDE.md'))) t.push('claude');
  if (isDir(absIn(target, '.codex/agents')) || isDir(absIn(target, '.agents/skills'))) t.push('codex');
  return t;
}

function fmtAction(a) { return `${a.op.padEnd(9)} ${a.path}${a.note ? `  (${a.note})` : ''}`; }

export function runProjectChecks(target, { fix = false, log = console.log } = {}) {
  const R = new Results();
  const { config, error: cfgError } = loadProjectConfig(target);
  const cfgTools = config && Array.isArray(config.tools) ? config.tools.filter((x) => x === 'claude' || x === 'codex') : null;
  const tools = cfgTools && cfgTools.length ? cfgTools : inferTools(target);
  const hasClaude = tools.includes('claude');
  const hasCodex = tools.includes('codex');
  const srcRel = agentSourceDirRel(tools);
  // multi-repo project: this is a code repo; the management docs live in the docs repo (install.mjs --docs-repo)
  const docsRepo = config && typeof config.docsRepo === 'string' && config.docsRepo.trim() ? config.docsRepo.trim() : null;
  // skill folders that exist only in the mirror (added the Codex way): never deleted by --fix, reported by [4]
  const codexOnlySkills = () => {
    if (!(hasClaude && hasCodex)) return [];
    const canon = new Set(listSubdirs(absIn(target, '.claude/skills')));
    return listSubdirs(absIn(target, '.agents/skills')).filter((s) => !canon.has(s));
  };

  // ---- --fix ----
  if (fix) {
    const backup = makeBackup(target);
    const actions = [];
    const errors = [];
    if (hasCodex) {
      if (isDir(absIn(target, srcRel))) actions.push(...syncCodexAgents(target, readAgentSources(target, srcRel), { backup }));
      else errors.push(`cannot regenerate TOML: ${srcRel} is missing`);
    }
    if (hasClaude && hasCodex) {
      if (isDir(absIn(target, '.claude/skills'))) {
        const keep = codexOnlySkills();
        for (const s of keep) actions.push({ op: 'keep', path: `.agents/skills/${s}/`, note: 'exists only in .agents/skills — move it to .claude/skills (canonical) and run --fix again' });
        actions.push(...mirrorDir(absIn(target, '.claude/skills'), absIn(target, '.agents/skills'), { dstRel: '.agents/skills', backup, keepTop: new Set(keep) }));
      } else errors.push('cannot mirror skills: .claude/skills is missing');
    }
    log(`--fix: ${actions.filter((a) => a.op !== 'keep' && a.op !== 'symlink').length} change(s)${backup.saved.length ? ` · backup: ${backup.rootRel}/ (${backup.saved.length} file(s))` : ''}`);
    for (const a of actions) log(`  ${fmtAction(a)}`);
    for (const e of errors) log(`  ERROR    ${e}`);
    if (!hasCodex) log('  (codex not installed — nothing to regenerate or mirror)');
    log('');
  }

  // ---- [1] placeholders ----
  {
    const files = [];
    for (const f of ['AGENTS.md', 'CLAUDE.md']) if (isFile(absIn(target, f))) files.push(f);
    // a code repo's own docs/ (if any) is not the kit's: with a docs repo it is not scanned
    if (!docsRepo) for (const f of listFiles(absIn(target, 'docs'))) if (/\.md$/i.test(f)) files.push(`docs/${f}`);
    for (const d of ['.claude/agents', '.kit/agents-src']) for (const f of listMd(absIn(target, d))) files.push(`${d}/${f}`);
    const docsNote = docsRepo ? ` · docs/: ${DOCS_NA}` : '';
    // only the kit's own placeholder names count as leftovers (recorded by install.mjs); a project doc may legitimately
    // show {{SOMETHING}} (e.g. a template example). Without the list (older config) every {{UPPER}} token counts.
    const kitNames = config && Array.isArray(config.placeholders) && config.placeholders.length ? new Set(config.placeholders) : null;
    const hits = [];
    const other = [];
    let deferred = 0;
    try {
      for (const f of files) {
        const text = readText(absIn(target, f));
        deferred += countDeferred(text);
        for (const h of findPlaceholders(text, RE_PH_UPPER)) (!kitNames || kitNames.has(h.name) ? hits : other).push(`${f}:${h.line}  ${h.token}`);
      }
      const otherNote = other.length ? ` · ${other.length} other {{…}} token(s) are the project's own text (not kit placeholders) — ignored` : '';
      if (!files.length) R.add('FAIL', 1, 'placeholders', 'no instruction or docs files found to scan');
      else if (hits.length) R.add('FAIL', 1, 'placeholders', `${hits.length} kit placeholder(s) left — fill them (values.json) or turn them into "${DEFERRED_MARKER}" lines${kitNames ? '' : ' (.kit/kit.config.json has no "placeholders" list, so every {{UPPER}} token counts)'}${otherNote}`, [...hits, ...other.map((x) => `not a kit placeholder (ignored): ${x}`)]);
      else R.add('PASS', 1, 'placeholders', `no kit placeholder left in ${files.length} file(s) · deferred "${DEFERRED_MARKER}" lines: ${deferred}${otherNote}${docsNote}`, other.map((x) => `not a kit placeholder (ignored): ${x}`));
    } catch (e) { R.add('FAIL', 1, 'placeholders', `could not scan: ${e.message}`); }
  }

  // ---- [2] instruction files ----
  {
    const problems = [];
    const warns = [];
    let level = null;
    const ap = absIn(target, 'AGENTS.md');
    try {
      if (!isFile(ap)) problems.push('AGENTS.md missing');
      else {
        const n = fs.statSync(ap).size;
        if (n > CODEX_DOC_HARD_LIMIT) problems.push(`AGENTS.md is ${n} bytes > ${CODEX_DOC_HARD_LIMIT} (Codex silently drops the rest) — move detail into docs/`);
        else if (n > AGENTS_SOFT_LIMIT) warns.push(`AGENTS.md is ${n} bytes > ${AGENTS_SOFT_LIMIT} budget (hard cap ${CODEX_DOC_HARD_LIMIT})`);
        if (hasBom(ap)) warns.push(`AGENTS.md ${BOM_MSG}`);
        // the autonomy switch: exactly one line, one of the three levels (spec §3.4)
        const lines = normalizeEol(readText(ap)).split('\n').map((l) => l.replace(/\s+$/, ''));
        const good = lines.filter((l) => RE_AUTONOMY_LINE.test(l));
        const any = lines.filter((l) => RE_AUTONOMY_ANY.test(l));
        if (good.length === 1 && any.length === 1) level = RE_AUTONOMY_LINE.exec(good[0])[1];
        else if (!any.length) problems.push(`AGENTS.md has no autonomy line — expected exactly one line: **רמת העצמאות הנוכחית:** \`strict|balanced|autonomous\``);
        else if (any.length > 1) problems.push(`AGENTS.md has ${any.length} autonomy lines — keep exactly one (**רמת העצמאות הנוכחית:** …)`, ...any);
        else problems.push(`AGENTS.md autonomy line is "${any[0]}" — the level must be exactly one of: ${AUTONOMY_LEVELS.join(' | ')}, alone on its line`);
      }
      const sp = absIn(target, 'docs/project-status.md');
      if (level && !docsRepo && isFile(sp)) { // with a docs repo, the mirror line lives there
        const mirror = normalizeEol(readText(sp)).split('\n').map((l) => RE_AUTONOMY_ANY.exec(l)).find(Boolean);
        if (mirror && mirror[1] !== level) warns.push(`docs/project-status.md shows autonomy "${mirror[1]}" but AGENTS.md says "${level}" — AGENTS.md wins; align the mirror line`);
      }
      if (hasClaude) {
        const cp = absIn(target, 'CLAUDE.md');
        if (!isFile(cp)) problems.push('CLAUDE.md missing (Claude Code needs it; first line must be @AGENTS.md)');
        else {
          const raw = fs.readFileSync(cp, 'utf8'); // raw: a BOM must not hide in front of the import
          if (raw.charCodeAt(0) === 0xfeff) problems.push(`CLAUDE.md ${BOM_MSG} (the @AGENTS.md import must be the very first bytes)`);
          else {
            const first = normalizeEol(raw).split('\n')[0].trim();
            if (first !== '@AGENTS.md') problems.push(`CLAUDE.md first line is "${first}" — must be exactly @AGENTS.md`);
          }
        }
      }
      const size = isFile(ap) ? `${fs.statSync(ap).size} bytes` : '';
      if (problems.length) R.add('FAIL', 2, 'instruction files', problems[0], [...problems.slice(1), ...warns]);
      else if (warns.length) R.add('WARN', 2, 'instruction files', warns[0], warns.slice(1));
      else R.add('PASS', 2, 'instruction files', `AGENTS.md ${size} (≤ ${AGENTS_SOFT_LIMIT}) · autonomy: ${level}${hasClaude ? ' · CLAUDE.md imports @AGENTS.md' : ''}`);
    } catch (e) { R.add('FAIL', 2, 'instruction files', `could not check: ${e.message}`); }
  }

  // ---- [3] codex agents ----
  {
    const tomlDir = absIn(target, '.codex/agents');
    if (hasCodex) {
      if (!isDir(absIn(target, srcRel))) R.add('FAIL', 3, 'codex agents', `agent sources missing: ${srcRel}`);
      else {
        try {
          const all = readAgentSources(target, srcRel);
          const sources = codexAgentSources(all); // agent-manager is the session itself — no TOML
          const problems = [];
          const notes = [];
          const names = new Set();
          for (const s of sources) {
            names.add(`${s.base}.toml`);
            const rel = `.codex/agents/${s.base}.toml`;
            const p = absIn(target, rel);
            if (!isFile(p)) problems.push(`missing ${rel} (source ${s.rel})`);
            else if (normalizeEol(readText(p)) !== generateToml(s.rel, s.text)) problems.push(`out of date ${rel} (source ${s.rel})`);
          }
          if (isDir(tomlDir)) {
            for (const f of fs.readdirSync(tomlDir).filter((x) => /\.toml$/i.test(x)).sort(cmp)) {
              if (names.has(f)) continue;
              const generated = isGeneratedToml(path.join(tomlDir, f));
              if (generated && f === `${MANAGER_AGENT}.toml`) problems.push(`.codex/agents/${f} — ${MANAGER_TOML_NOTE}; --fix removes it (with a backup)`);
              else if (generated) problems.push(`orphan .codex/agents/${f} (no source in ${srcRel})`);
              else notes.push(`.codex/agents/${f} is not managed by the kit (no GENERATED header)`);
            }
          }
          const mgr = all.length !== sources.length ? ` (+ ${MANAGER_AGENT}: no TOML — the session itself)` : '';
          if (!sources.length) R.add('FAIL', 3, 'codex agents', `no agent sources in ${srcRel}${mgr ? ` besides ${MANAGER_AGENT}` : ''}`);
          else if (problems.length) R.add('FAIL', 3, 'codex agents', `${problems.length} TOML problem(s) — run: node .kit/check.mjs --fix`, [...problems, ...notes]);
          else R.add('PASS', 3, 'codex agents', `${sources.length} TOML file(s) match ${srcRel}${mgr}${notes.length ? ` · ${notes.length} unmanaged TOML left alone` : ''}`, notes);
        } catch (e) { R.add('FAIL', 3, 'codex agents', `could not verify: ${e.message}`); }
      }
    } else {
      const stray = isDir(tomlDir) ? fs.readdirSync(tomlDir).filter((x) => /\.toml$/i.test(x) && isGeneratedToml(path.join(tomlDir, x))) : [];
      if (stray.length) R.add('WARN', 3, 'codex agents', `codex is not in kit.config.json tools, but ${stray.length} generated TOML file(s) exist`, stray.map((x) => `.codex/agents/${x}`));
      else R.add('PASS', 3, 'codex agents', 'codex not installed · no generated TOML files present');
    }
  }

  // ---- [4] skills ----
  {
    const c = absIn(target, '.claude/skills');
    const x = absIn(target, '.agents/skills');
    try {
      if (hasClaude && hasCodex) {
        if (!isDir(c)) R.add('FAIL', 4, 'skills mirror', '.claude/skills missing');
        else if (!isDir(x)) R.add('FAIL', 4, 'skills mirror', '.agents/skills missing — run: node .kit/check.mjs --fix');
        else {
          const d = compareDirs(c, x);
          const only = new Set(codexOnlySkills());
          const extraTop = (f) => only.has(f.split('/')[0]);
          const links = d.symlinks.map((s) => `symlink ${s.startsWith('a/') ? '.claude/skills' : '.agents/skills'}/${s.slice(2)} — symlinks are not mirrored on Windows — replace with a file`);
          if (d.same) R.add('PASS', 4, 'skills mirror', `.claude/skills ≡ .agents/skills (${listFiles(c).length} files, sha256)`);
          else if (only.size || links.length) R.add('FAIL', 4, 'skills mirror', [
            ...[...only].map((s) => `skill ${s} exists only in .agents/skills — move it to .claude/skills (canonical) and run --fix again`),
            ...(links.length ? [`${links.length} symlink(s) — symlinks are not mirrored on Windows — replace with a file`] : []),
          ][0], [
            ...[...only].slice(1).map((s) => `skill ${s} exists only in .agents/skills — move it to .claude/skills (canonical) and run --fix again`),
            ...links,
            ...d.missing.map((f) => `missing in .agents/skills: ${f}`),
            ...d.different.map((f) => `different: ${f}`),
            ...d.extra.filter((f) => !extraTop(f)).map((f) => `extra in .agents/skills: ${f}`),
          ]);
          else R.add('FAIL', 4, 'skills mirror', '.agents/skills differs from .claude/skills — run: node .kit/check.mjs --fix', [
            ...d.missing.map((f) => `missing in .agents/skills: ${f}`),
            ...d.different.map((f) => `different: ${f}`),
            ...d.extra.map((f) => `extra in .agents/skills: ${f}`),
          ]);
        }
      } else if (hasClaude || hasCodex) {
        const rel = hasClaude ? '.claude/skills' : '.agents/skills';
        const n = listSubdirs(absIn(target, rel)).length;
        const links = [];
        listFiles(absIn(target, rel), { symlinks: links });
        if (!n) R.add('FAIL', 4, 'skills', `${rel} missing or empty`);
        else if (links.length) R.add('FAIL', 4, 'skills', `${links.length} symlink(s) in ${rel} — symlinks are not mirrored on Windows — replace with a file`, links.map((l) => `${rel}/${l}`));
        else R.add('PASS', 4, 'skills', `${rel}: ${n} skill folder(s) (single tool — no mirror needed)`);
      } else R.add('FAIL', 4, 'skills', 'cannot tell which tools are installed (no kit.config.json, no .claude/.codex folders)');
    } catch (e) { R.add('FAIL', 4, 'skills', `could not compare: ${e.message}`); }
  }

  // ---- [5] frontmatter ----
  {
    const problems = [];
    let agents = 0, skills = 0;
    try {
      for (const d of ['.claude/agents', '.kit/agents-src']) {
        for (const f of listMd(absIn(target, d))) {
          agents++;
          problems.push(...validateAgentFile(absIn(target, `${d}/${f}`), `${d}/${f}`, { requireTools: d === '.claude/agents' }).problems);
        }
      }
      for (const d of ['.claude/skills', '.agents/skills']) {
        for (const s of listSubdirs(absIn(target, d))) { skills++; problems.push(...validateSkillDir(absIn(target, `${d}/${s}`), `${d}/${s}`)); }
      }
      if (!agents && !skills) R.add('FAIL', 5, 'frontmatter', 'no agents or skills found');
      else if (problems.length) R.add('FAIL', 5, 'frontmatter', `${problems.length} problem(s)`, problems);
      else R.add('PASS', 5, 'frontmatter', `${agents} agent file(s), ${skills} skill folder(s): name = file/folder, description${hasClaude ? ', tools' : ''} present`);
    } catch (e) { R.add('FAIL', 5, 'frontmatter', `could not validate: ${e.message}`); }
  }

  // ---- [6] kit config + installed items present ----
  {
    if (!config) R.add('FAIL', 6, 'kit config', cfgError);
    else {
      const problems = [];
      if (!config.kitVersion) problems.push('kitVersion missing');
      if (!Array.isArray(config.tools) || !config.tools.length) problems.push('tools missing');
      if (!Array.isArray(config.modules) || !config.modules.includes('core')) problems.push('modules missing (core expected)');
      for (const a of config.agents || []) if (!isFile(absIn(target, `${srcRel}/${a}.md`))) problems.push(`kit agent missing: ${srcRel}/${a}.md`);
      for (const s of config.skills || []) {
        for (const d of [hasClaude ? '.claude/skills' : null, hasCodex ? '.agents/skills' : null].filter(Boolean)) {
          if (!isFile(absIn(target, `${d}/${s}/SKILL.md`))) problems.push(`kit skill missing: ${d}/${s}/SKILL.md`);
        }
      }
      if (!isFile(absIn(target, '.kit/check.mjs'))) problems.push('.kit/check.mjs missing');
      if (problems.length) R.add('FAIL', 6, 'kit config', `${problems.length} problem(s)`, problems);
      else R.add('PASS', 6, 'kit config', `kit ${config.kitVersion} · tools: ${config.tools.join(', ')} · modules: ${config.modules.join(', ')} · ${(config.agents || []).length} agents, ${(config.skills || []).length} skills present`);
    }
  }

  // ---- [7] write exclusivity (Claude tools whitelist: professional agents hold exactly Read, Glob, Grep) ----
  {
    const offenders = [];
    const lacking = [];
    let checked = 0;
    try {
      for (const d of ['.claude/agents', '.kit/agents-src']) {
        for (const f of listMd(absIn(target, d))) {
          const base = agentBaseName(f);
          const fm = parseFrontmatter(readText(absIn(target, `${d}/${f}`)));
          if (!fm.ok || !str(fm.data.tools)) continue;
          checked++;
          if (base === MANAGER_AGENT) continue;
          const bad = nonReadOnlyTools(fm.data.tools);
          if (bad.length) offenders.push(extraToolsProblem(`${d}/${f}`, bad));
          const lack = missingReadOnlyTools(fm.data.tools);
          if (lack.length) lacking.push(`${d}/${f}: lacks ${lack.join(', ')} — a professional agent needs ${READ_ONLY_TOOLS.join(', ')} to read the project`);
        }
      }
      const allowed = READ_ONLY_TOOLS.join(', ');
      if (!checked) R.add('FAIL', 7, 'write exclusivity', 'no agent with a tools whitelist found');
      else if (offenders.length) R.add('FAIL', 7, 'write exclusivity', `${offenders.length} professional agent(s) hold tools beyond ${allowed} — only ${MANAGER_AGENT} may`, [...offenders, ...lacking]);
      else if (lacking.length) R.add('WARN', 7, 'write exclusivity', `${lacking.length} professional agent(s) lack part of ${allowed}`, lacking);
      else R.add('PASS', 7, 'write exclusivity', `professional agents hold exactly ${allowed}; only ${MANAGER_AGENT} has more (${checked} agent(s) checked)${hasCodex ? ' · in Codex this is by instruction only' : ''}`);
    } catch (e) { R.add('FAIL', 7, 'write exclusivity', `could not check: ${e.message}`); }
  }

  // ---- [8] pending merge ----
  {
    const pending = ['AGENTS.kit.md', 'CLAUDE.kit.md'].filter((f) => isFile(absIn(target, f)));
    const stale = hasClaude && isDir(absIn(target, '.kit/agents-src')) ? ['.kit/agents-src/ — no longer the agent source (.claude/agents is canonical since claude is installed); remove it after checking'] : [];
    // a kit copy extracted inside the project (fallback when no folder outside it was writable): templates with
    // {{…}} and a nested CLAUDE.md that tools may load — remove it once the install is checked; never commit it
    if (isDir(absIn(target, '.kit/kit-src'))) stale.push('.kit/kit-src/ — a copy of the kit inside the project; delete it (with the owner\'s approval) once the install is checked — it is git-ignored, never commit it');
    if (pending.length) R.add('WARN', 8, 'pending merge', `${pending.join(', ')} waiting — merge into the live file, keep the project's own rules, then remove the .kit.md file`, [...pending, ...stale]);
    else if (stale.length) R.add('WARN', 8, 'pending merge', stale.length === 1 ? stale[0] : 'leftovers to remove', stale.length === 1 ? [] : stale);
    else R.add('PASS', 8, 'pending merge', 'no AGENTS.kit.md / CLAUDE.kit.md waiting');
  }

  // ---- [9] docs ----
  {
    const ap = absIn(target, 'AGENTS.md');
    let block = null;
    try { block = isFile(ap) ? normalizeEol(readText(ap)).split('\n').some((l) => l.trim() === DOCS_REPO_MARKER) : null; } catch { block = null; }
    if (!config) R.add('FAIL', 9, 'docs', `cannot check without .kit/kit.config.json (${cfgError})`);
    else if (docsRepo) {
      // by design: a code repo of a multi-repo project carries no docs/ — the docs checks do not apply here
      const want = docsRepoBlock(docsRepo).split('\n').find((l) => l.includes(`\`${docsRepo}\``));
      const text = block ? normalizeEol(readText(ap)) : '';
      if (!block) R.add('FAIL', 9, 'docs', `docs repo "${docsRepo}" in kit.config.json, but AGENTS.md has no ${DOCS_REPO_MARKER} block — merge AGENTS.kit.md (or run install.mjs --update) so the AI knows where the docs live`);
      else if (!text.includes(want)) R.add('FAIL', 9, 'docs', `the ${DOCS_REPO_MARKER} block in AGENTS.md does not name the docs repo "${docsRepo}" from kit.config.json — align them`);
      else R.add('PASS', 9, 'docs', `${DOCS_NA}: management docs live in "${docsRepo}" · AGENTS.md points there (${DOCS_REPO_MARKER})`);
    } else {
      const docs = Array.isArray(config.docs) ? config.docs : [];
      const missing = docs.filter((d) => !isFile(absIn(target, d)));
      const extra = block ? [`AGENTS.md has a ${DOCS_REPO_MARKER} block, but kit.config.json has no docsRepo — remove the block or record the docs repo (install.mjs --update --docs-repo <repo>)`] : [];
      if (missing.length) R.add('FAIL', 9, 'docs', `${missing.length} kit doc(s) missing (docs are never deleted without the owner's explicit instruction)`, [...missing.map((d) => `kit doc missing: ${d}`), ...extra]);
      else if (extra.length) R.add('WARN', 9, 'docs', extra[0]);
      else if (!docs.length) R.add('WARN', 9, 'docs', 'kit.config.json records no kit docs and no docs repo — re-run install.mjs (or --docs-repo for a code repo)');
      else R.add('PASS', 9, 'docs', `${docs.length} kit doc(s) present in docs/`);
    }
  }

  // ---- [10] constitution structure (merge validation) ----
  // install.mjs records the `## ` headings of the kit's core AGENTS.md and the markers of the blocks it added; a merged
  // AGENTS.md must still have every one of them. Order is not enforced, and the project's own sections are allowed.
  {
    const title = 'constitution structure';
    const ap = absIn(target, 'AGENTS.md');
    const s = config ? config.agentsStructure : undefined;
    const okList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
    try {
      if (!config) R.add('FAIL', 10, title, `cannot check without .kit/kit.config.json (${cfgError})`);
      else if (s === undefined) R.add('WARN', 10, title, 'cannot verify structure — .kit/kit.config.json has no agentsStructure (installed by an older kit); re-run install --update');
      else if (!s || typeof s !== 'object' || !okList(s.headings) || !okList(s.markers) || !s.headings.length) R.add('FAIL', 10, title, 'agentsStructure in .kit/kit.config.json is damaged (expected {"headings": ["## …", …], "markers": [...]}) — re-run install --update');
      else if (!isFile(ap)) R.add('FAIL', 10, title, 'AGENTS.md missing — nothing to verify');
      else {
        const text = readText(ap);
        const miss = missingStructure(text, s);
        const known = new Set([...s.headings.map((h) => normalizeH2(h) || h.trim()), ...blockHeadings(text)]);
        const own = [...new Set(h2Headings(text))].filter((h) => !known.has(h));
        const pending = isFile(absIn(target, 'AGENTS.kit.md'));
        const n = miss.headings.length + miss.markers.length;
        if (n) {
          R.add('FAIL', 10, title, `AGENTS.md lacks ${n} of the kit's section(s)/marker(s) recorded at install — restore them${pending ? ' from AGENTS.kit.md (waiting to be merged)' : ' (install --update writes AGENTS.kit.md to merge from)'}; merging keeps every kit section, the project's own rules go into sections of their own`, [
            ...miss.headings.map((h) => `missing heading: ${h}`),
            ...miss.markers.map((m) => `missing marker: ${m}${/module:/.test(m) ? ' (with its module section after it)' : ' (with the docs repo block after it)'}`),
          ]);
        } else {
          R.add('PASS', 10, title, `AGENTS.md keeps all ${s.headings.length} kit heading(s) and ${s.markers.length} block marker(s) (order not enforced)${own.length ? ` · ${own.length} section(s) of the project's own` : ''}`, own.map((h) => `project section: ${h}`));
        }
      }
    } catch (e) { R.add('FAIL', 10, title, `could not check: ${e.message}`); }
  }

  return R;
}

// ---------------------------------------------------------------------------------------------
// kit mode
// ---------------------------------------------------------------------------------------------
function moduleEntries(kit) { return Object.entries(kit.modules || {}); }

export function runKitChecks(kitRoot) {
  const R = new Results();
  let kit;
  try { kit = readJson(path.join(kitRoot, 'kit.json')); } catch (e) { R.add('FAIL', 1, 'kit.json', `cannot read/parse: ${e.message}`); return R; }

  // ---- [1] kit.json shape ----
  {
    const p = [];
    if (kit.name !== 'ai-project-kit') p.push('name must be "ai-project-kit"');
    if (!/^\d+\.\d+\.\d+$/.test(str(kit.version))) p.push('version must be semver x.y.z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(kit.released))) p.push('released must be YYYY-MM-DD');
    if (!kit.modules || !kit.modules.core) p.push('modules.core missing');
    if (!kit.placeholders || !Array.isArray(kit.placeholders.required)) p.push('placeholders.required missing');
    if (typeof kit.agentsMaxBytes !== 'number') p.push('agentsMaxBytes missing');
    for (const [name, m] of moduleEntries(kit)) {
      if (name !== 'core' && !m.section) p.push(`modules.${name}.section missing`);
      if (m.placeholderGroup && !Array.isArray((kit.placeholders || {})[m.placeholderGroup])) p.push(`modules.${name}.placeholderGroup "${m.placeholderGroup}" not in placeholders`);
    }
    const allNames = new Set(Object.values(kit.placeholders || {}).flatMap((v) => (Array.isArray(v) ? v : [])));
    for (const [k, rule] of Object.entries(kit.placeholderRules || {})) {
      if (!allNames.has(k)) p.push(`placeholderRules.${k}: not a declared placeholder`);
      if (rule.pattern) { try { new RegExp(rule.pattern); } catch (e) { p.push(`placeholderRules.${k}.pattern does not compile: ${e.message}`); } }
      if (rule.enum && !Array.isArray(rule.enum)) p.push(`placeholderRules.${k}.enum must be a list`);
    }
    const files = kit.files || {};
    if (files.bundle && !/^dist\/[^/]*\{version\}[^/]*\.zip$/.test(files.bundle)) p.push(`files.bundle must be a zip under dist/ named with {version} (e.g. ${DEFAULT_BUNDLE}), found "${files.bundle}"`);
    if (files.unbundle) p.push('files.unbundle: the single-file bundle and unbundle.mjs were replaced by the zip — remove the entry');
    // kit-only files: the kit folder's own maintenance constitution — never installed into a project
    const kitOnly = kit.kitOnly && Array.isArray(kit.kitOnly.files) ? kit.kitOnly.files : null;
    if (!kitOnly) p.push('kitOnly.files missing — the kit folder\'s own AGENTS.md / CLAUDE.md must be registered as kit-only');
    else {
      for (const k of ['kitAgentsMd', 'kitClaudeMd']) if (!files[k] || !kitOnly.includes(files[k])) p.push(`files.${k} must be set and listed in kitOnly.files`);
      const core = (kit.modules && kit.modules.core) || {};
      const installed = new Set([core.agentsMd, core.claudeMd, ...moduleEntries(kit).map(([, m]) => m.section)].filter(Boolean));
      const dirs = moduleEntries(kit).flatMap(([, m]) => [m.agents, m.skills, m.docs]).filter(Boolean);
      for (const r of kitOnly) if (installed.has(r) || dirs.some((d) => r === d || r.startsWith(`${d}/`))) p.push(`kitOnly.files: ${r} is also an installed file — kit-only files are never installed into a project`);
    }
    if (p.length) R.add('FAIL', 1, 'kit.json', `${p.length} problem(s)`, p);
    else R.add('PASS', 1, 'kit.json', `${kit.name} ${kit.version} (${kit.released}) · modules: ${Object.keys(kit.modules).join(', ')}`);
  }

  // ---- [2] files listed in kit.json exist ----
  {
    const missing = [];
    const unlisted = [];
    const files = kit.files || {};
    for (const [k, rel] of Object.entries(files)) {
      if (k === 'bundle') continue; // generated — see [10]
      if (!isFile(absIn(kitRoot, rel))) missing.push(rel);
    }
    for (const [name, m] of moduleEntries(kit)) {
      for (const k of ['agentsMd', 'claudeMd', 'section']) if (m[k] && !isFile(absIn(kitRoot, m[k]))) missing.push(`${m[k]} (${name}.${k})`);
      for (const k of ['agents', 'skills', 'docs']) if (m[k] && !isDir(absIn(kitRoot, m[k]))) missing.push(`${m[k]}/ (${name}.${k})`);
      const ex = m.expect || {};
      if (m.agents) {
        for (const a of ex.agents || []) if (!isFile(absIn(kitRoot, `${m.agents}/${a}.md`))) missing.push(`${m.agents}/${a}.md`);
        for (const f of listMd(absIn(kitRoot, m.agents))) if (!(ex.agents || []).includes(agentBaseName(f))) unlisted.push(`${m.agents}/${f}`);
      }
      if (m.skills) {
        for (const s of ex.skills || []) if (!isFile(absIn(kitRoot, `${m.skills}/${s}/SKILL.md`))) missing.push(`${m.skills}/${s}/SKILL.md`);
        for (const s of listSubdirs(absIn(kitRoot, m.skills))) if (!(ex.skills || []).includes(s)) unlisted.push(`${m.skills}/${s}/`);
      }
      if (m.docs) {
        for (const d of ex.docs || []) if (!isFile(absIn(kitRoot, `${m.docs}/${d}`))) missing.push(`${m.docs}/${d}`);
        for (const f of listFiles(absIn(kitRoot, m.docs))) if (!(ex.docs || []).includes(f)) unlisted.push(`${m.docs}/${f}`);
      }
    }
    if (missing.length) R.add('FAIL', 2, 'kit files', `${missing.length} file(s) listed in kit.json are missing`, [...missing, ...unlisted.map((u) => `not listed in kit.json: ${u}`)]);
    else if (unlisted.length) R.add('WARN', 2, 'kit files', `${unlisted.length} file(s) exist but are not listed in kit.json "expect"`, unlisted);
    else R.add('PASS', 2, 'kit files', 'every file and folder listed in kit.json exists, nothing unlisted');
  }

  // collect agents / skills of all modules
  const agentFiles = []; // {rel, module}
  const skillDirs = [];  // {rel, module, name}
  for (const [name, m] of moduleEntries(kit)) {
    if (m.agents) for (const f of listMd(absIn(kitRoot, m.agents))) agentFiles.push({ rel: `${m.agents}/${f}`, module: name });
    if (m.skills) for (const s of listSubdirs(absIn(kitRoot, m.skills))) skillDirs.push({ rel: `${m.skills}/${s}`, module: name, name: s });
  }

  // ---- [3] frontmatter + read-only professional agents ----
  {
    const problems = [];
    const warns = [];
    for (const a of agentFiles) {
      const { problems: p, fm } = validateAgentFile(absIn(kitRoot, a.rel), a.rel, { requireTools: true });
      problems.push(...p);
      if (!fm || !fm.ok) continue;
      const base = agentBaseName(a.rel);
      const tools = toolList(fm.data.tools);
      if (base !== MANAGER_AGENT) {
        const bad = nonReadOnlyTools(fm.data.tools);
        if (bad.length) problems.push(extraToolsProblem(a.rel, bad));
        const lack = missingReadOnlyTools(fm.data.tools);
        if (lack.length) problems.push(`${a.rel}: professional agent lacks ${lack.join(', ')} — the kit ships every professional agent with exactly ${READ_ONLY_TOOLS.join(', ')}`);
        const d = str(fm.data.description).trim().replace(/[.\s]+$/, '');
        if (!d.endsWith(ROUTING_SUFFIX)) warns.push(`${a.rel}: description should end with "${ROUTING_SUFFIX}."`);
      } else if (!tools.includes('Write') || !tools.includes('Edit')) warns.push(`${a.rel}: ${MANAGER_AGENT} is the only writer — tools should include Write, Edit`);
    }
    for (const s of skillDirs) problems.push(...validateSkillDir(absIn(kitRoot, s.rel), s.rel));
    const seenA = new Map(), seenS = new Map();
    for (const a of agentFiles) { const b = agentBaseName(a.rel); if (seenA.has(b)) problems.push(`agent name collision: ${b} in ${seenA.get(b)} and ${a.module}`); else seenA.set(b, a.module); }
    for (const s of skillDirs) { if (seenS.has(s.name)) problems.push(`skill name collision: ${s.name} in ${seenS.get(s.name)} and ${s.module}`); else seenS.set(s.name, s.module); }
    if (!agentFiles.length && !skillDirs.length) R.add('FAIL', 3, 'frontmatter', 'no agents or skills found');
    else if (problems.length) R.add('FAIL', 3, 'frontmatter', `${problems.length} problem(s)`, [...problems, ...warns]);
    else if (warns.length) R.add('WARN', 3, 'frontmatter', `${warns.length} warning(s)`, warns);
    else R.add('PASS', 3, 'frontmatter', `${agentFiles.length} agents, ${skillDirs.length} skills valid · professional agents hold exactly ${READ_ONLY_TOOLS.join(', ')}`);
  }

  // ---- [4] placeholders declared ----
  {
    const required = (kit.placeholders || {}).required || [];
    const groups = Object.entries(kit.placeholders || {}).filter(([g]) => g !== 'required');
    const declared = new Set([...required, ...groups.flatMap(([, v]) => (Array.isArray(v) ? v : []))]);
    const groupOf = new Map(); for (const [g, v] of groups) for (const n of v || []) groupOf.set(n, g);
    const problems = [];
    const used = new Set();
    let scanned = 0;
    for (const [name, m] of moduleEntries(kit)) {
      const rels = [];
      for (const k of ['agentsMd', 'claudeMd', 'section']) if (m[k] && isFile(absIn(kitRoot, m[k]))) rels.push(m[k]);
      if (m.docs) for (const f of listFiles(absIn(kitRoot, m.docs))) if (/\.md$/i.test(f)) rels.push(`${m.docs}/${f}`);
      for (const rel of rels) {
        scanned++;
        for (const h of findPlaceholders(readText(absIn(kitRoot, rel)), RE_PH_ANY)) {
          used.add(h.name);
          if (!declared.has(h.name)) problems.push(`${rel}:${h.line}  ${h.token} is not declared in kit.json placeholders`);
          else if (h.token !== `{{${h.name}}}`) problems.push(`${rel}:${h.line}  ${h.token} — write it without spaces: {{${h.name}}} (the installer replaces exact tokens)`);
          const g = groupOf.get(h.name);
          if (g && m.placeholderGroup !== g) problems.push(`${rel}:${h.line}  ${h.token} belongs to the "${g}" group but is used in module "${name}" (it would stay unfilled when ${g} is not installed)`);
        }
      }
    }
    const unused = required.filter((n) => !used.has(n));
    if (!scanned) R.add('FAIL', 4, 'placeholders', 'no instruction/docs files found to scan');
    else if (problems.length) R.add('FAIL', 4, 'placeholders', `${problems.length} problem(s)`, problems);
    else if (unused.length) R.add('WARN', 4, 'placeholders', `declared but unused: ${unused.join(', ')}`);
    else R.add('PASS', 4, 'placeholders', `${used.size} placeholder name(s) used in ${scanned} file(s), all declared`);
  }

  // ---- [5] no placeholders inside agents/skills ----
  {
    const hits = [];
    for (const a of agentFiles) for (const h of findPlaceholders(readText(absIn(kitRoot, a.rel)), RE_PH_ANY)) hits.push(`${a.rel}:${h.line}  ${h.token}`);
    for (const s of skillDirs) {
      for (const f of listFiles(absIn(kitRoot, s.rel))) {
        if (!/\.md$/i.test(f)) continue;
        for (const h of findPlaceholders(readText(absIn(kitRoot, `${s.rel}/${f}`)), RE_PH_UPPER)) hits.push(`${s.rel}/${f}:${h.line}  ${h.token}`);
      }
    }
    if (hits.length) R.add('FAIL', 5, 'agents/skills placeholders', `${hits.length} placeholder(s) — agents and skills must contain none (they are copied and converted as-is)`, hits);
    else R.add('PASS', 5, 'agents/skills placeholders', `none in ${agentFiles.length} agents / ${skillDirs.length} skills`);
  }

  // ---- [6] sizes ----
  {
    const core = kit.modules && kit.modules.core;
    const coreRel = core && core.agentsMd;
    if (!coreRel || !isFile(absIn(kitRoot, coreRel))) R.add('FAIL', 6, 'AGENTS.md size', 'core AGENTS.md missing — cannot measure');
    else {
      const coreText = readText(absIn(kitRoot, coreRel));
      const sections = [];
      const warns = [];
      for (const [name, m] of moduleEntries(kit)) {
        if (name === 'core' || !m.section || !isFile(absIn(kitRoot, m.section))) continue;
        const t = readText(absIn(kitRoot, m.section));
        sections.push(t);
        if (m.sectionMaxBytes && bytesOf(t) > m.sectionMaxBytes) warns.push(`${m.section}: ${bytesOf(t)} bytes > budget ${m.sectionMaxBytes}`);
      }
      const coreBytes = bytesOf(coreText);
      if (kit.coreAgentsMaxBytes && coreBytes > kit.coreAgentsMaxBytes) warns.push(`${coreRel}: ${coreBytes} bytes > budget ${kit.coreAgentsMaxBytes}`);
      const ka = (kit.files || {}).kitAgentsMd;
      const kaMax = kit.kitOnly && kit.kitOnly.agentsMaxBytes;
      if (ka && kaMax && isFile(absIn(kitRoot, ka)) && fs.statSync(absIn(kitRoot, ka)).size > kaMax) warns.push(`${ka} (kit maintenance): ${fs.statSync(absIn(kitRoot, ka)).size} bytes > budget ${kaMax}`);
      const total = bytesOf(composeAgentsMd(coreText, sections));
      const max = kit.agentsMaxBytes || AGENTS_SOFT_LIMIT;
      // a code repo (install.mjs --docs-repo) appends one more block: measure that worst case too (a typical value)
      const codeRepo = bytesOf(composeAgentsMd(composeAgentsMd(coreText, sections), [docsRepoBlock('../product-docs')]));
      if (codeRepo > max && total <= max) warns.push(`a code repo with every module (--docs-repo block) = ${codeRepo} bytes > ${max} — still under the Codex cap ${CODEX_DOC_HARD_LIMIT}, but trim the core or a section`);
      if (total > max) R.add('FAIL', 6, 'AGENTS.md size', `core + all module sections = ${total} bytes > ${max} (Codex reads at most ${CODEX_DOC_HARD_LIMIT}; leave room for filled values)`, warns);
      else if (warns.length) R.add('WARN', 6, 'AGENTS.md size', `total ${total}/${max} bytes, but a budget is exceeded`, warns);
      else R.add('PASS', 6, 'AGENTS.md size', `core ${coreBytes} bytes · core + all sections ${total}/${max} bytes · + docs-repo block ${codeRepo}`);
    }
  }

  // ---- [7] module sections + CLAUDE.md import ----
  {
    const p = [];
    for (const [name, m] of moduleEntries(kit)) {
      if (name === 'core' || !m.section) continue;
      const sp = absIn(kitRoot, m.section);
      if (!isFile(sp)) { p.push(`${m.section} missing`); continue; }
      const first = normalizeEol(readText(sp)).split('\n')[0].trim();
      if (first !== `<!-- module:${name} -->`) p.push(`${m.section}: first line must be <!-- module:${name} --> (found "${first}")`);
    }
    const cm = kit.modules && kit.modules.core && kit.modules.core.claudeMd;
    if (!cm || !isFile(absIn(kitRoot, cm))) p.push('core CLAUDE.md missing');
    else {
      const raw = fs.readFileSync(absIn(kitRoot, cm), 'utf8');
      const first = normalizeEol(raw).split('\n')[0].trim();
      if (raw.charCodeAt(0) === 0xfeff) p.push(`${cm}: ${BOM_MSG}`);
      else if (first !== '@AGENTS.md') p.push(`${cm}: first line must be exactly @AGENTS.md (found "${first}")`);
    }
    // the kit folder's own CLAUDE.md (kit-only): Claude Code must load the maintenance AGENTS.md through it
    const kc = (kit.files || {}).kitClaudeMd;
    const ka = (kit.files || {}).kitAgentsMd;
    if (kc && isFile(absIn(kitRoot, kc))) {
      const raw = fs.readFileSync(absIn(kitRoot, kc), 'utf8');
      const first = normalizeEol(raw).split('\n')[0].trim();
      if (raw.charCodeAt(0) === 0xfeff) p.push(`${kc} (kit maintenance): ${BOM_MSG}`);
      else if (first !== `@${path.posix.basename(ka || 'AGENTS.md')}`) p.push(`${kc} (kit maintenance): first line must be exactly @AGENTS.md (found "${first}")`);
    }
    const am = kit.modules && kit.modules.core && kit.modules.core.agentsMd;
    if (am && isFile(absIn(kitRoot, am))) {
      const lines = normalizeEol(readText(absIn(kitRoot, am))).split('\n').map((l) => l.replace(/\s+$/, ''));
      const n = lines.filter((l) => l === '**רמת העצמאות הנוכחית:** `{{AUTONOMY_LEVEL}}`').length;
      const any = lines.filter((l) => RE_AUTONOMY_ANY.test(l)).length;
      if (n !== 1 || any !== 1) p.push(`${am}: needs exactly one autonomy line "**רמת העצמאות הנוכחית:** \`{{AUTONOMY_LEVEL}}\`" alone on its line (found ${n} exact, ${any} in total) — project check [2] relies on it`);
      // the installer records these headings as agentsStructure; project check [10] matches them exactly after the merge
      const hs = h2Headings(readText(absIn(kitRoot, am)));
      if (!hs.length) p.push(`${am}: no "## " heading outside code fences — the installer records them (agentsStructure) so project check [10] can verify a merged AGENTS.md`);
      for (const h of hs) if (/\{\{/.test(h)) p.push(`${am}: heading "${h}" holds a placeholder — headings are recorded at install and matched exactly; keep placeholders out of "## " headings`);
      const dup = hs.filter((h, i) => hs.indexOf(h) !== i);
      if (dup.length) p.push(`${am}: duplicate "## " heading(s): ${[...new Set(dup)].join(' · ')} — project check [10] could not tell them apart`);
    }
    for (const [name, m] of moduleEntries(kit)) {
      if (name === 'core' || !m.section || !isFile(absIn(kitRoot, m.section))) continue;
      const t = readText(absIn(kitRoot, m.section));
      if (structureMarkers(t).filter((x) => x === `<!-- module:${name} -->`).length !== 1) p.push(`${m.section}: <!-- module:${name} --> must appear exactly once, outside code fences — project check [10] looks for it`);
    }
    if (p.length) R.add('FAIL', 7, 'sections & CLAUDE.md', `${p.length} problem(s)`, p);
    else R.add('PASS', 7, 'sections & CLAUDE.md', `every module section starts with its <!-- module:… --> marker · core CLAUDE.md${kc ? ` and the kit's own ${kc}` : ''} start with @AGENTS.md (no BOM) · one autonomy line in core AGENTS.md · ${am && isFile(absIn(kitRoot, am)) ? h2Headings(readText(absIn(kitRoot, am))).length : 0} "## " headings recorded at install (agentsStructure)`);
  }

  // ---- [8] licenses of downloaded skills ----
  {
    const p = [];
    let n = 0;
    for (const [, m] of moduleEntries(kit)) {
      if (!m.licenseRequired || !m.skills) continue;
      for (const s of listSubdirs(absIn(kitRoot, m.skills))) {
        n++;
        const has = fs.readdirSync(absIn(kitRoot, `${m.skills}/${s}`)).some((f) => /^LICEN[SC]E/i.test(f));
        if (!has) p.push(`${m.skills}/${s}: no LICENSE file — upstream licenses must be kept`);
      }
    }
    if (p.length) R.add('FAIL', 8, 'licenses', `${p.length} skill(s) without a license file`, p);
    else R.add('PASS', 8, 'licenses', n ? `${n} downloaded skill(s) keep their LICENSE file` : 'no module requires license files');
  }

  // ---- [9] Codex TOML generation round-trip ----
  {
    const p = [];
    for (const a of agentFiles) {
      try {
        const text = readText(absIn(kitRoot, a.rel));
        const fm = parseFrontmatter(text);
        const toml = generateToml(a.rel, text);
        const back = parseGeneratedToml(toml);
        if (back.name !== str(fm.data.name)) p.push(`${a.rel}: name does not round-trip`);
        if (back.description !== str(fm.data.description)) p.push(`${a.rel}: description does not round-trip`);
        if (back.developer_instructions !== agentBody(text)) p.push(`${a.rel}: developer_instructions does not round-trip`);
        if (!back.developer_instructions.trim()) p.push(`${a.rel}: empty body`);
      } catch (e) { p.push(`${a.rel}: ${e.message}`); }
    }
    if (!agentFiles.length) R.add('FAIL', 9, 'codex TOML', 'no agents to convert');
    else if (p.length) R.add('FAIL', 9, 'codex TOML', `${p.length} problem(s)`, p);
    else R.add('PASS', 9, 'codex TOML', `${agentFiles.length} agent(s) convert to TOML and read back identically (the installer generates none for ${MANAGER_AGENT} — the session itself)`);
  }

  // ---- [10] distributable zip ----
  // Built last (after the version bump), so "not built / out of date" is a WARN; a zip that cannot be read back is a FAIL.
  {
    const rel = bundleRelFor(kit);
    const zp = absIn(kitRoot, rel);
    const rebuild = 'run: node tools/build-bundle.mjs';
    const extra = [];
    if (isFile(absIn(kitRoot, LEGACY_BUNDLE))) extra.push(`${LEGACY_BUNDLE}: the single-file bundle of earlier builds is obsolete — delete it`);
    const distRel = path.posix.dirname(rel);
    const older = isDir(absIn(kitRoot, distRel)) ? fs.readdirSync(absIn(kitRoot, distRel)).filter((f) => /^ai-project-kit-.*\.zip$/i.test(f) && f !== path.posix.basename(rel)).sort(cmp) : [];
    const olderNote = older.map((f) => `${distRel}/${f}: an older version — not the one to hand out`);
    if (!isFile(zp)) R.add('WARN', 10, 'zip', `${rel} not built for ${kit.version} — ${rebuild}`, [...extra, ...olderNote]);
    else {
      let entries = null;
      try { entries = readZip(fs.readFileSync(zp)); } catch (e) { R.add('FAIL', 10, 'zip', `${rel} cannot be read back (${e.message}) — ${rebuild}`, extra); }
      if (entries) {
        const bad = [];
        const got = new Map();
        for (const en of entries) {
          if (unsafeZipName(en.name) || !en.name.startsWith(`${ZIP_TOP}/`)) bad.push(`${en.name}: outside ${ZIP_TOP}/ or an unsafe path`);
          else if (!en.name.endsWith('/')) got.set(en.name.slice(ZIP_TOP.length + 1), en);
        }
        const want = kitZipFiles(kitRoot);
        const wantSet = new Set(want);
        const missing = want.filter((f) => !got.has(f));
        const added = [...got.keys()].filter((f) => !wantSet.has(f)).sort(cmp);
        const changed = want.filter((f) => {
          const en = got.get(f);
          if (!en) return false;
          const buf = fs.readFileSync(absIn(kitRoot, f));
          return buf.length !== en.size || crc32(buf) !== en.crc;
        });
        if (bad.length) R.add('FAIL', 10, 'zip', `${rel}: ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} outside ${ZIP_TOP}/ or with unsafe paths — ${rebuild}`, bad);
        else if (missing.length || added.length || changed.length) {
          R.add('WARN', 10, 'zip', `${rel} is out of date (${missing.length} file(s) missing, ${added.length} no longer in the kit, ${changed.length} changed) — ${rebuild}`, [
            ...missing.map((f) => `missing in the zip: ${f}`), ...added.map((f) => `in the zip, not in the kit: ${f}`), ...changed.map((f) => `changed since the build: ${f}`), ...extra, ...olderNote,
          ]);
        } else if (extra.length) R.add('WARN', 10, 'zip', extra[0], [`${rel} matches the kit (${want.length} files)`, ...olderNote]);
        else R.add('PASS', 10, 'zip', `${rel}: ${want.length} files under ${ZIP_TOP}/ — names, sizes and CRC-32 match the kit (${fs.statSync(zp).size} bytes)`, olderNote);
      }
    }
  }

  return R;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const HELP = `ai-project-kit check

  Project mode (default):  node .kit/check.mjs [--target <dir>] [--fix]
     --target <dir>   project folder (default: the folder that contains .kit/, else the current folder)
     --fix            regenerate .codex/agents/*.toml from the agent sources and mirror .claude/skills → .agents/skills
                      (overwritten or deleted files are backed up to .kit/backup/<YYYYMMDD-HHMMSS>[-N]/; a skill folder
                      that exists only in .agents/skills is never deleted — move it to .claude/skills). --fix never
                      rewrites the canonical files (.claude/…, AGENTS.md, CLAUDE.md): BOM or frontmatter problems are
                      only reported. agent-manager gets no TOML (it is the session itself); --fix removes an old one.
     A code repo installed with --docs-repo has no docs/: the docs checks print PASS "N/A by design (docs repo)".
     [7]  professional agents hold exactly Read, Glob, Grep (agent-manager is exempt); any other tool is a FAIL —
          Write/Edit/Bash/PowerShell/mcp__… can modify state, WebFetch/WebSearch reach the network.
     [10] constitution structure: every "## " heading of the kit's core AGENTS.md and every <!-- module:… --> /
          <!-- docs-repo --> marker recorded at install (.kit/kit.config.json agentsStructure) is still in AGENTS.md
          (order free, the project's own sections allowed). No agentsStructure (older kit) → WARN: run install --update.

  Kit mode:                node tools/check.mjs --kit [--kit-root <dir>]
     [10] the zip dist/ai-project-kit-<version>.zip is read back (central directory, CRC-32) and compared with the
     kit folder. It is built last, after the version bump: "not built / out of date" is a WARN, an unreadable zip a FAIL.

  Output: one line per check (PASS / FAIL / WARN), then "נכשלו: N · אזהרות: M".
  Exit: 0 no FAIL · 1 at least one FAIL · 2 bad arguments. A check that cannot run is a FAIL, never a skip.`;

function parseCliArgs(argv) {
  const o = { target: null, fix: false, kit: false, kitRoot: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    const val = () => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--target') o.target = val();
    else if (a === '--kit-root') o.kitRoot = val();
    else if (a === '--fix') o.fix = true;
    else if (a === '--kit') o.kit = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

function scriptPath() { return fileURLToPath(import.meta.url); }

function main() {
  let o;
  try { o = parseCliArgs(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}\n\n${HELP}`); process.exitCode = 2; return; }
  if (o.help) { console.log(HELP); return; }
  const here = path.dirname(scriptPath());
  if (o.kit) {
    const guess = path.resolve(here, '..');
    const root = path.resolve(o.kitRoot || o.target || (isFile(path.join(guess, 'kit.json')) ? guess : process.cwd()));
    console.log(`ai-project-kit — kit check: ${root}\n`);
    const R = runKitChecks(root);
    R.print();
    process.exitCode = R.failed ? 1 : 0;
    return;
  }
  const target = path.resolve(o.target || (path.basename(here) === '.kit' ? path.dirname(here) : process.cwd()));
  if (!isDir(target)) { console.error(`error: target folder not found: ${target}`); process.exitCode = 2; return; }
  console.log(`ai-project-kit — project check: ${target}${o.fix ? '  (--fix)' : ''}\n`);
  const R = runProjectChecks(target, { fix: o.fix });
  R.print();
  process.exitCode = R.failed ? 1 : 0;
}

function isMainModule() {
  try {
    if (!process.argv[1]) return false;
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(scriptPath());
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

if (isMainModule()) main();
