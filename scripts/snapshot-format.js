// Shared definition of the Excel snapshot: which sheets exist and which columns get restored.
// Columns marked `info: true` are only for reading/filtering in Excel and are ignored on restore.
// Columns with a `default` may be missing (older snapshots); the default is used instead.
//
// Version history:
//   1 – movies only: "Movies" sheet, no Type column
//   2 – movies and TV shows: "Titles" sheet, Type column (movie / tv) on Titles, Availability and Syncs
//       (+ optional "LGBT themes" column on Titles: 1 / 0 / empty)

const FORMAT_VERSION = 2;
const TYPE_COL = { key: 'kind', header: 'Type', type: 'text', width: 8, default: 'movie' };

const SHEETS = {
  titles: {
    sheet: 'Titles',
    legacySheet: 'Movies', // name used by format 1
    columns: [
      TYPE_COL,
      { key: 'id', header: 'TMDB id', type: 'int', width: 10 },
      { key: 'title', header: 'Title', type: 'text', width: 40 },
      { key: 'year', header: 'Year', type: 'text', width: 7 },
      { key: 'imdb_rating', header: 'IMDb rating', type: 'real', width: 11 },
      { key: 'imdb_votes', header: 'IMDb votes', type: 'int', width: 12, numFmt: '#,##0' },
      { key: 'genres', header: 'Genres', info: true, width: 30 },
      { key: 'countries', header: 'Countries', info: true, width: 12 },
      { key: 'imdb_url', header: 'IMDb link', info: true, width: 12 },
      { key: 'lgbt', header: 'LGBT themes', type: 'int', width: 12, default: null }, // 1 / 0 / empty = not checked
      { key: 'tmdb_rating', header: 'TMDB rating', type: 'real', width: 11 },
      { key: 'tmdb_votes', header: 'TMDB votes', type: 'int', width: 11, numFmt: '#,##0' },
      { key: 'popularity', header: 'Popularity', type: 'real', width: 11 },
      { key: 'original_title', header: 'Original title', type: 'text', width: 30 },
      { key: 'release_date', header: 'Release date', type: 'text', width: 12 },
      { key: 'imdb_id', header: 'IMDb id', type: 'text', width: 12 },
      { key: 'added_at', header: 'Added at', type: 'text', width: 25 },
      { key: 'updated_at', header: 'Updated at', type: 'text', width: 25 },
      { key: 'rating_updated_at', header: 'Rating checked at', type: 'text', width: 25 },
      { key: 'genre_ids', header: 'Genre ids', type: 'text', width: 14 },
      { key: 'poster_path', header: 'Poster path', type: 'text', width: 20 },
      { key: 'overview', header: 'Overview', type: 'text', width: 80 },
    ],
  },
  availability: {
    sheet: 'Availability',
    columns: [
      TYPE_COL,
      { key: 'title_id', header: 'TMDB id', type: 'int', width: 10 },
      { key: 'title', header: 'Title', info: true, width: 40 },
      { key: 'region', header: 'Country', type: 'text', width: 9 },
      { key: 'first_seen', header: 'First seen', type: 'text', width: 25 },
      { key: 'last_seen', header: 'Last seen', type: 'text', width: 25 },
    ],
  },
  catalog_syncs: {
    sheet: 'Syncs',
    columns: [
      { key: 'id', header: 'Id', type: 'int', width: 6 },
      { key: 'region', header: 'Country', type: 'text', width: 9 },
      TYPE_COL,
      { key: 'started_at', header: 'Started at', type: 'text', width: 25 },
      { key: 'finished_at', header: 'Finished at', type: 'text', width: 25 },
      { key: 'total', header: 'Titles', type: 'int', width: 9 },
      { key: 'new_titles', header: 'New titles', type: 'int', width: 10 },
      { key: 'error', header: 'Error', type: 'text', width: 40 },
    ],
  },
};

// Settings that are safe to share. The OMDb key and usage counter are never exported.
const EXPORTED_SETTINGS = ['ratingBatchSize'];

module.exports = { FORMAT_VERSION, SHEETS, EXPORTED_SETTINGS };
