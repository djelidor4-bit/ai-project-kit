#!/usr/bin/env node
// ai-project-kit — build-bundle.mjs
// Writes dist/ai-project-kit-<version>.zip: the WHOLE kit folder (everything except dist/, .git/, node_modules/ and
// local tool state), under one top folder ai-project-kit/ — for an AI session that cannot see the kit folder (e.g. a
// cloud session). The owner uploads the zip; the AI extracts it to a temporary folder OUTSIDE the project, sets
// KIT_ROOT = <that folder>/ai-project-kit and follows ai-project-kit/START-HERE.md.
//
//   node tools/build-bundle.mjs [--kit-root <dir>] [--out <file.zip>]
//
// Node >= 18 · ES module · zero dependencies · no shell calls. A minimal ZIP writer: local file headers + central
// directory + end record, CRC-32, deflate (method 8) via zlib, UTF-8 names (general-purpose flag bit 11).
// Reproducible: entries sorted by path, every timestamp = kit.json "released" at 00:00:00 (MS-DOS time).
// The zip is read back and verified before it is written (check.mjs readZip); check.mjs --kit [10] compares it with the kit.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readJson, isFile, absIn, bundleRelFor, kitZipFiles, crc32, dosDateTime, readZip, ZIP_TOP, LEGACY_BUNDLE } from './check.mjs';

const HELP = `ai-project-kit build-bundle

  node tools/build-bundle.mjs [--kit-root <dir>] [--out <file.zip>]

  --kit-root <dir>   kit folder (default: the parent of this tools/ folder)
  --out <file.zip>   output file (default: <kit-root>/dist/ai-project-kit-<version>.zip, from kit.json files.bundle).
                     Inside the kit folder it must be under dist/ (anything else would be packed into the next build).

  The zip holds the whole kit folder under ${ZIP_TOP}/ (not dist/, .git/, node_modules/ or local tool state).
  For the owner: upload it to an AI that cannot see the kit folder and write
    "חלץ את הקובץ וקרא את ${ZIP_TOP}/START-HERE.md — ותתקין את ערכת העבודה בפרויקט הזה".
  Verify: node tools/check.mjs --kit   ([10] reads the zip back and compares it with the kit)
  Exit: 0 written · 1 error (kit.json missing or invalid, unreadable file, zip limits) · 2 bad arguments`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { kitRoot: null, out: null, help: false };
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
    if (a === '--kit-root') o.kitRoot = val();
    else if (a === '--out') o.out = val();
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  return o;
}

const SIG_LOC = 0x04034b50, SIG_CEN = 0x02014b50, SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;  // general-purpose bit 11: the name is UTF-8
const VERSION = 20;        // 2.0 — deflate; "made by" host 0 (MS-DOS/FAT), so no Unix permissions are carried

/** entries: [{name, data}] in the order to write. Returns the zip as one Buffer. */
function buildZip(entries, { date, time }) {
  if (entries.length > 0xffff) throw new Error(`${entries.length} files — more than a zip without ZIP64 can hold (65535)`);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    if (name.length > 0xffff) throw new Error(`${e.name}: name too long`);
    const crc = crc32(e.data);
    let method = 8;
    let comp = zlib.deflateRawSync(e.data, { level: 9 });
    if (comp.length >= e.data.length) { method = 0; comp = e.data; } // tiny or incompressible: store
    if (e.data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error(`${e.name}: the zip passes 4 GB — ZIP64 is not supported`);

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0);
    loc.writeUInt16LE(VERSION, 4);
    loc.writeUInt16LE(FLAG_UTF8, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(time, 10);
    loc.writeUInt16LE(date, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(e.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    parts.push(loc, name, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(VERSION, 4);   // version made by
    cen.writeUInt16LE(VERSION, 6);   // version needed to extract
    cen.writeUInt16LE(FLAG_UTF8, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);        // extra field length
    cen.writeUInt16LE(0, 32);        // comment length
    cen.writeUInt16LE(0, 34);        // disk number start
    cen.writeUInt16LE(0, 36);        // internal attributes
    cen.writeUInt32LE(0, 38);        // external attributes
    cen.writeUInt32LE(offset, 42);   // offset of the local header
    central.push(cen, name);

    offset += loc.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  if (offset + cd.length > 0xfffffffe) throw new Error('the zip passes 4 GB — ZIP64 is not supported');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);              // this disk
  end.writeUInt16LE(0, 6);              // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);             // comment length
  return Buffer.concat([...parts, cd, end]);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  const kitRoot = path.resolve(o.kitRoot || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const kitJson = path.join(kitRoot, 'kit.json');
  if (!isFile(kitJson)) throw new Error(`kit.json not found in ${kitRoot} (use --kit-root)`);
  let kit;
  try { kit = readJson(kitJson); } catch (e) { throw new Error(`kit.json is not valid JSON: ${e.message}`); }
  if (!/^\d+\.\d+\.\d+$/.test(String(kit.version || ''))) throw new Error(`kit.json "version" must be x.y.z (got ${JSON.stringify(kit.version)})`);
  const stamp = dosDateTime(kit.released);

  const outPath = path.resolve(o.out || absIn(kitRoot, bundleRelFor(kit)));
  const relOut = path.relative(kitRoot, outPath);
  const insideKit = relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut);
  if (insideKit && relOut.split(path.sep)[0] !== 'dist') throw new UsageError(`--out inside the kit folder must be under dist/ (got ${relOut}) — anything else is packed into the next build`);
  if (!/\.zip$/i.test(outPath)) throw new UsageError(`--out must end with .zip (got ${outPath})`);

  const symlinks = [];
  const files = kitZipFiles(kitRoot, { symlinks });
  if (!files.length) throw new Error(`no files found in ${kitRoot}`);
  for (const must of ['kit.json', (kit.files && kit.files.startHere) || 'START-HERE.md']) if (!files.includes(must)) throw new Error(`${must} is missing — the zip would be useless without it`);
  const entries = files.map((rel) => ({ name: `${ZIP_TOP}/${rel}`, data: fs.readFileSync(absIn(kitRoot, rel)) }));
  const zip = buildZip(entries, stamp);

  // read it back before writing: every entry must inflate to the same bytes
  const back = readZip(zip);
  if (back.length !== entries.length) throw new Error(`self-check: ${back.length} entries read back, ${entries.length} written`);
  back.forEach((b, i) => {
    if (b.name !== entries[i].name || !b.data.equals(entries[i].data)) throw new Error(`self-check: ${entries[i].name} does not read back identically`);
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zip);
  const raw = entries.reduce((n, e) => n + e.data.length, 0);
  console.log(`wrote ${outPath}`);
  console.log(`  ${zip.length} bytes (${(zip.length / 1024).toFixed(0)} KB) · ${entries.length} file(s) under ${ZIP_TOP}/ · ${(raw / 1024).toFixed(0)} KB uncompressed · timestamp ${kit.released} · read back: OK`);
  for (const s of symlinks) console.log(`  ⚠ skipped symlink: ${s} — replace it with a file`);
  if (isFile(absIn(kitRoot, LEGACY_BUNDLE))) console.log(`  ⚠ ${LEGACY_BUNDLE} is obsolete since the zip replaced it — delete it`);
  console.log(`  For the owner: upload ${path.basename(outPath)} and write: "חלץ את הקובץ וקרא את ${ZIP_TOP}/START-HERE.md — ותתקין את ערכת העבודה בפרויקט הזה"`);
}

try { main(); } catch (e) {
  if (e instanceof UsageError) { console.error(`error: ${e.message}\n\n${HELP}`); process.exitCode = 2; }
  else { console.error(`error: ${e.message}`); process.exitCode = 1; }
}
