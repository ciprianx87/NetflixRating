// Dependency-free server: serves /public, proxies TMDB/OMDb (keys stay server-side) and stores data in SQLite.
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json — copy config.example.json to config.json and add your API keys.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = Number(process.env.PORT) || config.port || 3000;
const OMDB_DAILY_LIMIT = config.omdbDailyLimit || 900; // free tier is 1,000/day; keep a margin
const NETFLIX_PROVIDER_ID = 8; // TMDB watch-provider id for Netflix
const TMDB = 'https://api.themoviedb.org/3';

const store = require('./db');

// ---------- external APIs ----------

// Accept either a v4 read access token (long JWT) or a v3 api key.
async function tmdbFetch(endpoint, params = {}) {
  const url = new URL(TMDB + endpoint);
  const headers = { accept: 'application/json' };
  const key = config.tmdbApiKey || '';
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 429 && attempt < 5) { await sleep(1000 * (attempt + 1)); continue; }
    const body = await r.json();
    if (!r.ok) throw Object.assign(new Error(body.status_message || r.statusText), { status: r.status });
    return body;
  }
}

async function omdbFetch(imdbId, key) {
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', key ?? omdbKey());
  url.searchParams.set('i', imdbId);
  const body = await (await fetch(url)).json();
  if (body.Response === 'False') {
    const err = new Error(body.Error || 'OMDb error');
    err.fatal = /limit|invalid api key|no api key/i.test(body.Error || '');
    throw err;
  }
  const num = (s) => (s && s !== 'N/A' ? Number(String(s).replace(/,/g, '')) : null);
  return { rating: num(body.imdbRating), votes: num(body.imdbVotes) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run fn over items with limited concurrency.
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// ---------- background jobs (one at a time) ----------

const job = { running: false, kind: null, region: null, done: 0, total: 0, message: '', error: null, finishedAt: null };

function startJob(kind, region, fn) {
  if (job.running) throw Object.assign(new Error(`A ${job.kind} job is already running`), { status: 409 });
  Object.assign(job, { running: true, kind, region, done: 0, total: 0, message: 'Starting…', error: null, finishedAt: null });
  fn().then(
    (msg) => { job.message = msg; },
    (e) => { job.error = e.message; job.message = 'Failed'; console.error(e); },
  ).finally(() => { job.running = false; job.finishedAt = store.now(); });
  return { started: true };
}

const KIND_LABEL = { movie: 'movies', tv: 'TV shows' };

// TMDB keyword ids for LGBT themes (community-added tags, so coverage is good but not complete).
// Found by searching TMDB keywords; ids are stable. Add more here if you spot gaps.
const LGBT_KEYWORDS = [
  158718, // lgbt
  163037, // lgbt teen
  224000, // lgbt parenting
  195624, // black lgbt
  264386, // lesbian
  9833, //   lesbian relationship
  258533, // gay theme
  265777, // gay relationship
  324058, // gay couple
  359231, // gay character
  566, //    sexual identity
  2316, //   women's sexual identity
  1013, //   homophobia
  315385, // lesbian love
  315382, // lesbian couple
  319872, // lesbian romance
  15136, //  female homosexuality
  10180, //  male homosexuality
  275157, // homosexuality
  240305, // gay romance
  247821, // gay youth
  346769, // gay interest
  245045, // gay friend
  327908, // gay bar
  190751, // gay muslim
  238355, // gay pornography
  3183, //   bisexuality
  329968, // bisexual
  168812, // bisexual man
  287417, // bisexual woman
  290527, // transgender
  229325, // transgender rights
  208798, // trans woman
  252909, // non-binary
  250606, // queer
  329464, // queer childhood
  265587, // queer horror
  344292, // queer experience
  824, //    drag queen
  1862, //   coming out
];

// Which Netflix titles of one kind in a region carry any of the LGBT keywords.
async function fetchLgbtIds(params, kind) {
  const q = { ...params, with_keywords: LGBT_KEYWORDS.join('|') }; // '|' = any of these
  const first = await tmdbFetch(`/discover/${kind}`, { ...q, page: 1 });
  const ids = first.results.map((r) => r.id);
  for (let page = 2; page <= Math.min(first.total_pages, 500); page++) {
    ids.push(...(await tmdbFetch(`/discover/${kind}`, { ...q, page })).results.map((r) => r.id));
  }
  return ids;
}

// Second source: Wikidata (Wikipedia's open database). Titles whose genre or main subject is an LGBT topic,
// matched by IMDb id. Broader than TMDB keywords: it also covers titles with notable LGBT characters.
const WIKIDATA_TOPICS = 'wd:Q17884 wd:Q6636 wd:Q6649 wd:Q43200 wd:Q189125 wd:Q592 wd:Q1035954 wd:Q51415 wd:Q20442589 wd:Q85133165 wd:Q1823134 wd:Q1052281';
async function fetchWikidataLgbtImdb(imdbIds) {
  const found = new Set();
  for (let i = 0; i < imdbIds.length; i += 200) {
    const values = imdbIds.slice(i, i + 200).map((id) => `"${id}"`).join(' ');
    const q = `SELECT DISTINCT ?imdb WHERE { VALUES ?imdb { ${values} } ?item wdt:P345 ?imdb .
      VALUES ?t { ${WIKIDATA_TOPICS} } { ?item wdt:P136 ?t } UNION { ?item wdt:P921 ?t } }`;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
        headers: { 'User-Agent': 'netflix-rating-local-tool/1.0', accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(60000),
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error(`Wikidata ${r.status}`);
      for (const b of (await r.json()).results.bindings) found.add(b.imdb.value);
      break;
    }
    await new Promise((ok) => setTimeout(ok, 1000)); // be polite to the public endpoint
  }
  return found;
}

// Third source: plain words in the TMDB description. "Gay" followed by a capitalised word is skipped (a name, e.g. Gay Talese).
const LGBT_WORDS = /\b(gay(?! [A-Z])|lesbians?|bisexual|transgender|trans (?:woman|man|girl|boy)|queer|lgbtq?\+?|same-sex|homosexual(?:ity)?|drag (?:queens?|kings?)|non-binary)\b/i;

// All LGBT sources combined → TMDB ids of one kind in a region seen in this sync.
async function collectLgbtIds(params, kind, region, startedAt) {
  const ids = new Set(await fetchLgbtIds(params, kind));
  const rows = store.db.prepare(`SELECT t.id, t.imdb_id, t.overview FROM availability a JOIN titles t ON t.kind = a.kind AND t.id = a.title_id
    WHERE a.region = ? AND a.kind = ? AND a.last_seen >= ?`).all(region, kind, startedAt);
  for (const r of rows) if (r.overview && LGBT_WORDS.test(r.overview)) ids.add(r.id);
  try {
    const wd = await fetchWikidataLgbtImdb(rows.filter((r) => r.imdb_id).map((r) => r.imdb_id));
    for (const r of rows) if (wd.has(r.imdb_id)) ids.add(r.id);
  } catch (e) {
    console.warn(`Wikidata LGBT check skipped for ${region} ${kind}: ${e.message}`);
  }
  return [...ids];
}

// Fetch every Netflix title of one kind ('movie' or 'tv') in a region from TMDB and store it.
async function syncCatalogKind(region, kind) {
  const startedAt = store.now();
  const syncId = store.stmt.startSync.run(region, kind, startedAt).lastInsertRowid;
  const endpoint = `/discover/${kind}`;
  job.done = 0;
  const params = {
    watch_region: region, with_watch_providers: NETFLIX_PROVIDER_ID, with_watch_monetization_types: 'flatrate',
    include_adult: 'false', language: 'en-US', sort_by: 'popularity.desc',
  };
  try {
    const first = await tmdbFetch(endpoint, { ...params, page: 1 });
    const pages = Math.min(first.total_pages, 500);
    job.total = first.total_results;
    let newTitles = 0;
    const save = (results) => {
      newTitles += store.transaction(() => results.reduce((n, m) => n + store.saveTitle(kind, m, region, startedAt), 0));
      job.done += results.length;
      job.message = `Fetched ${job.done.toLocaleString()} of ${job.total.toLocaleString()} ${KIND_LABEL[kind]}`;
    };
    save(first.results);
    const rest = Array.from({ length: pages - 1 }, (_, i) => i + 2);
    await pool(rest, 6, async (page) => save((await tmdbFetch(endpoint, { ...params, page })).results));
    job.message = `Checking LGBT themes in ${KIND_LABEL[kind]}…`;
    store.setLgbtTags(region, kind, startedAt, await collectLgbtIds(params, kind, region, startedAt));
    store.stmt.finishSync.run(store.now(), job.done, newTitles, null, syncId);
    return `${job.done.toLocaleString()} ${KIND_LABEL[kind]} (${newTitles} new)`;
  } catch (e) {
    store.stmt.finishSync.run(store.now(), job.done, null, e.message, syncId);
    throw e;
  }
}

// Movies first, then TV shows.
async function syncCatalog(region) {
  const parts = [];
  for (const kind of store.KINDS) parts.push(await syncCatalogKind(region, kind));
  return `Catalogue synced: ${parts.join(', ')}`;
}

// ---------- settings (editable in the UI, stored in the DB) ----------
const SETTINGS = {
  ratingBatchSize: { default: 50, min: 1, max: 1000 }, // titles (movies + TV shows) rated per IMDb sync
};
function getSettings() {
  return Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, store.getSetting(k, s.default)]));
}
function saveSettings(input) {
  for (const [k, s] of Object.entries(SETTINGS)) {
    if (input[k] === undefined) continue;
    const v = Math.round(Number(input[k]));
    if (!Number.isFinite(v) || v < s.min || v > s.max) {
      throw Object.assign(new Error(`${k} must be between ${s.min} and ${s.max}`), { status: 400 });
    }
    store.setSetting(k, v);
  }
  return getSettings();
}

// OMDb key: one saved from the UI (in the DB) wins over config.json.
const omdbKey = () => store.getSetting('omdbApiKey', null) || config.omdbApiKey || null;
const omdbKeySource = () => (store.getSetting('omdbApiKey', null) ? 'ui' : config.omdbApiKey ? 'config' : null);
const maskKey = (k) => (k ? `${'•'.repeat(Math.max(k.length - 4, 0))}${k.slice(-4)}` : null);

async function saveOmdbKey(body) {
  const key = String(body?.key ?? '').trim();
  if (!key) { // empty = remove the UI key and fall back to config.json
    store.setSetting('omdbApiKey', null);
    return { saved: true, source: omdbKeySource(), masked: maskKey(omdbKey()) };
  }
  if (!/^[A-Za-z0-9]{6,40}$/.test(key)) throw Object.assign(new Error('That does not look like an OMDb key'), { status: 400 });
  try {
    await omdbFetch('tt0111161', key); // test lookup before saving
  } catch (e) {
    throw Object.assign(new Error(`OMDb rejected this key: ${e.message}`), { status: 400 });
  }
  store.setSetting('omdbApiKey', key);
  store.setSetting('omdbUsage', { day: new Date().toISOString().slice(0, 10), count: 1 }); // new key, fresh daily quota
  return { saved: true, source: 'ui', masked: maskKey(key) };
}

// OMDb usage per day, persisted so restarts don't reset the count.
function omdbUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const u = store.getSetting('omdbUsage', { day: today, count: 0 });
  return u.day === today ? u : { day: today, count: 0 };
}
function countOmdbCall() { const u = omdbUsage(); u.count++; store.setSetting('omdbUsage', u); }

// Fetch IMDb ratings for titles (movies and TV shows) never looked up before, up to the configured batch size.
async function syncRatings(region) {
  if (!omdbKey()) throw new Error('No OMDb API key — add one in Sync & settings');
  const budget = OMDB_DAILY_LIMIT - omdbUsage().count;
  if (budget <= 0) return 'Daily OMDb budget used up — try again tomorrow';

  const batch = store.titlesNeedingRating(region, Math.min(getSettings().ratingBatchSize, budget));
  job.done = 0;
  job.total = batch.length;
  if (!batch.length) {
    return store.ratingStats(region).total
      ? 'Everything in this country already has an IMDb lookup'
      : 'Nothing stored for this country — sync the Netflix catalogue first';
  }
  let rated = 0, stopped = null;

  await pool(batch, 4, async (m) => {
    if (stopped) return;
    try {
      let imdbId = m.imdb_id;
      if (!imdbId) {
        imdbId = (await tmdbFetch(`/${m.kind}/${m.id}/external_ids`)).imdb_id || null;
        if (imdbId) store.stmt.setImdbId.run(imdbId, m.kind, m.id);
      }
      if (!imdbId) {
        store.stmt.setRating.run(null, null, store.now(), m.kind, m.id); // nothing to look up; never retried
      } else {
        countOmdbCall();
        const r = await omdbFetch(imdbId);
        store.stmt.setRating.run(r.rating, r.votes, store.now(), m.kind, m.id);
        if (r.rating != null) rated++;
      }
    } catch (e) {
      if (e.fatal) stopped = e.message;
      else console.warn(`Rating failed for ${m.kind} ${m.id}: ${e.message}`);
    }
    job.done++;
    job.message = `Rated ${job.done.toLocaleString()} of ${job.total.toLocaleString()}`;
  });
  if (stopped) throw new Error(`OMDb stopped: ${stopped} (${rated} ratings saved)`);
  return `Ratings updated: ${rated} of ${batch.length} titles`;
}

// ---------- routes ----------

async function fetchGenres() {
  const lists = await Promise.all(store.KINDS.map((k) => tmdbFetch(`/genre/${k}/list`, { language: 'en-US' })));
  const byId = new Map();
  for (const l of lists) for (const g of l.genres) if (!byId.has(g.id)) byId.set(g.id, g);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 864e5) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  return v;
}
const regionParam = (q) => (q.get('region') || config.defaultRegion || 'RO').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);

const routes = {
  'GET /api/regions': () =>
    cached('regions', async () => {
      const [regions, providers] = await Promise.all([
        tmdbFetch('/watch/providers/regions', { language: 'en-US' }),
        tmdbFetch('/watch/providers/movie', { language: 'en-US' }),
      ]);
      const netflix = providers.results.find((p) => p.provider_id === NETFLIX_PROVIDER_ID);
      const allowed = new Set(Object.keys(netflix?.display_priorities || {}));
      return regions.results
        .filter((r) => !allowed.size || allowed.has(r.iso_3166_1))
        .map((r) => ({ code: r.iso_3166_1, name: r.english_name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }),

  // Movie and TV genre lists merged (shared genres have the same id and name).
  'GET /api/genres': () => cached('genres', fetchGenres),

  // Everything stored for a region and kind (served from the DB, works offline).
  'GET /api/titles': (q) => {
    const region = regionParam(q);
    const kind = q.get('kind') === 'tv' ? 'tv' : 'movie';
    const { sync, titles } = store.listTitles(region, kind);
    return {
      region,
      kind,
      lastSync: sync && { startedAt: sync.started_at, finishedAt: sync.finished_at, total: sync.total, newTitles: sync.new_titles },
      ratings: store.ratingStats(region, kind),
      movies: titles.map((m) => ({
        ...m,
        genre_ids: JSON.parse(m.genre_ids || '[]'),
        thumb: m.poster_path ? `https://image.tmdb.org/t/p/w92${m.poster_path}` : null,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
      })),
    };
  },

  'GET /api/status': () => ({
    job, omdbConfigured: !!omdbKey(), omdbKeyMasked: maskKey(omdbKey()), omdbKeySource: omdbKeySource(), omdbUsedToday: omdbUsage().count, omdbDailyLimit: OMDB_DAILY_LIMIT,
    db: store.dbStats(),
  }),
  'GET /api/settings': () => getSettings(),
  'POST /api/settings': (q, body) => saveSettings(body || {}),
  'POST /api/omdb-key': (q, body) => {
    if (job.running) throw Object.assign(new Error('Wait for the current sync to finish'), { status: 409 });
    return saveOmdbKey(body);
  },
  'POST /api/sync/catalog': (q) => { const r = regionParam(q); return startJob('catalog', r, () => syncCatalog(r)); },
  'POST /api/sync/ratings': (q) => { const r = regionParam(q); return startJob('ratings', r, () => syncRatings(r)); },
  // Catalogue first, then one batch of ratings.
  'POST /api/sync/all': (q) => {
    const r = regionParam(q);
    return startJob('catalog + ratings', r, async () => {
      const a = await syncCatalog(r);
      if (!omdbKey()) return `${a} (ratings skipped: no OMDb key)`;
      job.message = 'Starting ratings…';
      return `${a} · ${await syncRatings(r)}`;
    });
  },
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(__dirname, 'public');

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      try {
        let body = null;
        if (req.method === 'POST') {
          let raw = '';
          for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
          try { body = raw ? JSON.parse(raw) : null; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
        }
        const data = await route(url.searchParams, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(e.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log(`Netflix catalogue running at http://localhost:${PORT}`));
