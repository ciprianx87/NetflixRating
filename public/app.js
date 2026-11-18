const $ = (s) => document.querySelector(s);
const rowsEl = $('#rows'), statusEl = $('#status'), syncInfo = $('#syncinfo'), jobMsg = $('#jobmsg');
const regionSel = $('#region'), filterInput = $('#filter'), minRatingSel = $('#minRating'), genreSel = $('#genre');
const btnCatalog = $('#syncCatalog'), btnRatings = $('#syncRatings'), progress = $('#progress');

const state = { region: 'RO', movies: [], genres: {}, sort: { key: 'imdb_rating', dir: -1 }, data: null, polling: false };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const savePrefs = () => { try { localStorage.setItem('prefs', JSON.stringify({ region: state.region, sort: state.sort })); } catch {} };

function render() {
  const q = filterInput.value.trim().toLowerCase();
  const min = Number(minRatingSel.value);
  const genre = Number(genreSel.value) || null;
  const { key, dir } = state.sort;
  const list = state.movies
    .filter((m) => (!q || m.title.toLowerCase().includes(q)) && (!min || (m.imdb_rating ?? 0) >= min) && (!genre || m.genre_ids.includes(genre)))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1; // blanks always last
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });

  const lastSyncStart = state.data?.lastSync?.startedAt;
  rowsEl.innerHTML = list.map((m) => {
    const genres = m.genre_ids.map((id) => state.genres[id]).filter(Boolean).slice(0, 3).join(', ');
    const imdb = m.imdb_rating != null
      ? `<a class="imdb" href="https://www.imdb.com/title/${esc(m.imdb_id)}/" target="_blank" rel="noopener">${m.imdb_rating.toFixed(1)}</a>`
      : `<span class="imdb none">${m.rating_updated_at ? 'n/a' : '—'}</span>`;
    const isNew = lastSyncStart && m.first_seen === lastSyncStart && state.data.lastSync.newTitles < state.movies.length;
    return `<tr title="${esc(m.overview)}">
      <td>${m.thumb ? `<img class="thumb" loading="lazy" src="${esc(m.thumb)}" alt="">` : '<div class="thumb"></div>'}</td>
      <td><div class="t-title">${esc(m.title)}${isNew ? '<span class="new">NEW</span>' : ''}</div><div class="t-orig">${esc(m.overview)}</div></td>
      <td class="num">${esc(m.year) || '—'}</td>
      <td class="genres c-genre">${esc(genres)}</td>
      <td class="num">${imdb}</td>
      <td class="num c-votes">${m.imdb_votes != null ? m.imdb_votes.toLocaleString() : ''}</td>
      <td class="num c-tmdb">${m.tmdb_rating ? m.tmdb_rating.toFixed(1) : ''}</td>
      <td class="date c-date">${fmtDate(m.first_seen)}</td>
      <td class="date c-date">${m.rating_updated_at ? fmtDate(m.rating_updated_at) : '—'}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('asc', th.dataset.sort === key && dir === 1);
    th.classList.toggle('desc', th.dataset.sort === key && dir === -1);
  });

  statusEl.className = 'status';
  statusEl.textContent = !state.data?.lastSync
    ? 'No data stored for this country yet. Click “Sync catalogue” to fetch it from TMDB.'
    : list.length ? '' : 'No titles match your filters.';
  const d = state.data;
  if (d?.lastSync) {
    const name = regionSel.selectedOptions[0]?.textContent || state.region;
    syncInfo.innerHTML = `<strong>${list.length.toLocaleString()}</strong> of <strong>${state.movies.length.toLocaleString()}</strong> movies on Netflix in <strong>${esc(name)}</strong>
      · catalogue synced ${fmtDateTime(d.lastSync.finishedAt)}
      · IMDb ratings ${d.ratings.rated.toLocaleString()}/${d.ratings.total.toLocaleString()} (last ${fmtDateTime(d.ratings.last)})`;
  } else {
    syncInfo.textContent = 'Not synced yet';
  }
}

async function loadRegion() {
  rowsEl.innerHTML = '';
  statusEl.textContent = 'Loading…';
  try {
    state.data = await api(`/api/movies?region=${state.region}`);
    state.movies = state.data.movies;
    render();
  } catch (e) {
    statusEl.className = 'status error';
    statusEl.textContent = `Error: ${e.message}`;
  }
}

// ----- sync jobs -----
function showJob(s) {
  const j = s.job;
  btnCatalog.disabled = btnRatings.disabled = j.running;
  btnRatings.title = s.omdbConfigured ? `OMDb used today: ${s.omdbUsedToday}/${s.omdbDailyLimit}` : 'Add omdbApiKey to config.json';
  if (!s.omdbConfigured) btnRatings.disabled = true;
  jobMsg.className = 'jobmsg' + (j.error ? ' error' : '');
  jobMsg.textContent = j.error ? `${j.message}: ${j.error}` : j.running || j.finishedAt ? `${j.region} · ${j.message}` : '';
  progress.classList.toggle('on', j.running);
  progress.firstElementChild.style.width = j.total ? `${Math.round((j.done / j.total) * 100)}%` : '5%';
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  let lastDone = -1;
  try {
    for (;;) {
      const s = await api('/api/status');
      showJob(s);
      // Refresh the grid periodically while ratings stream in, and once at the end.
      if (s.job.region === state.region && (!s.job.running || s.job.done - lastDone >= 50)) {
        lastDone = s.job.done;
        await loadRegion();
      }
      if (!s.job.running) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally { state.polling = false; }
}

async function start(kind) {
  try {
    await api(`/api/sync/${kind}?region=${state.region}`, { method: 'POST' });
    poll();
  } catch (e) {
    jobMsg.className = 'jobmsg error';
    jobMsg.textContent = e.message;
  }
}

// Keep the sticky table header just under the sticky top bar, whatever its height.
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--topbar-h', `${e.target.offsetHeight}px`))
  .observe(document.querySelector('.topbar'));

async function init() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('prefs')) || {}; } catch {}
  if (prefs.sort?.key) state.sort = prefs.sort;
  try {
    const [regions, genres] = await Promise.all([api('/api/regions'), api('/api/genres')]);
    genres.forEach((g) => (state.genres[g.id] = g.name));
    genreSel.innerHTML += genres.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    regionSel.innerHTML = regions.map((r) => `<option value="${r.code}">${esc(r.name)}</option>`).join('');
  } catch (e) {
    // TMDB unreachable: still allow browsing what's stored.
    regionSel.innerHTML = `<option value="${prefs.region || 'RO'}">${prefs.region || 'RO'}</option>`;
    jobMsg.className = 'jobmsg error';
    jobMsg.textContent = `TMDB unreachable (${e.message}) — showing stored data`;
  }
  state.region = prefs.region && regionSel.querySelector(`[value="${prefs.region}"]`) ? prefs.region : 'RO';
  regionSel.value = state.region;

  regionSel.onchange = () => { state.region = regionSel.value; savePrefs(); loadRegion(); };
  filterInput.oninput = minRatingSel.onchange = genreSel.onchange = render;
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'title' ? 1 : -1 };
    savePrefs(); render();
  }));
  btnCatalog.onclick = () => start('catalog');
  btnRatings.onclick = () => start('ratings');

  await loadRegion();
  showJob(await api('/api/status'));
  poll(); // resume progress display if a job is already running
}

init();
