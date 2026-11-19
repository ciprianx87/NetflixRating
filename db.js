// SQLite storage using Node's built-in node:sqlite (no dependencies).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'netflix.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS movies (
    id                INTEGER PRIMARY KEY,      -- TMDB id
    title             TEXT NOT NULL,
    original_title    TEXT,
    year              TEXT,
    release_date      TEXT,
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
    rating_updated_at TEXT                      -- last time IMDb rating was fetched
  );

  -- Which countries a movie is on Netflix in, and when we saw it there.
  CREATE TABLE IF NOT EXISTS availability (
    movie_id   INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    region     TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (movie_id, region)
  );
  CREATE INDEX IF NOT EXISTS idx_avail_region ON availability(region, last_seen);

  -- One row per catalogue sync, so we know which titles are still current.
  CREATE TABLE IF NOT EXISTS catalog_syncs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    region      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    total       INTEGER,
    new_titles  INTEGER,
    error       TEXT
  );
`);

const now = () => new Date().toISOString();

const stmt = {
  getMovie: db.prepare('SELECT * FROM movies WHERE id = ?'),
  insertMovie: db.prepare(`
    INSERT INTO movies (id, title, original_title, year, release_date, poster_path, overview, genre_ids,
                        tmdb_rating, tmdb_votes, popularity, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateMovie: db.prepare(`
    UPDATE movies SET title = ?, original_title = ?, year = ?, release_date = ?, poster_path = ?, overview = ?,
                      genre_ids = ?, tmdb_rating = ?, tmdb_votes = ?, popularity = ?, updated_at = ?
    WHERE id = ?`),
  touchPopularity: db.prepare('UPDATE movies SET tmdb_rating = ?, tmdb_votes = ?, popularity = ? WHERE id = ?'),
  upsertAvail: db.prepare(`
    INSERT INTO availability (movie_id, region, first_seen, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(movie_id, region) DO UPDATE SET last_seen = excluded.last_seen`),
  startSync: db.prepare('INSERT INTO catalog_syncs (region, started_at) VALUES (?, ?)'),
  finishSync: db.prepare('UPDATE catalog_syncs SET finished_at = ?, total = ?, new_titles = ?, error = ? WHERE id = ?'),
  lastSync: db.prepare(`SELECT * FROM catalog_syncs WHERE region = ? AND finished_at IS NOT NULL AND error IS NULL
                        ORDER BY id DESC LIMIT 1`),
  setImdbId: db.prepare('UPDATE movies SET imdb_id = ? WHERE id = ?'),
  setRating: db.prepare('UPDATE movies SET imdb_rating = ?, imdb_votes = ?, rating_updated_at = ? WHERE id = ?'),
};

// Text is stored in one canonical form so it survives an Excel round trip unchanged:
// empty strings become NULL and \r\n / \r line breaks become \n.
const clean = (s) => (s == null || s === '' ? null : String(s).replace(/\r\n?/g, '\n'));

// One-time cleanup of rows saved before this rule existed (cheap no-op afterwards).
for (const col of ['title', 'original_title', 'year', 'release_date', 'poster_path', 'overview']) {
  db.exec(`UPDATE movies SET ${col} = NULL WHERE ${col} = ''`);
}
db.exec(`UPDATE movies SET overview = replace(replace(overview, char(13) || char(10), char(10)), char(13), char(10))
         WHERE instr(overview, char(13)) > 0`);

// Save one TMDB discover result. Only bumps updated_at when the metadata actually changed.
function saveMovie(m, region, seenAt) {
  const row = [
    clean(m.title) || '(untitled)', clean(m.original_title), clean((m.release_date || '').slice(0, 4)), clean(m.release_date),
    clean(m.poster_path), clean(m.overview), JSON.stringify(m.genre_ids || []),
  ];
  const existing = stmt.getMovie.get(m.id);
  let isNew = false;
  if (!existing) {
    stmt.insertMovie.run(m.id, ...row, m.vote_average, m.vote_count, m.popularity, seenAt, seenAt);
    isNew = true;
  } else {
    const old = [existing.title, existing.original_title, existing.year, existing.release_date,
      existing.poster_path, existing.overview, existing.genre_ids];
    if (old.some((v, i) => v !== row[i])) {
      stmt.updateMovie.run(...row, m.vote_average, m.vote_count, m.popularity, seenAt, m.id);
    } else {
      stmt.touchPopularity.run(m.vote_average, m.vote_count, m.popularity, m.id);
    }
  }
  stmt.upsertAvail.run(m.id, region, seenAt, seenAt);
  return isNew;
}

function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Movies currently on Netflix in a region = seen in the latest successful sync.
function listMovies(region) {
  const sync = stmt.lastSync.get(region);
  if (!sync) return { sync: null, movies: [] };
  const movies = db.prepare(`
    SELECT m.id, m.title, m.year, m.poster_path, m.overview, m.genre_ids, m.tmdb_rating, m.popularity,
           m.imdb_id, m.imdb_rating, m.imdb_votes, m.added_at, m.updated_at, m.rating_updated_at,
           a.first_seen
    FROM availability a JOIN movies m ON m.id = a.movie_id
    WHERE a.region = ? AND a.last_seen >= ?`).all(region, sync.started_at);
  return { sync, movies };
}

// Next batch of movies that have never had an IMDb lookup (most popular first).
// Once a lookup is done (even if IMDb has no rating) the movie is never fetched again.
function moviesNeedingRating(region, limit) {
  return db.prepare(`
    SELECT m.id, m.imdb_id FROM movies m
    JOIN availability a ON a.movie_id = m.id AND a.region = ?
    WHERE m.rating_updated_at IS NULL
    ORDER BY m.popularity DESC
    LIMIT ?`).all(region, limit);
}

// Whole-database counts, across all countries.
function dbStats() {
  return db.prepare(`
    SELECT COUNT(*) movies, COUNT(imdb_rating) rated, COUNT(rating_updated_at) checked,
           COUNT(*) - COUNT(rating_updated_at) pending
    FROM movies`).get();
}

// Simple key/value settings, editable from the UI.
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                                   ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
const getSetting = (key, fallback) => { const r = getSettingStmt.get(key); return r ? JSON.parse(r.value) : fallback; };
const setSetting = (key, value) => setSettingStmt.run(key, JSON.stringify(value));

function ratingStats(region) {
  return db.prepare(`
    SELECT COUNT(*) total, COUNT(m.imdb_rating) rated, COUNT(m.rating_updated_at) checked, MAX(m.rating_updated_at) last
    FROM availability a JOIN movies m ON m.id = a.movie_id WHERE a.region = ?`).get(region);
}

module.exports = { db, stmt, now, saveMovie, transaction, listMovies, moviesNeedingRating, ratingStats, dbStats, getSetting, setSetting };
