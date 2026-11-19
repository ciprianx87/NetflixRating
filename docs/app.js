const $ = (s) => document.querySelector(s);
const rowsEl = $('#rows'), statusEl = $('#status'), syncInfo = $('#syncinfo'), jobMsg = $('#jobmsg');
const regionSel = $('#region'), filterInput = $('#filter'), minRatingSel = $('#minRating'), genreSel = $('#genre');
const btnCatalog = $('#syncCatalog'), btnRatings = $('#syncRatings'), btnAll = $('#syncAll'), progress = $('#progress');
const batchInput = $('#ratingBatchSize'), settingsForm = $('#settingsForm'), settingsMsg = $('#settingsMsg');

// STATIC_SITE is set by scripts/build-static.js for the read-only GitHub Pages copy.
const STATIC = !!window.STATIC_SITE;
const CHUNK = 120; // rows rendered at a time; more are added while scrolling

const state = { region: 'RO', movies: [], list: [], shown: 0, genres: {}, sort: { key: 'imdb_rating', dir: -1 }, data: null, polling: false };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

// Same calls for both modes: the live server API, or the JSON files written by the static build.
const source = STATIC
  ? {
      regions: () => api('data/regions.json'),
      genres: () => api('data/genres.json'),
      movies: (region) => api(`data/movies-${region}.json`),
    }
  : {
      regions: () => api('/api/regions'),
      genres: () => api('/api/genres'),
      movies: (region) => api(`/api/movies?region=${region}`),
    };
const thumbUrl = (p) => (p ? `https://image.tmdb.org/t/p/w92${p}` : null);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const savePrefs = () => { try { localStorage.setItem('prefs', JSON.stringify({ region: state.region, sort: state.sort })); } catch {} };

const fmtVotes = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));

function rowHtml(m) {
  const genres = m.genre_ids.map((id) => state.genres[id]).filter(Boolean).slice(0, 3).join(', ');
  const imdb = m.imdb_rating != null
    ? `<a class="imdb" href="https://www.imdb.com/title/${esc(m.imdb_id)}/" target="_blank" rel="noopener">${m.imdb_rating.toFixed(1)}</a>`
    : `<span class="imdb none">${m.rating_updated_at ? 'n/a' : '—'}</span>`;
  const lastSync = state.data?.lastSync;
  const isNew = lastSync && m.first_seen === lastSync.startedAt && lastSync.newTitles < state.movies.length;
  const thumb = m.thumb || thumbUrl(m.poster_path);
  // Phone layout shows this one line instead of the separate columns.
  const meta = [m.year, genres, m.imdb_votes != null ? `${fmtVotes(m.imdb_votes)} votes` : ''].filter(Boolean).join(' · ');
  return `<tr title="${esc(m.overview)}">
    <td class="c-thumb">${thumb ? `<img class="thumb" loading="lazy" src="${esc(thumb)}" alt="">` : '<div class="thumb"></div>'}</td>
    <td class="c-title"><div class="t-title">${esc(m.title)}${isNew ? '<span class="new">NEW</span>' : ''}</div>
      <div class="t-meta">${esc(meta)}</div><div class="t-orig">${esc(m.overview)}</div></td>
    <td class="num c-year">${esc(m.year) || '—'}</td>
    <td class="genres c-genre">${esc(genres)}</td>
    <td class="num c-imdb">${imdb}</td>
    <td class="num c-votes">${m.imdb_votes != null ? m.imdb_votes.toLocaleString() : ''}</td>
    <td class="num c-tmdb">${m.tmdb_rating ? m.tmdb_rating.toFixed(1) : ''}</td>
    <td class="date c-date">${fmtDate(m.first_seen)}</td>
    <td class="date c-date">${m.rating_updated_at ? fmtDate(m.rating_updated_at) : '—'}</td>
  </tr>`;
}

// Append the next chunk of rows (called on render and when the bottom comes into view).
function showMore() {
  if (state.shown >= state.list.length) return;
  const next = state.list.slice(state.shown, state.shown + CHUNK);
  rowsEl.insertAdjacentHTML('beforeend', next.map(rowHtml).join(''));
  state.shown += next.length;
}

function render() {
  const q = filterInput.value.trim().toLowerCase();
  const min = Number(minRatingSel.value);
  const genre = Number(genreSel.value) || null;
  const minVotes = Number($('#minVotes').value);
  const { key, dir } = state.sort;
  const list = state.movies
    .filter((m) => (!q || m.title.toLowerCase().includes(q)) && (!min || (m.imdb_rating ?? 0) >= min) && (!genre || m.genre_ids.includes(genre)) && (!minVotes || (m.imdb_votes ?? 0) >= minVotes))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1; // blanks always last
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });

  state.list = list;
  state.shown = 0;
  rowsEl.innerHTML = '';
  showMore();

  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('asc', th.dataset.sort === key && dir === 1);
    th.classList.toggle('desc', th.dataset.sort === key && dir === -1);
  });
  const sortSel = $('#sortSel');
  const sortVal = `${key}:${dir}`;
  if (![...sortSel.options].some((o) => o.value === sortVal)) {
    sortSel.add(new Option(document.querySelector(`th[data-sort="${key}"]`)?.textContent + (dir === 1 ? ' ↑' : ' ↓'), sortVal));
  }
  sortSel.value = sortVal;
  const active = [min, minVotes, genre].filter(Boolean).length;
  $('#filtersToggle').textContent = active ? `Filters (${active})` : 'Filters';

  statusEl.className = 'status';
  statusEl.textContent = !state.data?.lastSync
    ? (STATIC ? 'No data for this country.' : 'No data stored for this country yet. Open “Sync & settings” and click “Sync Netflix catalogue”.')
    : list.length ? '' : 'No titles match your filters.';
  const d = state.data;
  if (d?.lastSync) {
    const name = regionSel.selectedOptions[0]?.textContent || state.region;
    syncInfo.innerHTML = `<strong>${list.length.toLocaleString()}</strong> of <strong>${state.movies.length.toLocaleString()}</strong> movies on Netflix in <strong>${esc(name)}</strong>
      <span class="more-info">· catalogue updated ${fmtDateTime(d.lastSync.finishedAt)}
      · ${d.ratings.rated.toLocaleString()} with IMDb rating${STATIC ? '' : `, ${(d.ratings.total - d.ratings.checked).toLocaleString()} waiting (last lookup ${fmtDateTime(d.ratings.last)})`}</span>`;
  } else {
    syncInfo.textContent = 'Not synced yet';
  }
}

async function loadRegion() {
  rowsEl.innerHTML = '';
  statusEl.textContent = 'Loading…';
  try {
    state.data = await source.movies(state.region);
    state.movies = state.data.movies;
    render();
  } catch (e) {
    statusEl.className = 'status error';
    statusEl.textContent = `Error: ${e.message}`;
  }
}

// ----- sync jobs -----
function showStats(s) {
  const n = (v) => v.toLocaleString();
  $('#statMovies').textContent = n(s.db.movies);
  $('#statRated').textContent = n(s.db.rated);
  $('#statRatedPct').textContent = s.db.movies ? `${((s.db.rated / s.db.movies) * 100).toFixed(1)}% of saved movies` : '';
  $('#statPending').textContent = n(s.db.pending);
  $('#statChecked').textContent = `${n(s.db.checked - s.db.rated)} looked up with no IMDb rating`;
  $('#statOmdb').textContent = n(s.omdbUsedToday);
  $('#statOmdbLimit').textContent = s.omdbConfigured ? `of ${n(s.omdbDailyLimit)} allowed` : 'no OMDb key set';
  $('#omdbCurrent').textContent = s.omdbKeyMasked || 'none';
  $('#omdbSource').textContent = s.omdbKeySource === 'ui' ? '(saved here)' : s.omdbKeySource === 'config' ? '(from config.json)' : '';
  $('#omdbClear').hidden = s.omdbKeySource !== 'ui';
}

function showJob(s) {
  const j = s.job;
  showStats(s);
  btnCatalog.disabled = btnRatings.disabled = btnAll.disabled = j.running;
  btnRatings.title = s.omdbConfigured ? '' : 'Add an OMDb API key below first';
  if (!s.omdbConfigured) btnRatings.disabled = true;
  $('#jobDot').hidden = !j.running;
  btnRatings.textContent = `Sync IMDb ratings (${batchInput.value || '…'})`;
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
  let regions = [];
  try {
    const [r, genres] = await Promise.all([source.regions(), source.genres()]);
    regions = r;
    genres.forEach((g) => (state.genres[g.id] = g.name));
    genreSel.innerHTML += genres.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    regionSel.innerHTML = regions.map((r) => `<option value="${r.code}">${esc(r.name)}</option>`).join('');
  } catch (e) {
    // TMDB unreachable: still allow browsing what's stored.
    regionSel.innerHTML = `<option value="${prefs.region || 'RO'}">${prefs.region || 'RO'}</option>`;
    if (jobMsg) { jobMsg.className = 'jobmsg error'; jobMsg.textContent = `TMDB unreachable (${e.message}) — showing stored data`; }
  }
  const fallback = regionSel.querySelector('[value="RO"]') ? 'RO' : regions[0]?.code || 'RO';
  state.region = prefs.region && regionSel.querySelector(`[value="${prefs.region}"]`) ? prefs.region : fallback;
  regionSel.value = state.region;

  regionSel.onchange = () => { state.region = regionSel.value; savePrefs(); loadRegion(); };
  filterInput.oninput = minRatingSel.onchange = genreSel.onchange = $('#minVotes').onchange = render;
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'title' ? 1 : -1 };
    savePrefs(); render();
  }));
  $('#sortSel').onchange = (e) => {
    const [key, dir] = e.target.value.split(':');
    state.sort = { key, dir: Number(dir) };
    savePrefs(); render();
  };
  $('#filtersToggle').onclick = () => {
    const open = document.body.classList.toggle('filters-open');
    $('#filtersToggle').setAttribute('aria-expanded', open);
  };
  new IntersectionObserver((e) => e[0].isIntersecting && showMore(), { rootMargin: '1200px' }).observe($('#sentinel'));

  if (STATIC) {
    document.body.dataset.tab = 'movies';
    $('#builtAt').textContent = window.STATIC_SITE.builtAt ? `Updated ${fmtDateTime(window.STATIC_SITE.builtAt)}.` : '';
    await loadRegion();
    return;
  }

  btnCatalog.onclick = () => start('catalog');
  btnRatings.onclick = () => start('ratings');
  btnAll.onclick = () => start('all');

  // Tabs (remembered in the URL hash so reload keeps the tab)
  const showTab = (tab) => {
    if (!['movies', 'sync'].includes(tab)) tab = 'movies';
    document.body.dataset.tab = tab;
    $('#tab-movies').hidden = tab !== 'movies';
    $('#tab-sync').hidden = tab !== 'sync';
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  };
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  window.onhashchange = () => showTab(location.hash.slice(1));
  showTab(location.hash.slice(1));
  const showCountry = () => ($('#syncCountry').textContent = regionSel.selectedOptions[0]?.textContent || state.region);
  regionSel.addEventListener('change', showCountry);
  showCountry();

  // OMDb key
  const omdbMsg = $('#omdbMsg');
  const flash = (el, text, isError) => {
    el.className = 'saved' + (isError ? ' error' : '');
    el.textContent = text;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.textContent = ''), isError ? 8000 : 3000);
  };
  const saveKey = async (key) => {
    flash(omdbMsg, key ? 'Testing key…' : 'Removing…');
    try {
      await api('/api/omdb-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      $('#omdbKey').value = '';
      flash(omdbMsg, key ? 'Key works and is saved' : 'Saved key removed');
      showJob(await api('/api/status'));
    } catch (err) { flash(omdbMsg, err.message, true); }
  };
  $('#omdbForm').onsubmit = (e) => {
    e.preventDefault();
    const key = $('#omdbKey').value.trim();
    if (key) saveKey(key);
  };
  $('#omdbClear').onclick = () => {
    if (confirm('Remove the key saved here? The key from config.json (if any) will be used instead.')) saveKey('');
  };

  // Configuration section
  try { batchInput.value = (await api('/api/settings')).ratingBatchSize; } catch {}
  settingsForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const s = await api('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ratingBatchSize: Number(batchInput.value) }),
      });
      batchInput.value = s.ratingBatchSize;
      btnRatings.textContent = `Sync IMDb ratings (${s.ratingBatchSize})`;
      settingsMsg.className = 'saved';
      settingsMsg.textContent = 'Saved';
    } catch (err) {
      settingsMsg.className = 'saved error';
      settingsMsg.textContent = err.message;
    }
    setTimeout(() => (settingsMsg.textContent = ''), 3000);
  };

  await loadRegion();
  showJob(await api('/api/status'));
  poll(); // resume progress display if a job is already running
}

init();
