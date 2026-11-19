// Restore the database from an Excel snapshot made by scripts/export.js.
// Usage: npm run restore [-- snapshot.xlsx]   (default: snapshots/netflix.xlsx)
// The current database is moved to data/backups/ first, and your saved OMDb key is carried over.
const path = require('path');
const fs = require('fs');
const net = require('net');
const ExcelJS = require('exceljs');
const { FORMAT_VERSION, SHEETS, EXPORTED_SETTINGS } = require('./snapshot-format');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA, 'netflix.db');
const input = path.resolve(process.argv[2] || path.join(ROOT, 'snapshots', 'netflix.xlsx'));

// ---------- reading cells ----------

// Turn whatever Excel stored (text, number, date, link, rich text, formula) into a plain value.
function plain(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return plain(v.text);
    if ('error' in v) return null;
  }
  return v;
}

function convert(v, col, where) {
  v = plain(v);
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  if (col.type === 'text') return String(v);
  const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
  if (!Number.isFinite(n)) throw new Error(`${where}: "${v}" is not a number`);
  if (col.type === 'int') {
    if (!Number.isInteger(n)) throw new Error(`${where}: "${v}" is not a whole number`);
  }
  return n;
}

function readSheet(wb, def) {
  const ws = wb.getWorksheet(def.sheet);
  if (!ws) throw new Error(`Sheet "${def.sheet}" is missing`);
  const headerIdx = {};
  ws.getRow(1).eachCell((cell, i) => { headerIdx[String(plain(cell.value)).trim()] = i; });
  const cols = def.columns.filter((c) => !c.info);
  const missing = cols.filter((c) => !(c.header in headerIdx)).map((c) => c.header);
  if (missing.length) throw new Error(`Sheet "${def.sheet}" is missing columns: ${missing.join(', ')}`);

  const rows = [];
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const obj = {};
    let empty = true;
    for (const c of cols) {
      obj[c.key] = convert(row.getCell(headerIdx[c.header]).value, c, `${def.sheet} row ${r}, ${c.header}`);
      if (obj[c.key] != null) empty = false;
    }
    if (!empty) rows.push({ ...obj, _row: r });
  });
  return rows;
}

// ---------- safety checks ----------

function serverRunning() {
  let port = 3000;
  try { port = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || 3000; } catch {}
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(port); });
    s.on('error', () => resolve(false));
  });
}

function require_(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- main ----------

async function main() {
  require_(fs.existsSync(input), `Snapshot not found: ${input}`);
  const port = await serverRunning();
  require_(!port, `The server seems to be running on port ${port}. Stop it (Ctrl+C) before restoring.`);

  // 1. Read and validate the whole snapshot before touching anything.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(input);
  const info = {};
  wb.getWorksheet('Info')?.eachRow((row, r) => { if (r > 1) info[plain(row.getCell(1).value)] = plain(row.getCell(2).value); });
  require_(Number(info.format_version) <= FORMAT_VERSION,
    `Snapshot format ${info.format_version} is newer than this code supports (${FORMAT_VERSION}). Update the code first.`);

  const movies = readSheet(wb, SHEETS.movies);
  const availability = readSheet(wb, SHEETS.availability);
  const syncs = readSheet(wb, SHEETS.catalog_syncs);

  const ids = new Set();
  for (const m of movies) {
    require_(m.id != null && m.title, `Movies row ${m._row}: TMDB id and Title are required`);
    require_(!ids.has(m.id), `Movies row ${m._row}: TMDB id ${m.id} appears twice`);
    require_(m.added_at && m.updated_at, `Movies row ${m._row}: Added at / Updated at are required`);
    ids.add(m.id);
  }
  for (const a of availability) {
    require_(ids.has(a.movie_id), `Availability row ${a._row}: TMDB id ${a.movie_id} is not on the Movies sheet`);
    require_(a.region && a.first_seen && a.last_seen, `Availability row ${a._row}: Country, First seen and Last seen are required`);
  }

  // 2. Keep the private settings (OMDb key, today's usage) from the current database.
  const keep = {};
  if (fs.existsSync(DB_PATH)) {
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(DB_PATH);
    old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    try {
      for (const r of old.prepare("SELECT key, value FROM settings WHERE key IN ('omdbApiKey', 'omdbUsage')").all()) keep[r.key] = r.value;
    } catch {} // older database without a settings table
    old.close();

    // 3. Move the current database aside.
    const backups = path.join(DATA, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(backups, `netflix-${stamp}.db`);
    fs.renameSync(DB_PATH, backup);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(DB_PATH + ext)) fs.rmSync(DB_PATH + ext);
    console.log(`Current database backed up to ${path.relative(ROOT, backup)}`);
  }

  // 4. Create a fresh database (db.js builds the schema) and load the snapshot.
  const store = require('../db');
  const insert = (table, cols, rows) => {
    const st = store.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const r of rows) st.run(...cols.map((c) => r[c]));
  };
  const keys = (def) => def.columns.filter((c) => !c.info).map((c) => c.key);
  try {
    store.transaction(() => {
      insert('movies', keys(SHEETS.movies), movies.map((m) => ({ ...m, genre_ids: m.genre_ids || '[]' })));
      insert('availability', keys(SHEETS.availability), availability);
      insert('catalog_syncs', keys(SHEETS.catalog_syncs), syncs);
      for (const k of EXPORTED_SETTINGS) {
        if (info[`setting.${k}`] != null) store.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(info[`setting.${k}`]));
      }
      for (const [k, v] of Object.entries(keep)) store.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
    });
  } catch (e) {
    throw new Error(`${e.message}\nThe previous database is safe in data/backups/.`);
  }

  const s = store.dbStats();
  console.log(`Restored ${s.movies} movies (${s.rated} with IMDb rating, ${s.pending} waiting for lookup), ` +
    `${availability.length} availability rows and ${syncs.length} syncs from ${path.relative(ROOT, input) || input}` +
    (keep.omdbApiKey ? '. Your saved OMDb key was kept.' : '.'));
}

main().catch((e) => { console.error(`Restore failed: ${e.message}`); process.exit(1); });
