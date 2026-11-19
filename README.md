# NetflixRating

Browse every movie and TV show on Netflix in a given country, with IMDb ratings, stored locally in SQLite so you can view the list any time.

- Catalogue: TMDB watch-provider data (powered by JustWatch)
- Ratings: OMDb (IMDb rating + vote count)
- Storage: `data/netflix.db` (Node's built-in `node:sqlite`, no dependencies; needs Node 22.13+)

## Setup
1. TMDB key (free): https://www.themoviedb.org/settings/api (v3 key or v4 read access token both work).
2. OMDb key (free, 1,000 requests/day): https://www.omdbapi.com/apikey.aspx and choose FREE. The key arrives by email and must be activated through the link in that email.
3. `cp config.example.json config.json` and paste the TMDB key. The OMDb key can go here too, or be added later in the **Sync & settings** tab (a key saved there is tested first and overrides config.json).
4. `npm start` and open http://localhost:3000

## Using it
The **Browse** tab shows the stored list, with a **Movies / TV shows** switch; the **Sync & settings** tab has the database stats, sync buttons, configuration and OMDb key.
- **Sync catalogue** fetches every Netflix movie and TV show for the selected country from TMDB and stores it. New titles are recorded with the date they were first seen; titles that leave Netflix drop off the list but stay in the database.
- **Sync IMDb ratings** looks up the next N titles (movies and TV shows together) (set in the Configuration section, default 50) that have never been looked up, most popular first. A title is looked up only once; if IMDb has no rating it is recorded and skipped from then on. `omdbDailyLimit` caps total OMDb calls per day.
- **Sync both** runs the catalogue sync, then one batch of ratings.

## Database
| table | contents |
|---|---|
| `titles` | movies and TV shows (`kind` = movie / tv, keyed by kind + TMDB id): TMDB metadata, `imdb_id`, `imdb_rating`, `imdb_votes`, `added_at`, `updated_at` (metadata changed), `rating_updated_at` (IMDb rating last fetched) |
| `settings` | UI configuration (e.g. `ratingBatchSize`) and the daily OMDb call counter |
| `availability` | per title and country: `first_seen`, `last_seen` |
| `catalog_syncs` | history of each catalogue sync (per country and kind) |

`config.json` and `data/` are git-ignored.

## Snapshots (Excel)
```bash
npm run export     # data/netflix.db → snapshots/netflix.xlsx
npm run restore    # snapshots/netflix.xlsx → data/netflix.db
```
Both accept a file path, e.g. `npm run export -- snapshots/2026-11-19.xlsx`.

- The workbook has **Titles** (with a Type column: movie / tv), **Availability**, **Syncs** and **Info** sheets, with filters and a frozen header row, so you can filter it in Excel.
- Red column headers are restored; grey ones (Genres, Countries, IMDb link, and the title on the Availability sheet) are for reading only.
- The OMDb key and the daily call counter are **never exported**, so the snapshot is safe to commit. On restore, the key saved in your current database is kept.
- Restore checks the whole file before changing anything, refuses to run while the server is running, and moves the current database to `data/backups/` first.
- Empty values and line breaks are stored in a form that survives the round trip, so a restore gives back exactly the same rows.

## Read-only site on GitHub Pages
A copy of the Browse view (movies and TV shows) your friends can open on any device, phone included. It has no server, no sync buttons and no API keys: the page reads JSON files built from your local database.

To update it after syncing:
```bash
npm run build:static   # writes docs/ from data/netflix.db
git add docs && git commit -m "Update site data" && git push
```
One-time setup: on GitHub, open **Settings → Pages**, set **Source** to *Deploy from a branch*, choose **main** and **/docs**, then save. The site appears at `https://<user>.github.io/NetflixRating/` within a minute or two.

Free GitHub accounts can only use Pages on public repositories, so the repo (including the Excel snapshot) is visible to anyone.

Older movies-only snapshots (format 1) can still be restored; every row is treated as a movie. A database from before TV support is migrated automatically the first time the server, export or build runs.

## LGBT themes filter
Each catalogue sync also asks TMDB which Netflix titles carry LGBT-related keywords (lgbt, lesbian, gay theme, transgender, queer, drag queen, coming out and similar; the list is `LGBT_KEYWORDS` in `server.js`). Those titles get `lgbt = 1` in the database, and the **LGBT themes** filter can show all titles, hide them, or show only them. TMDB keywords are added by its community, so coverage is good but not complete.
