/* =========================================================
   SEARCH — busca em todos os livros, com cache em memória
   ========================================================= */

import { getLivros, loadCap, getLang } from "./reader.js";
import { escapeHtml, normalizeText } from "./util.js";

const MAX_LANG_CACHE = 2;

let CACHE_BY_LANG = {};   // { lang: { livroId: { capNum: [{v,t}] } } }
let LOAD_PROMISE_BY_LANG = {};
let LOAD_PCT_BY_LANG = {};
let CACHE_LANG_ORDER = []; // idiomas em ordem LRU: mais antigo -> mais recente

export function getLoadPct() { return LOAD_PCT_BY_LANG[getLang()] || 0; }

function touchLangCache(lang) {
  CACHE_LANG_ORDER = CACHE_LANG_ORDER.filter(item => item !== lang);
  CACHE_LANG_ORDER.push(lang);
}

function trimLangCache(keepLang = getLang()) {
  while (CACHE_LANG_ORDER.length > MAX_LANG_CACHE) {
    const candidate = CACHE_LANG_ORDER[0];

    // Nunca remove o idioma em uso agora. Também evita descartar um idioma
    // ainda carregando, porque a promise precisa terminar de forma previsível.
    if (candidate === keepLang || LOAD_PROMISE_BY_LANG[candidate]) {
      CACHE_LANG_ORDER.push(CACHE_LANG_ORDER.shift());

      // Se todos os caches restantes são protegidos, encerra para não girar infinito.
      const removable = CACHE_LANG_ORDER.find(lang => lang !== keepLang && !LOAD_PROMISE_BY_LANG[lang]);
      if (!removable) break;
      continue;
    }

    CACHE_LANG_ORDER.shift();
    delete CACHE_BY_LANG[candidate];
    delete LOAD_PCT_BY_LANG[candidate];
  }
}

export function clearSearchCache(lang = null) {
  if (lang) {
    delete CACHE_BY_LANG[lang];
    delete LOAD_PROMISE_BY_LANG[lang];
    delete LOAD_PCT_BY_LANG[lang];
    CACHE_LANG_ORDER = CACHE_LANG_ORDER.filter(item => item !== lang);
  } else {
    CACHE_BY_LANG = {};
    LOAD_PROMISE_BY_LANG = {};
    LOAD_PCT_BY_LANG = {};
    CACHE_LANG_ORDER = [];
  }
}

// Útil para diagnóstico manual no console, sem afetar a UI.
export function getSearchCacheStats() {
  return {
    maxLangCache: MAX_LANG_CACHE,
    loadedLangs: CACHE_LANG_ORDER.filter(lang => Boolean(CACHE_BY_LANG[lang])),
    loadingLangs: Object.entries(LOAD_PROMISE_BY_LANG)
      .filter(([, promise]) => Boolean(promise))
      .map(([lang]) => lang)
  };
}

async function ensureLoaded(onProgress) {
  const lang = getLang();
  touchLangCache(lang);

  if (LOAD_PROMISE_BY_LANG[lang]) {
    await LOAD_PROMISE_BY_LANG[lang];
    touchLangCache(lang);
    trimLangCache(lang);
    return;
  }

  const CACHE = CACHE_BY_LANG[lang] ||= {};
  trimLangCache(lang);
  const livros = getLivros();
  let total = 0, done = 0;
  livros.forEach(l => total += l.caps);
  LOAD_PCT_BY_LANG[lang] = 0;

  // Carrega em paralelo limitado
  const queue = [];
  for (const l of livros) {
    if (!CACHE[l.id]) CACHE[l.id] = {};
    for (let c = 1; c <= l.caps; c++) {
      if (CACHE[l.id][c]) { done++; continue; }
      queue.push({ livro: l, cap: c });
    }
  }

  if (!queue.length) {
    LOAD_PCT_BY_LANG[lang] = 100;
    onProgress?.(100);
    trimLangCache(lang);
    return;
  }

  const CONC = 12;
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const job = queue[idx++];
      try {
        const data = await loadCap(job.livro.id, job.cap);
        CACHE[job.livro.id][job.cap] = data;
      } catch (e) {
        CACHE[job.livro.id][job.cap] = [];
      }
      done++;
      LOAD_PCT_BY_LANG[lang] = total ? Math.round(done * 100 / total) : 100;
      onProgress?.(LOAD_PCT_BY_LANG[lang]);
    }
  }
  LOAD_PROMISE_BY_LANG[lang] = Promise.all(Array.from({ length: CONC }, worker))
    .finally(() => {
      LOAD_PROMISE_BY_LANG[lang] = null;
      touchLangCache(lang);
      trimLangCache(lang);
    });
  await LOAD_PROMISE_BY_LANG[lang];
}

/**
 * Busca com normalização (sem acentos, lowercase).
 * @param q termo
 * @param onProgress callback ao carregar inicialmente
 */
export async function search(q, onProgress) {
  await ensureLoaded(onProgress);
  const livros = getLivros();
  const lang = getLang();
  touchLangCache(lang);
  trimLangCache(lang);
  const CACHE = CACHE_BY_LANG[lang] || {};
  const needle = normalizeText(q.trim());
  if (needle.length < 2) return [];

  const results = [];
  for (const l of livros) {
    for (let c = 1; c <= l.caps; c++) {
      const data = CACHE[l.id]?.[c] || [];
      for (const v of data) {
        if (normalizeText(v.t).includes(needle)) {
          results.push({
            livroId: l.id,
            livroNome: l.nome,
            cap: c,
            v: v.v,
            t: v.t
          });
          if (results.length >= 500) return results;
        }
      }
    }
  }
  return results;
}

export function highlightMatch(text, q) {
  const raw = String(text || "");
  const query = String(q || "");
  if (!query) return escapeHtml(raw);

  const needle = normalizeText(query);
  const lower = normalizeText(raw);
  if (!needle) return escapeHtml(raw);

  let out = "";
  let i = 0;
  while (i < raw.length) {
    const idx = lower.indexOf(needle, i);
    if (idx === -1) { out += escapeHtml(raw.slice(i)); break; }
    out += escapeHtml(raw.slice(i, idx)) + "<mark>" + escapeHtml(raw.slice(idx, idx + query.length)) + "</mark>";
    i = idx + query.length;
  }
  return out;
}
