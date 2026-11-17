const $ = (s) => document.querySelector(s);
const grid = $('#grid'), statusEl = $('#status'), summary = $('#summary');
const regionSel = $('#region'), sortSel = $('#sort'), filterInput = $('#filter');
const tpl = $('#card-tpl');

const state = { region: 'RO', sort: 'popularity.desc', page: 0, totalPages: 1, total: 0, loading: false, genres: {}, token: 0 };

async function api(path) {
  const r = await fetch(path);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function card(m) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const img = el.querySelector('img');
  if (m.poster) { img.src = m.poster; img.alt = m.title; }
  else { el.querySelector('.poster').classList.add('empty'); el.querySelector('.poster').textContent = m.title; }
  el.querySelector('.title').textContent = m.title;
  const genres = m.genreIds.map((id) => state.genres[id]).filter(Boolean).slice(0, 2).join(' · ');
  el.querySelector('.sub').textContent = [m.year, genres].filter(Boolean).join(' • ');
  el.querySelector('.overlay p').textContent = m.overview || 'No description available.';
  el.dataset.search = m.title.toLowerCase();
  return el;
}

function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  for (const c of grid.children) c.hidden = q && !c.dataset.search.includes(q);
}

async function loadNext() {
  if (state.loading || state.page >= state.totalPages) return;
  state.loading = true;
  const token = state.token;
  statusEl.className = 'status';
  statusEl.textContent = 'Loading…';
  try {
    const d = await api(`/api/movies?region=${state.region}&sort=${state.sort}&page=${state.page + 1}`);
    if (token !== state.token) return; // country/sort changed mid-flight
    state.page = d.page; state.totalPages = d.totalPages; state.total = d.totalResults;
    const frag = document.createDocumentFragment();
    d.results.forEach((m) => frag.appendChild(card(m)));
    grid.appendChild(frag);
    applyFilter();
    const name = regionSel.selectedOptions[0]?.textContent || state.region;
    summary.innerHTML = `<strong>${state.total.toLocaleString()}</strong> movies on Netflix in <strong>${name}</strong> · showing ${grid.children.length.toLocaleString()}`;
    statusEl.textContent = state.page >= state.totalPages ? (state.total ? 'That’s everything.' : 'No movies found for this country.') : '';
  } catch (e) {
    statusEl.className = 'status error';
    statusEl.textContent = `Error: ${e.message}`;
  } finally {
    if (token === state.token) state.loading = false;
  }
}

function reset() {
  state.token++; state.page = 0; state.totalPages = 1; state.loading = false;
  grid.innerHTML = '';
  summary.textContent = 'Loading…';
  try { localStorage.setItem('prefs', JSON.stringify({ region: state.region, sort: state.sort })); } catch {}
  loadNext();
}

async function init() {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('prefs')) || {}; } catch {}
  try {
    const [regions, genres] = await Promise.all([api('/api/regions'), api('/api/genres')]);
    genres.forEach((g) => (state.genres[g.id] = g.name));
    regionSel.innerHTML = regions.map((r) => `<option value="${r.code}">${r.name}</option>`).join('');
  } catch (e) {
    summary.textContent = '';
    statusEl.className = 'status error';
    statusEl.textContent = `Could not reach TMDB: ${e.message}. Check tmdbApiKey in config.json.`;
    return;
  }
  state.region = prefs.region && regionSel.querySelector(`[value="${prefs.region}"]`) ? prefs.region : 'RO';
  state.sort = prefs.sort || state.sort;
  regionSel.value = state.region; sortSel.value = state.sort;

  regionSel.onchange = () => { state.region = regionSel.value; reset(); };
  sortSel.onchange = () => { state.sort = sortSel.value; reset(); };
  filterInput.oninput = applyFilter;
  new IntersectionObserver((e) => e[0].isIntersecting && loadNext(), { rootMargin: '800px' }).observe($('#sentinel'));
  reset();
}

init();
