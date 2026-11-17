// Minimal dependency-free server: serves /public and proxies TMDB so the API key stays server-side.
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json — copy config.example.json to config.json and add your TMDB key.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = config.port || 3000;
const NETFLIX_PROVIDER_ID = 8; // TMDB watch-provider id for Netflix
const TMDB = 'https://api.themoviedb.org/3';

// Accept either a v4 read access token (long JWT) or a v3 api key.
function tmdbFetch(endpoint, params = {}) {
  const url = new URL(TMDB + endpoint);
  const headers = { accept: 'application/json' };
  const key = config.tmdbApiKey || '';
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { headers }).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw Object.assign(new Error(body.status_message || r.statusText), { status: r.status });
    return body;
  });
}

// Simple in-memory cache (TMDB data changes slowly).
const cache = new Map();
const TTL = 60 * 60 * 1000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  return v;
}

const routes = {
  // Countries where Netflix has a catalogue on TMDB.
  '/api/regions': () =>
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

  '/api/genres': () =>
    cached('genres', async () => (await tmdbFetch('/genre/movie/list', { language: 'en-US' })).genres),

  // Movies on Netflix in a region, paginated (20 per page).
  '/api/movies': (q) => {
    const region = (q.get('region') || config.defaultRegion || 'RO').toUpperCase().slice(0, 2);
    const page = Math.min(Math.max(parseInt(q.get('page'), 10) || 1, 1), 500);
    const sort = ['popularity.desc', 'primary_release_date.desc', 'vote_average.desc', 'title.asc'].includes(q.get('sort'))
      ? q.get('sort')
      : 'popularity.desc';
    return cached(`movies:${region}:${page}:${sort}`, async () => {
      const d = await tmdbFetch('/discover/movie', {
        watch_region: region,
        with_watch_providers: NETFLIX_PROVIDER_ID,
        with_watch_monetization_types: 'flatrate',
        include_adult: 'false',
        language: 'en-US',
        sort_by: sort,
        ...(sort === 'vote_average.desc' ? { 'vote_count.gte': 200 } : {}),
        page,
      });
      return {
        page: d.page,
        totalPages: Math.min(d.total_pages, 500),
        totalResults: d.total_results,
        results: d.results.map((m) => ({
          id: m.id,
          title: m.title,
          year: (m.release_date || '').slice(0, 4),
          poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
          overview: m.overview,
          genreIds: m.genre_ids,
        })),
      };
    });
  },
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(__dirname, 'public');

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes[url.pathname];
    if (route) {
      try {
        const data = await route(url.searchParams);
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
