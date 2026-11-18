# NetflixRating

Browse every movie on Netflix in a given country, with IMDb ratings, stored locally in SQLite so you can view the list any time.

- Catalogue: TMDB watch-provider data (powered by JustWatch)
- Ratings: OMDb (IMDb rating + vote count)
- Storage: `data/netflix.db` (Node's built-in `node:sqlite`, no dependencies; needs Node 22.13+)

## Setup
1. TMDB key (free): https://www.themoviedb.org/settings/api (v3 key or v4 read access token both work).
2. OMDb key (free, 1,000 requests/day): https://www.omdbapi.com/apikey.aspx and choose FREE. The key arrives by email and must be activated through the link in that email.
3. `cp config.example.json config.json` and paste both keys.
4. `npm start` and open http://localhost:3000

## Using it
- **Sync catalogue** fetches every Netflix movie for the selected country from TMDB and stores it. New titles are recorded with the date they were first seen; titles that leave Netflix drop off the list but stay in the database.
- **Refresh IMDb ratings** rates titles with no rating first, then those older than `ratingRefreshDays`, up to `omdbDailyLimit` OMDb calls per run/day. A large catalogue (e.g. ~6,900 titles in Romania) takes several days of runs to fully rate on the free tier.

## Database
| table | contents |
|---|---|
| `movies` | TMDB metadata, `imdb_id`, `imdb_rating`, `imdb_votes`, `added_at`, `updated_at` (metadata changed), `rating_updated_at` (IMDb rating last fetched) |
| `availability` | per movie and country: `first_seen`, `last_seen` |
| `catalog_syncs` | history of each catalogue sync |

`config.json` and `data/` are git-ignored.
