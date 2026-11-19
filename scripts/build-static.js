// Build the read-only copy of the site for GitHub Pages.
// Usage: npm run build:static      → writes docs/ (serve it with GitHub Pages: main branch, /docs folder)
//
// Only the Browse view (movies and TV shows) is included. No API keys, no sync buttons, no server: the browser reads JSON files.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'netflix.db');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs');
const DATA_OUT = path.join(OUT, 'data');

async function fetchGenres() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const key = config.tmdbApiKey || '';
    const byId = new Map();
    for (const kind of ['movie', 'tv']) { // merged movie + TV genre lists
      const url = new URL(`https://api.themoviedb.org/3/genre/${kind}/list?language=en-US`);
      const headers = {};
      if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
      else url.searchParams.set('api_key', key);
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(r.statusText);
      for (const g of (await r.json()).genres) if (!byId.has(g.id)) byId.set(g.id, g);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    const previous = path.join(DATA_OUT, 'genres.json');
    if (fs.existsSync(previous)) {
      console.warn(`TMDB genres unavailable (${e.message}); reusing the previous genres.json`);
      return JSON.parse(fs.readFileSync(previous, 'utf8'));
    }
    console.warn(`TMDB genres unavailable (${e.message}); genre names will be missing`);
    return [];
  }
}

const writeJson = (file, data) => fs.writeFileSync(path.join(DATA_OUT, file), JSON.stringify(data));

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`No database at ${DB_PATH}. Run the server and sync first.`);
  const db = require('../db').db; // opening through db.js applies any pending migration first
  const builtAt = new Date().toISOString();

  // Start from a clean data folder so countries that were removed don't linger.
  fs.rmSync(DATA_OUT, { recursive: true, force: true });
  fs.mkdirSync(DATA_OUT, { recursive: true });

  // Latest successful catalogue sync per country and kind.
  const syncs = db.prepare(`
    SELECT s.* FROM catalog_syncs s
    WHERE s.finished_at IS NOT NULL AND s.error IS NULL
      AND s.id = (SELECT MAX(id) FROM catalog_syncs
                  WHERE region = s.region AND kind = s.kind AND finished_at IS NOT NULL AND error IS NULL)
    ORDER BY s.region, s.kind`).all();
  if (!syncs.length) throw new Error('No completed catalogue sync in the database yet.');

  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const regions = new Map();
  let totalTitles = 0;
  const listStmt = db.prepare(`
    SELECT t.id, t.title, t.year, t.poster_path, t.overview, t.genre_ids, t.tmdb_rating,
           t.imdb_id, t.imdb_rating, t.imdb_votes, t.rating_updated_at, t.lgbt, a.first_seen
    FROM availability a JOIN titles t ON t.kind = a.kind AND t.id = a.title_id
    WHERE a.region = ? AND a.kind = ? AND a.last_seen >= ?
    ORDER BY t.popularity DESC`);

  for (const s of syncs) {
    // Drop empty fields to keep the files small; the page treats missing as "no value".
    const movies = listStmt.all(s.region, s.kind, s.started_at).map((m) => {
      const out = { ...m, genre_ids: JSON.parse(m.genre_ids || '[]') };
      for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
      if (out.lgbt !== 1) delete out.lgbt; // only the tagged ones need the flag
      return out;
    });
    movies.forEach((m) => { m.imdb_rating ??= null; m.imdb_votes ??= null; m.rating_updated_at ??= null; m.tmdb_rating ??= null; m.year ??= null; });
    const rated = movies.filter((m) => m.imdb_rating != null).length;
    writeJson(`titles-${s.region}-${s.kind}.json`, {
      region: s.region,
      kind: s.kind,
      lastSync: { startedAt: s.started_at, finishedAt: s.finished_at, total: s.total, newTitles: s.new_titles },
      ratings: { total: movies.length, rated },
      movies,
    });
    if (!regions.has(s.region)) regions.set(s.region, { code: s.region, name: names.of(s.region) || s.region, kinds: [] });
    regions.get(s.region).kinds.push(s.kind);
    totalTitles += movies.length;
    console.log(`  ${s.region} ${s.kind === 'tv' ? 'TV shows' : 'movies'}: ${movies.length}, ${rated} rated`);
  }
  db.close();

  writeJson('regions.json', [...regions.values()].sort((a, b) => a.name.localeCompare(b.name)));
  writeJson('genres.json', await fetchGenres());

  // Page: same front end, with the server-only parts removed and static mode switched on.
  const v = Date.now().toString(36); // cache-buster so friends get the new version after an update
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/[ \t]*<!-- server-only -->[\s\S]*?<!-- \/server-only -->\n?/g, '')
    .replace('href="styles.css"', `href="styles.css?v=${v}"`)
    .replace('<script src="app.js"></script>',
      `<script>window.STATIC_SITE = ${JSON.stringify({ builtAt })};</script>\n  <script src="app.js?v=${v}"></script>`);
  if (html.includes('server-only') || html.includes('id="tab-sync"')) throw new Error('Failed to strip server-only markup');
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  for (const f of ['app.js', 'styles.css']) fs.copyFileSync(path.join(PUBLIC, f), path.join(OUT, f));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as-is, no Jekyll processing

  const size = fs.readdirSync(DATA_OUT).reduce((n, f) => n + fs.statSync(path.join(DATA_OUT, f)).size, 0);
  console.log(`Built docs/ for ${regions.size} countr${regions.size === 1 ? 'y' : 'ies'}, ${totalTitles} titles, data ${(size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => { console.error(`Build failed: ${e.message}`); process.exit(1); });
