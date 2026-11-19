// SQLite storage using Node's built-in node:sqlite (no dependencies).
// Holds both movies and TV shows: a title is identified by (kind, id), where kind is 'movie' or 'tv',
// because TMDB numbers movies and TV shows separately and the same id can exist in both.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const KINDS = ['movie', 'tv'];
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'netflix.db'));

const TITLES_SQL = `
  CREATE TABLE IF NOT EXISTS titles (
    kind              TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    id                INTEGER NOT NULL,         -- TMDB id (unique per kind)
    title             TEXT NOT NULL,
    original_title    TEXT,
    year              TEXT,
    release_date      TEXT,                     -- first air date for TV shows
    poster_path       TEXT,
    overview          TEXT,
    genre_ids         TEXT,                     -- JSON array
    tmdb_rating       REAL,
    tmdb_votes        INTEGER,
    popularity        REAL,
    imdb_id           TEXT,
    imdb_rating       REAL,
    imdb_votes        INTEGER,
    added_at          TEXT NOT NULL,            -- first time we saw it anywhere
    updated_at        TEXT NOT NULL,            -- last time TMDB metadata changed
    rating_updated_at TEXT,                     -- last time IMDb rating was fetched
    lgbt              INTEGER,                  -- 1 = LGBT (TMDB keywords, Wikidata or description), 0 = none, NULL = not checked yet
    PRIMARY KEY (kind, id)
  )`;
const AVAIL_SQL = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    kind       TEXT NOT NULL,
    title_id   INTEGER NOT NULL,
    region     TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (kind, title_id, region),
    FOREIGN KEY (kind, title_id) REFERENCES titles(kind, id) ON DELETE CASCADE
  )`;

db.exec('PRAGMA journal_mode = WAL');

// ----- one-time migration from the movies-only schema -----
const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
if (tableExists('movies') && !tableExists('titles')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(TITLES_SQL);
    db.exec(`INSERT INTO titles (kind, id, title, original_title, year, release_date, poster_path, overview, genre_ids,
             tmdb_rating, tmdb_votes, popularity, imdb_id, imdb_rating, imdb_votes, added_at, updated_at, rating_updated_at)
             SELECT 'movie', id, title, original_title, year, release_date, poster_path, overview,
             genre_ids, tmdb_rating, tmdb_votes, popularity, imdb_id, imdb_rating, imdb_votes, added_at, updated_at,
             rating_updated_at FROM movies`);
    db.exec(AVAIL_SQL('availability_new'));
    db.exec(`INSERT INTO availability_new SELECT 'movie', movie_id, region, first_seen, last_seen FROM availability`);
    db.exec('DROP TABLE availability');
    db.exec('ALTER TABLE availability_new RENAME TO availability');
    db.exec('DROP TABLE movies');
    db.exec("ALTER TABLE catalog_syncs ADD COLUMN kind TEXT NOT NULL DEFAULT 'movie'");
    db.exec('COMMIT');
    console.log('Database migrated: movies → titles (movies and TV shows)');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`Database migration failed, nothing was changed: ${e.message}`);
  }
}
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  ${TITLES_SQL};
  ${AVAIL_SQL('availability')};
  CREATE INDEX IF NOT EXISTS idx_avail_region ON availability(region, kind, last_seen);

  -- One row per catalogue sync (per country and kind), so we know which titles are still current.
  CREATE TABLE IF NOT EXISTS catalog_syncs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    region      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    total       INTEGER,
    new_titles  INTEGER,
    error       TEXT,
    kind        TEXT NOT NULL DEFAULT 'movie'
  );

  -- Simple key/value settings, editable from the UI.
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Columns added after the first release of the titles table.
const titleCols = new Set(db.prepare('PRAGMA table_info(titles)').all().map((c) => c.name));
if (!titleCols.has('lgbt')) db.exec('ALTER TABLE titles ADD COLUMN lgbt INTEGER');

const now = () => new Date().toISOString();

const stmt = {
  getTitle: db.prepare('SELECT * FROM titles WHERE kind = ? AND id = ?'),
  insertTitle: db.prepare(`
    INSERT INTO titles (kind, id, title, original_title, year, release_date, poster_path, overview, genre_ids,
                        tmdb_rating, tmdb_votes, popularity, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateTitle: db.prepare(`
    UPDATE titles SET title = ?, original_title = ?, year = ?, release_date = ?, poster_path = ?, overview = ?,
                      genre_ids = ?, tmdb_rating = ?, tmdb_votes = ?, popularity = ?, updated_at = ?
    WHERE kind = ? AND id = ?`),
  touchPopularity: db.prepare('UPDATE titles SET tmdb_rating = ?, tmdb_votes = ?, popularity = ? WHERE kind = ? AND id = ?'),
  upsertAvail: db.prepare(`
    INSERT INTO availability (kind, title_id, region, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind, title_id, region) DO UPDATE SET last_seen = excluded.last_seen`),
  startSync: db.prepare('INSERT INTO catalog_syncs (region, kind, started_at) VALUES (?, ?, ?)'),
  finishSync: db.prepare('UPDATE catalog_syncs SET finished_at = ?, total = ?, new_titles = ?, error = ? WHERE id = ?'),
  lastSync: db.prepare(`SELECT * FROM catalog_syncs WHERE region = ? AND kind = ? AND finished_at IS NOT NULL AND error IS NULL
                        ORDER BY id DESC LIMIT 1`),
  setImdbId: db.prepare('UPDATE titles SET imdb_id = ? WHERE kind = ? AND id = ?'),
  setRating: db.prepare('UPDATE titles SET imdb_rating = ?, imdb_votes = ?, rating_updated_at = ? WHERE kind = ? AND id = ?'),
};

// Text is stored in one canonical form so it survives an Excel round trip unchanged:
// empty strings become NULL and \r\n / \r line breaks become \n.
const clean = (s) => (s == null || s === '' ? null : String(s).replace(/\r\n?/g, '\n'));

// One-time cleanup of rows saved before this rule existed (cheap no-op afterwards; doesn't touch updated_at).
for (const col of ['title', 'original_title', 'year', 'release_date', 'poster_path', 'overview']) {
  db.exec(`UPDATE titles SET ${col} = NULL WHERE ${col} = ''`);
}
db.exec(`UPDATE titles SET overview = replace(replace(overview, char(13) || char(10), char(10)), char(13), char(10))
         WHERE instr(overview, char(13)) > 0`);

// Save one TMDB discover result (movie or TV show). Only bumps updated_at when the metadata actually changed.
function saveTitle(kind, m, region, seenAt) {
  const date = m.release_date ?? m.first_air_date; // TV shows use name / first_air_date
  const row = [
    clean(m.title ?? m.name) || '(untitled)', clean(m.original_title ?? m.original_name), clean((date || '').slice(0, 4)),
    clean(date), clean(m.poster_path), clean(m.overview), JSON.stringify(m.genre_ids || []),
  ];
  const existing = stmt.getTitle.get(kind, m.id);
  let isNew = false;
  if (!existing) {
    stmt.insertTitle.run(kind, m.id, ...row, m.vote_average, m.vote_count, m.popularity, seenAt, seenAt);
    isNew = true;
  } else {
    const old = [existing.title, existing.original_title, existing.year, existing.release_date,
      existing.poster_path, existing.overview, existing.genre_ids];
    if (old.some((v, i) => v !== row[i])) {
      stmt.updateTitle.run(...row, m.vote_average, m.vote_count, m.popularity, seenAt, kind, m.id);
    } else {
      stmt.touchPopularity.run(m.vote_average, m.vote_count, m.popularity, kind, m.id);
    }
  }
  stmt.upsertAvail.run(kind, m.id, region, seenAt, seenAt);
  return isNew;
}

// Mark which titles of one kind in a region have LGBT-related keywords (ids = the TMDB ids that do).
// Titles seen in this sync but not in the list are set to 0, so tags that TMDB removes disappear too.
function setLgbtTags(region, kind, seenAt, ids) {
  transaction(() => {
    db.prepare(`UPDATE titles SET lgbt = 0 WHERE kind = ? AND id IN
                (SELECT title_id FROM availability WHERE region = ? AND kind = ? AND last_seen >= ?)`).run(kind, region, kind, seenAt);
    const mark = db.prepare('UPDATE titles SET lgbt = 1 WHERE kind = ? AND id = ?');
    for (const id of ids) mark.run(kind, id);
  });
}

function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Titles currently on Netflix in a region = seen in the latest successful sync of that kind.
function listTitles(region, kind) {
  const sync = stmt.lastSync.get(region, kind);
  if (!sync) return { sync: null, titles: [] };
  const titles = db.prepare(`
    SELECT t.id, t.title, t.year, t.poster_path, t.overview, t.genre_ids, t.tmdb_rating, t.popularity,
           t.imdb_id, t.imdb_rating, t.imdb_votes, t.added_at, t.updated_at, t.rating_updated_at, t.lgbt,
           a.first_seen
    FROM availability a JOIN titles t ON t.kind = a.kind AND t.id = a.title_id
    WHERE a.region = ? AND a.kind = ? AND a.last_seen >= ?`).all(region, kind, sync.started_at);
  return { sync, titles };
}

// Next batch of titles (movies and TV shows) that have never had an IMDb lookup, most popular first.
// Once a lookup is done (even if IMDb has no rating) the title is never fetched again.
function titlesNeedingRating(region, limit) {
  return db.prepare(`
    SELECT t.kind, t.id, t.imdb_id FROM titles t
    JOIN availability a ON a.kind = t.kind AND a.title_id = t.id AND a.region = ?
    WHERE t.rating_updated_at IS NULL
    ORDER BY t.popularity DESC
    LIMIT ?`).all(region, limit);
}

// Whole-database counts, across all countries.
function dbStats() {
  const s = db.prepare(`
    SELECT COUNT(*) titles, SUM(kind = 'movie') movies, SUM(kind = 'tv') shows,
           COUNT(imdb_rating) rated, COUNT(rating_updated_at) checked, COUNT(*) - COUNT(rating_updated_at) pending
    FROM titles`).get();
  return { ...s, movies: s.movies || 0, shows: s.shows || 0 };
}

function ratingStats(region, kind) {
  return db.prepare(`
    SELECT COUNT(*) total, COUNT(t.imdb_rating) rated, COUNT(t.rating_updated_at) checked, MAX(t.rating_updated_at) last
    FROM availability a JOIN titles t ON t.kind = a.kind AND t.id = a.title_id
    WHERE a.region = ? AND (? IS NULL OR a.kind = ?)`).get(region, kind ?? null, kind ?? null);
}

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const getSetting = (key, fallback) => { const r = getSettingStmt.get(key); return r ? JSON.parse(r.value) : fallback; };
const setSetting = (key, value) => setSettingStmt.run(key, JSON.stringify(value));

module.exports = {
  db, stmt, now, KINDS, saveTitle, setLgbtTags, transaction, listTitles, titlesNeedingRating, ratingStats, dbStats, getSetting, setSetting,
};
