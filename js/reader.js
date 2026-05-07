/* =========================================================
   READER — carrega capítulos e renderiza
   Suporta múltiplas traduções católicas mantendo os mesmos IDs
   de livros para preservar marcações, notas, CIC e referências.
   ========================================================= */

import { saveProgress, loadHighlights, loadNotes } from "./storage.js";
import { escapeHtml } from "./util.js";

let LIVROS = [];
let LIVROS_BY_ID = {};
let CURRENT_LANG = "pt";  // padrão: versão mais próxima da Ave-Maria

export const BIBLE_VERSIONS = [
  {
    id: "pt",
    label: "Ave-Maria",
    shortLabel: "Ave-Maria",
    toast: "Bíblia: Ave-Maria (Português)",
    dataDir: "./dados",
    livrosFile: "./livros.json",
    primary: true
  },
  {
    id: "ms",
    label: "Pe. Matos Soares",
    shortLabel: "Matos Soares",
    toast: "Bíblia: Pe. Matos Soares (1956)",
    dataDir: "./dados-ms",
    livrosFile: "./livros-ms.json"
  },
  {
    id: "en",
    label: "Douay-Rheims",
    shortLabel: "Douay-Rheims",
    toast: "Bible: Douay-Rheims (English)",
    dataDir: "./dados-en",
    livrosFile: "./livros-en.json"
  },
  {
    id: "leandro",
    label: "Ave-Maria / LeandroLFE",
    shortLabel: "LeandroLFE",
    toast: "Bíblia: Ave-Maria / LeandroLFE",
    dataDir: "./dados-leandro",
    livrosFile: "./livros-leandro.json"
  },
  {
    id: "pastoral",
    label: "Bíblia Pastoral",
    shortLabel: "Pastoral",
    toast: "Bíblia: Pastoral (Paulus)",
    dataDir: "./dados-pastoral",
    livrosFile: "./livros-pastoral.json",
    remote: "jbreccio"
  },
  {
    id: "biblioteca_expandida",
    label: "Biblioteca Bíblica Expandida",
    shortLabel: "Bib. Expandida",
    toast: "Biblioteca Bíblica Expandida — modo estudo",
    dataDir: "./dados-biblioteca-expandida",
    livrosFile: "./livros-biblioteca-expandida.json",
    compare: false,
    studyOnly: true
  }
];

const LANG_CONFIG = Object.fromEntries(BIBLE_VERSIONS.map(v => [v.id, v]));
const BIBLIOTECA_EXPANDIDA_CACHE_TAG = "bibexp-final-20260504";

/* Abreviações do repositório Jbreccio/biblia-catolica-json.
   Usado apenas como fallback remoto para a Pastoral, caso a pasta
   dados-pastoral/ ainda não tenha sido gerada pelo script V33. */
const PASTORAL_ABBREV = {
  genesis: "gn", exodo: "ex", levitico: "lv", numeros: "nm", deuteronomio: "dt",
  josue: "js", juizes: "jz", rute: "rt", "1_samuel": "1sm", "2_samuel": "2sm",
  "1_reis": "1rs", "2_reis": "2rs", "1_cronicas": "1cr", "2_cronicas": "2cr",
  esdras: "ed", neemias: "ne", tobias: "tb", judite: "jt", ester: "et",
  "1_macabeus": "1mc", "2_macabeus": "2mc",
  job: "jo", salmos: "sl", proverbios: "pv", eclesiastes: "ec", canticos: "ct",
  "cantico-dos-canticos": "ct", sabedoria: "sb", eclesiastico: "eclo",
  isaias: "is", jeremias: "jr", lamentacoes: "lm", baruc: "br", ezequiel: "ez",
  daniel: "dn", oseias: "os", joel: "jl", amos: "am", abdias: "ob", jonas: "jn",
  miqueias: "mq", naum: "na", habacuc: "hc", sofonias: "sf", ageu: "ag",
  zacarias: "zc", malaquias: "ml",
  mateus: "mt", marcos: "mc", lucas: "lc", joao: "jo2",
  atos: "at", romanos: "rm", "1_corintios": "1co", "2_corintios": "2co",
  galatas: "gl", efesios: "ef", filipenses: "fp", colossenses: "cl",
  "1_tessalonicenses": "1ts", "2_tessalonicenses": "2ts",
  "1_timoteo": "1tm", "2_timoteo": "2tm", tito: "tt", filemon: "fm",
  hebreus: "hb", tiago: "tg", "1_pedro": "1pe", "2_pedro": "2pe",
  "1_joao": "1jo", "2_joao": "2jo", "3_joao": "3jo", judas: "jd",
  apocalipse: "ap"
};

/* Agrupamento católico tradicional */
export const BOOK_GROUPS = [
  { name: "Pentateuco", ids: ["genesis","exodo","levitico","numeros","deuteronomio"] },
  { name: "Históricos", ids: ["josue","juizes","rute","1_samuel","2_samuel","1_reis","2_reis","1_cronicas","2_cronicas","esdras","neemias","tobias","judite","ester","1_macabeus","2_macabeus"] },
  { name: "Sapienciais", ids: ["job","salmos","proverbios","eclesiastes","canticos","cantico-dos-canticos","sabedoria","eclesiastico"] },
  { name: "Proféticos", ids: ["isaias","jeremias","lamentacoes","baruc","ezequiel","daniel","oseias","joel","amos","abdias","jonas","miqueias","naum","habacuc","sofonias","ageu","zacarias","malaquias"] },
  { name: "Evangelhos", ids: ["mateus","marcos","lucas","joao"] },
  { name: "Atos", ids: ["atos"] },
  { name: "Cartas Paulinas", ids: ["romanos","1_corintios","2_corintios","galatas","efesios","filipenses","colossenses","1_tessalonicenses","2_tessalonicenses","1_timoteo","2_timoteo","tito","filemon"] },
  { name: "Cartas Católicas", ids: ["hebreus","tiago","1_pedro","2_pedro","1_joao","2_joao","3_joao","judas"] },
  { name: "Apocalipse", ids: ["apocalipse"] }
];

export function getLang() { return CURRENT_LANG; }
export function getBibleVersions() { return BIBLE_VERSIONS.slice(); }
export function getComparableBibleVersions() { return BIBLE_VERSIONS.filter(v => v.compare !== false); }
export function getBibleVersion(id = CURRENT_LANG) { return LANG_CONFIG[id] || LANG_CONFIG.pt; }
export function isKnownLang(id) { return !!LANG_CONFIG[id]; }

export async function setLang(lang) {
  if (!LANG_CONFIG[lang]) throw new Error(`Tradução desconhecida: ${lang}`);
  CURRENT_LANG = lang;
  await loadLivros();
}

export async function loadLivros() {
  const cfg = LANG_CONFIG[CURRENT_LANG] || LANG_CONFIG.pt;
  try {
    const livrosUrl = cfg.studyOnly ? `${cfg.livrosFile}?v=${BIBLIOTECA_EXPANDIDA_CACHE_TAG}` : cfg.livrosFile;
    const r = await fetch(livrosUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    LIVROS = await r.json();
  } catch (e) {
    // As traduções novas usam os mesmos IDs/capítulos da base católica.
    // Se o arquivo livros-XX.json não existir, mantém a tradução selecionada
    // e usa a lista principal apenas para navegação.
    if (CURRENT_LANG !== "pt") {
      console.warn(`livros de ${CURRENT_LANG} indisponíveis, usando mapa PT`, e);
      const r = await fetch(LANG_CONFIG.pt.livrosFile);
      LIVROS = await r.json();
    } else {
      throw e;
    }
  }
  LIVROS_BY_ID = {};
  LIVROS.forEach(l => LIVROS_BY_ID[l.id] = l);
  return LIVROS;
}

export function getLivros() { return LIVROS; }
export function getLivro(id) { return LIVROS_BY_ID[id]; }

function legacyUnicodeFolderId(id) {
  // Algumas pastas antigas da Biblioteca Expandida foram geradas com
  // caracteres acentuados no formato literal #U00e7/#U00e3 etc.
  // Mantemos o ID bonito no catálogo, mas tentamos também esse nome físico.
  return String(id || "").replace(/[^\x00-\x7F]/g, ch => {
    return "#U" + ch.codePointAt(0).toString(16).padStart(4, "0");
  });
}

function bookTries(livroId) {
  const tries = [livroId];
  if (livroId === "canticos") tries.push("cantico-dos-canticos");
  if (livroId === "cantico-dos-canticos") tries.push("canticos");

  const legacy = legacyUnicodeFolderId(livroId);
  if (legacy !== livroId) tries.push(legacy);

  return [...new Set(tries)];
}

function chapterUrl(dataDir, livroId, cap, cacheTag = "") {
  // encodeURIComponent evita que nomes legados com # sejam tratados como
  // fragmento de URL, e também normaliza acentos/espaços com segurança.
  return `${dataDir}/${encodeURIComponent(livroId)}/${cap}.json${cacheTag}`;
}

async function fetchLocalCap(cfg, livroId, cap) {
  const cacheTag = cfg.studyOnly ? `?v=${BIBLIOTECA_EXPANDIDA_CACHE_TAG}` : "";
  for (const id of bookTries(livroId)) {
    try {
      const r = await fetch(chapterUrl(cfg.dataDir, id, cap, cacheTag));
      if (r.ok) return await r.json();
    } catch (e) {}
  }
  return null;
}

function normalizePastoralChapter(raw) {
  if (Array.isArray(raw)) return raw;
  const verses = raw?.versiculos || raw?.verses || [];
  return verses.map(v => ({
    v: Number(v.v ?? v.number ?? v.numero),
    t: String(v.t ?? v.text ?? v.texto ?? "").trim()
  })).filter(v => Number.isFinite(v.v) && v.t);
}

async function fetchPastoralRemote(livroId, cap) {
  const abbr = PASTORAL_ABBREV[livroId];
  if (!abbr) return null;
  const url = `https://raw.githubusercontent.com/Jbreccio/biblia-catolica-json/main/livros/${abbr}/${cap}.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return normalizePastoralChapter(await r.json());
}

export async function loadCapFromVersion(versionId, livroId, cap, opts = {}) {
  const cfg = LANG_CONFIG[versionId] || LANG_CONFIG.pt;

  const local = await fetchLocalCap(cfg, livroId, cap);
  if (local) return local;

  if (cfg.remote === "jbreccio") {
    try {
      const remote = await fetchPastoralRemote(livroId, cap);
      if (remote?.length) return remote;
    } catch (e) {
      console.warn(`[reader] fallback remoto Pastoral falhou para ${livroId} ${cap}`, e);
    }
  }

  if (opts.allowFallback !== false && versionId !== "pt") {
    const fallback = await fetchLocalCap(LANG_CONFIG.pt, livroId, cap);
    if (fallback) {
      console.warn(`[reader] ${livroId} ${cap} indisponível em ${versionId}, exibindo Ave-Maria`);
      return fallback;
    }
  }

  throw new Error(`Capítulo não encontrado em ${cfg.label}: ${livroId} ${cap}`);
}

export async function loadCap(livroId, cap) {
  return loadCapFromVersion(CURRENT_LANG, livroId, cap, { allowFallback: true });
}

export async function renderCap(livroId, cap, container) {
  const livro = getLivro(livroId);
  if (!livro) throw new Error("Livro inválido");

  const data = await loadCap(livroId, cap);
  const hls = await loadHighlights();
  const notes = await loadNotes();

  const html = data.map(v => {
    const key = `${livroId}/${cap}/${v.v}`;
    const hl = hls[key];
    const hasNote = !!notes[key];
    const cls = ["verse"];
    if (hl) cls.push(`hl-${hl}`);
    if (hasNote) cls.push("has-note");
    const label = `${livro.nome} ${cap}:${v.v}`;
    return `<span class="${cls.join(" ")}" data-livro="${livroId}" data-cap="${cap}" data-v="${v.v}" role="button" tabindex="0" aria-label="Selecionar ${escapeHtml(label)}"><span class="vn">${v.v}</span><span class="vt">${escapeHtml(v.t)}</span></span> `;
  }).join("");

  container.innerHTML = html;
  saveProgress(livroId, cap);
  return { livro, data };
}

