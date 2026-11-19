// Export the database to an Excel snapshot.
// Usage: npm run export [-- output.xlsx]     (default: snapshots/netflix.xlsx)
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { FORMAT_VERSION, SHEETS, EXPORTED_SETTINGS } = require('./snapshot-format');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'netflix.db');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'snapshots', 'netflix.xlsx'));

async function genreNames() {
  // Optional: readable genre names (movie + TV lists) for the Titles sheet. Skipped if TMDB is unreachable.
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const key = config.tmdbApiKey || '';
    const names = {};
    for (const kind of ['movie', 'tv']) {
      const url = new URL(`https://api.themoviedb.org/3/genre/${kind}/list?language=en-US`);
      const headers = {};
      if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
      else url.searchParams.set('api_key', key);
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(r.statusText);
      for (const g of (await r.json()).genres) names[g.id] ??= g.name;
    }
    return names;
  } catch (e) {
    console.warn(`Genre names skipped (${e.message})`);
    return {};
  }
}

function addSheet(wb, def, rows) {
  const ws = wb.addWorksheet(def.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  ws.addRows(rows);
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE50914' } };
  // Grey header = column for reading only, ignored on restore.
  def.columns.forEach((c, i) => {
    if (c.info) header.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8F8F99' } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: def.columns.length } };
  return ws;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`No database at ${DB_PATH}`);
  const db = require('../db').db; // opening through db.js applies any pending migration first
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold pending WAL changes into the main file

  const genres = await genreNames();
  const countries = new Map();
  for (const a of db.prepare('SELECT kind, title_id, region FROM availability ORDER BY region').all()) {
    const k = `${a.kind}:${a.title_id}`;
    countries.set(k, [...(countries.get(k) || []), a.region]);
  }

  const titles = db.prepare('SELECT * FROM titles ORDER BY kind, popularity DESC').all().map((m) => ({
    ...m,
    genres: JSON.parse(m.genre_ids || '[]').map((id) => genres[id]).filter(Boolean).join(', '),
    countries: (countries.get(`${m.kind}:${m.id}`) || []).join(', '),
    imdb_url: m.imdb_id ? { text: 'IMDb', hyperlink: `https://www.imdb.com/title/${m.imdb_id}/` } : null,
  }));
  const availability = db.prepare(`
    SELECT a.*, t.title FROM availability a JOIN titles t ON t.kind = a.kind AND t.id = a.title_id
    ORDER BY a.region, a.kind, t.popularity DESC`).all();
  const syncs = db.prepare('SELECT * FROM catalog_syncs ORDER BY id').all();
  const settings = db.prepare(`SELECT key, value FROM settings WHERE key IN (${EXPORTED_SETTINGS.map(() => '?').join(',')})`)
    .all(...EXPORTED_SETTINGS);
  db.close();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'NetflixRating';
  wb.created = new Date();
  addSheet(wb, SHEETS.titles, titles);
  addSheet(wb, SHEETS.availability, availability);
  addSheet(wb, SHEETS.catalog_syncs, syncs);

  const info = wb.addWorksheet('Info');
  info.columns = [{ header: 'Key', key: 'key', width: 22 }, { header: 'Value', key: 'value', width: 60 }];
  info.getRow(1).font = { bold: true };
  info.addRows([
    { key: 'format_version', value: FORMAT_VERSION },
    { key: 'exported_at', value: new Date().toISOString() },
    { key: 'movies', value: titles.filter((m) => m.kind === 'movie').length },
    { key: 'tv_shows', value: titles.filter((m) => m.kind === 'tv').length },
    { key: 'rated', value: titles.filter((m) => m.imdb_rating != null).length },
    { key: 'note', value: 'Red headers are restored by "npm run restore"; grey headers are for reading only.' },
    ...settings.map((s) => ({ key: `setting.${s.key}`, value: s.value })),
  ]);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  const shows = titles.filter((m) => m.kind === 'tv').length;
  console.log(`Exported ${titles.length - shows} movies + ${shows} TV shows, ${availability.length} availability rows, ${syncs.length} syncs → ${out} (${mb} MB)`);
}

main().catch((e) => { console.error(`Export failed: ${e.message}`); process.exit(1); });
