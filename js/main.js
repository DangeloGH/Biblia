/* =========================================================
   MAIN — orquestra UI, autenticação, leitura, IA e estudo
   ========================================================= */

import {
  FIREBASE_READY, auth, GoogleAuthProvider, signInWithPopup,
  signOut, onAuthStateChanged
} from "./firebase-config.js";

import {
  setUid,
  saveEncryptedKey, loadEncryptedKey, clearEncryptedKey,
  loadHighlights, setHighlight, setHighlights, loadNotes, setNote,
  saveProgress, loadProgress, savePref, loadPrefs,
  loadReadChapters, setReadChapter
} from "./storage.js";

import { encryptString, decryptString } from "./crypto.js";

import {
  loadLivros, getLivros, getLivro, renderCap, loadCap, BOOK_GROUPS,
  setLang, getLang, getBibleVersions, getComparableBibleVersions, isKnownLang, loadCapFromVersion
} from "./reader.js?v=lectio-v67-primeira-experiencia";

import { search, highlightMatch } from "./search.js";
import { callGemini, buildPrompt, buildCicBlock, buildLectioPrompt, mdToHtml, buildModelQueue, isRetryableGeminiError } from "./gemini.js";
import { escapeHtml, normalizeText } from "./util.js";
import { downloadVerseShareImage } from "./share-image.js";
import { initDevocionario, openDevocionario } from "./oracoes.js?v=lectio-v67-primeira-experiencia";


/* ---------- Estado ---------- */
const state = {
  livro: "genesis",
  cap: 1,
  selVerses: [],         // ← CORRIGIDO: era selVerse: null
  encBlob: null,
  apiKey: null,
  model: "gemini-2.5-flash",
  activeModel: null,
  translationMode: "original",
  translationBusy: false,
  translationLastError: "",
  master: null,
  refsData: {},
  cicData: {},
  cicTexto: {}
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const escape = escapeHtml; // alias local para preservar chamadas antigas do main.js
const MAX_SHARE_VERSES = 8;
const WELCOME_KEY = "lectio.welcome.v1";

/* ---------- Trap global de erros (visível na tela) ----------
   Se algo dá errado em produção mobile sem console acessível, o user
   precisa enxergar o erro pra reportar. Esta caixa aparece sobre tudo. */
function showFatalError(label, err) {
  console.error("[Lectio]", label, err);
  const msg = err?.message || err?.reason?.message || String(err?.reason || err || "");
  const stack = (err?.stack || err?.reason?.stack || "").toString().slice(0, 600);
  let box = document.getElementById("lectio-fatal-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "lectio-fatal-box";
    box.style.cssText = `
      position:fixed; left:12px; right:12px; bottom:12px; z-index:99999;
      background:#2a1212; color:#ffd9d9; border:1px solid #ff6b6b;
      border-radius:10px; padding:12px 14px; font:13px/1.45 system-ui;
      box-shadow:0 8px 30px rgba(0,0,0,.4); max-height:60vh; overflow:auto;
    `;
    box.innerHTML = `<strong style="color:#ff8b8b">⚠ Erro de carregamento</strong>
      <button id="lectio-fatal-close" style="float:right;background:transparent;color:#ffd9d9;border:1px solid #ff6b6b;border-radius:6px;padding:2px 8px;cursor:pointer">fechar</button>
      <div id="lectio-fatal-msg" style="margin-top:6px;word-break:break-word"></div>
      <pre id="lectio-fatal-stack" style="margin-top:6px;font:11px ui-monospace,monospace;white-space:pre-wrap;color:#ffb8b8;opacity:.85"></pre>`;
    document.body.appendChild(box);
    box.querySelector("#lectio-fatal-close").onclick = () => box.remove();
  }
  box.querySelector("#lectio-fatal-msg").textContent = `[${label}] ${msg}`;
  if (stack) box.querySelector("#lectio-fatal-stack").textContent = stack;
}
window.addEventListener("error", e => showFatalError("script", e));
window.addEventListener("unhandledrejection", e => showFatalError("promise", e));


/* ---------- PATCH V22: chave Gemini liberada durante a sessão ---------- */
const GEMINI_SESSION_KEY = "lectio.gemini.session.v1";
function saveSessionGeminiKey(key, model) {
  try {
    if (!key) return;
    sessionStorage.setItem(GEMINI_SESSION_KEY, JSON.stringify({ key, model: model || state.model || "gemini-2.5-flash", ts: Date.now() }));
  } catch {}
}
function restoreSessionGeminiKey() {
  try {
    const raw = sessionStorage.getItem(GEMINI_SESSION_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data?.key) return false;
    const maxAgeMs = 12 * 60 * 60 * 1000;
    if (data.ts && Date.now() - data.ts > maxAgeMs) { sessionStorage.removeItem(GEMINI_SESSION_KEY); return false; }
    state.apiKey = data.key;
    if (data.model) state.model = data.model;
    return true;
  } catch { return false; }
}
function clearSessionGeminiKey() {
  try { sessionStorage.removeItem(GEMINI_SESSION_KEY); } catch {}
}


/* ---------- Caderno de Estudos IA local ---------- */
const AI_STUDIES_KEY = "lectio.aiStudies.v1";
const AI_PROMPT_LABELS = {
  contexto: "Contexto histórico",
  catolico: "Leitura católica",
  patristica: "Padres da Igreja",
  catecismo: "No Catecismo",
  aplicacao: "Aplicação prática",
  oracao: "Inspirar oração"
};
const LECTIO_STEP_TITLES = {
  1: "Lectio — Leitura",
  2: "Meditatio — Meditação",
  3: "Oratio — Oração",
  4: "Contemplatio — Contemplação"
};

function loadSavedStudies() {
  try {
    const raw = localStorage.getItem(AI_STUDIES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedStudies(items) {
  localStorage.setItem(AI_STUDIES_KEY, JSON.stringify(items));
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return (div.textContent || "").trim();
}

// Sanitiza HTML salvo/importado no Caderno de Estudos.
// As respostas da IA já passam por mdToHtml escapado, mas backups importados
// podem vir de fora. Isso evita script/onerror/javascript: sem perder formatação.
function sanitizeStudyHtml(html) {
  if (!html) return "";
  const template = document.createElement("template");
  template.innerHTML = String(html);
  template.content.querySelectorAll("script, iframe, object, embed, link, meta, style").forEach(el => el.remove());
  template.content.querySelectorAll("*").forEach(el => {
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || "").trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return template.innerHTML;
}

function normalizeStudyRecord(record) {
  const now = new Date().toISOString();
  const safe = record || {};
  const cleanHtml = sanitizeStudyHtml(safe.contentHtml || "");
  return {
    id: safe.id || `study-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: safe.createdAt || now,
    type: safe.type || "IA",
    subtype: safe.subtype || "Estudo",
    title: safe.title || "Estudo salvo",
    ref: safe.ref || "Sem referência",
    passage: safe.passage || "",
    contentHtml: cleanHtml,
    contentText: safe.contentText || stripHtml(cleanHtml),
    model: safe.model || state.activeModel || state.model || ""
  };
}

function saveStudyRecord(record) {
  const study = normalizeStudyRecord(record);
  const items = loadSavedStudies();
  items.unshift(study);
  // Limite preventivo para não lotar o navegador.
  persistSavedStudies(items.slice(0, 300));
  renderSavedStudies();
  toast("Estudo salvo no Caderno de Estudos");
  return study;
}

function buildStudyRecordFromAI(meta, text, html) {
  let ref = meta?.ref || "";
  let passage = meta?.passage || "";
  if ((!ref || !passage) && state.selVerses.length) {
    try {
      const ctx = getRefTxt();
      ref = ref || ctx.ref;
      passage = passage || ctx.txt;
    } catch {}
  }
  const subtype = meta?.subtype || meta?.type || "Resposta da IA";
  const title = meta?.title || `${subtype}${ref ? " — " + ref : ""}`;
  return normalizeStudyRecord({
    type: meta?.type || "IA",
    subtype,
    title,
    ref: ref || "Sem referência selecionada",
    passage,
    contentHtml: html || mdToHtml(text || ""),
    contentText: text || stripHtml(html || ""),
    model: state.activeModel || state.model || ""
  });
}

function createAIResultActions({ text, html, meta }) {
  const bar = document.createElement("div");
  bar.className = "ai-result-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "mini-action-btn";
  saveBtn.textContent = "💾 Salvar estudo";
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    saveStudyRecord(buildStudyRecordFromAI(meta, text, html));
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "mini-action-btn";
  copyBtn.textContent = "📋 Copiar";
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text || stripHtml(html || ""));
      toast("📋 Copiado!");
    } catch {
      toast("Selecione e copie manualmente", "error");
    }
  });

  bar.append(saveBtn, copyBtn);
  return bar;
}

function formatStudyDate(iso) {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return "Data indisponível";
  }
}

function renderSavedStudies() {
  const list = $("#saved-studies-list");
  if (!list) return;
  const items = loadSavedStudies();
  if (!items.length) {
    list.innerHTML = `<div class="pane-empty">Nenhum estudo salvo ainda. Gere uma resposta da IA e toque em <strong>Salvar estudo</strong>.</div>`;
    return;
  }
  list.innerHTML = items.map(item => `
    <div class="saved-study-item" data-id="${escape(item.id)}">
      <button class="saved-study-open" type="button" data-study-open="${escape(item.id)}">
        <span class="saved-study-title">${escape(item.title || "Estudo salvo")}</span>
        <span class="saved-study-meta">${escape(item.type || "IA")} · ${escape(item.ref || "Sem referência")} · ${formatStudyDate(item.createdAt)}</span>
      </button>
      <button class="item-delete saved-study-delete" type="button" data-study-delete="${escape(item.id)}" title="Apagar estudo">✕</button>
    </div>
  `).join("");
}

function handleSavedStudiesClick(e) {
  const openBtn = e.target.closest("[data-study-open]");
  if (openBtn) {
    const id = openBtn.dataset.studyOpen;
    const study = loadSavedStudies().find(x => x.id === id);
    if (study) openSavedStudyModal(study);
    return;
  }
  const delBtn = e.target.closest("[data-study-delete]");
  if (delBtn) {
    const id = delBtn.dataset.studyDelete;
    if (!confirm("Apagar este estudo salvo?")) return;
    persistSavedStudies(loadSavedStudies().filter(x => x.id !== id));
    renderSavedStudies();
    toast("Estudo apagado");
  }
}

function openSavedStudyModal(study) {
  let modal = document.getElementById("modal-saved-study");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-saved-study";
    modal.className = "modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "saved-study-modal-title");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-card modal-card-wide saved-study-modal-card">
        <header class="modal-head">
          <h2 id="saved-study-modal-title">Estudo salvo</h2>
          <button class="icon-btn modal-close" data-close aria-label="Fechar estudo salvo">✕</button>
        </header>
        <div class="saved-study-modal-meta" id="saved-study-modal-meta"></div>
        <div class="saved-study-modal-body" id="saved-study-modal-body"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) closeModal(modal); });
  }
  modal.querySelector("#saved-study-modal-title").textContent = study.title || "Estudo salvo";
  modal.querySelector("#saved-study-modal-meta").innerHTML = `
    <strong>${escape(study.ref || "Sem referência")}</strong><br>
    ${escape(study.type || "IA")} · ${formatStudyDate(study.createdAt)}${study.model ? " · " + escape(study.model) : ""}
    ${study.passage ? `<div class="saved-study-passage">${escape(study.passage)}</div>` : ""}
  `;
  modal.querySelector("#saved-study-modal-body").innerHTML = study.contentHtml || `<p>${escape(study.contentText || "")}</p>`;
  openModal(modal);
}

function exportSavedStudies() {
  const items = loadSavedStudies();
  if (!items.length) return toast("Nenhum estudo salvo para exportar", "error");
  const payload = {
    app: "Lectio",
    type: "caderno-estudos-ia",
    version: 1,
    exportedAt: new Date().toISOString(),
    studies: items
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lectio-caderno-estudos-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Backup dos estudos gerado");
}

async function importSavedStudiesFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = Array.isArray(parsed) ? parsed : parsed.studies;
    if (!Array.isArray(incoming)) throw new Error("Arquivo inválido");
    const current = loadSavedStudies();
    const byId = new Map(current.map(x => [x.id, x]));
    let added = 0;
    for (const raw of incoming) {
      const rec = normalizeStudyRecord(raw);
      if (!byId.has(rec.id)) { byId.set(rec.id, rec); added++; }
    }
    const merged = [...byId.values()].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    persistSavedStudies(merged.slice(0, 300));
    renderSavedStudies();
    toast(`Importação concluída: ${added} estudo(s) novo(s)`);
  } catch (e) {
    toast("Não foi possível importar o backup: " + (e.message || "arquivo inválido"), "error", 5000);
  }
}

let _authResolved = false;
let _modalReturnFocus = null;

/* ---------- Modais e overlays mobile ---------- */
function getFocusableIn(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.closest('.hidden') && (el.getClientRects().length > 0 || el === document.activeElement));
}

function focusFirstInModal(modal) {
  // PATCH V55 — Devocionário: evita abrir teclado automaticamente no celular.
  // Em modais marcados com data-no-initial-input-focus, a prioridade inicial
  // deixa de ser o campo de busca e passa para o botão de fechar/primeiro botão.
  const avoidInputFocus = modal?.hasAttribute("data-no-initial-input-focus");
  const selector = avoidInputFocus
    ? '[autofocus], button:not([data-close]), a[href], [tabindex]:not([tabindex="-1"])'
    : '[autofocus], input:not([type="hidden"]), textarea, select, button:not([data-close])';
  const preferred = modal.querySelector(selector);
  const fallback = avoidInputFocus ? modal.querySelector('[data-close]') : getFocusableIn(modal)[0];
  const target = preferred || fallback || getFocusableIn(modal)[0] || modal.querySelector('[data-close]');
  try { target?.focus({ preventScroll: true }); } catch { target?.focus(); }
}

function trapModalFocus(e) {
  const modal = document.querySelector(".modal:not(.hidden)");
  if (!modal) return;
  const focusables = getFocusableIn(modal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function closeModal(modal, options = {}) {
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal:not(.hidden)")) {
    document.body.classList.remove("modal-open");
  }
  const restore = options.restoreFocus !== false ? (_modalReturnFocus || modal._returnFocus) : null;
  if (restore && document.contains(restore)) {
    try { restore.focus({ preventScroll: true }); } catch { restore.focus(); }
  }
}

function openModal(selectorOrElement) {
  const modal = typeof selectorOrElement === "string" ? $(selectorOrElement) : selectorOrElement;
  if (!modal) return;
  _modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal._returnFocus = _modalReturnFocus;
  $("#more-menu")?.classList.add("hidden");
  closePanels();
  // Evita duas camadas embaçadas/presas uma sobre a outra no celular.
  $$(".modal:not(.hidden)").forEach(m => {
    if (m !== modal) {
      m.classList.add("hidden");
      m.setAttribute("aria-hidden", "true");
    }
  });
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.requestAnimationFrame(() => focusFirstInModal(modal));
}

function closeAllModals(options = {}) {
  $$(".modal:not(.hidden)").forEach(m => {
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
  });
  document.body.classList.remove("modal-open");
  const restore = options.restoreFocus !== false ? _modalReturnFocus : null;
  if (restore && document.contains(restore)) {
    try { restore.focus({ preventScroll: true }); } catch { restore.focus(); }
  }
}

/* ---------- Primeira experiência ---------- */
function markWelcomeSeen() {
  try { localStorage.setItem(WELCOME_KEY, "seen"); } catch {}
}

function shouldShowWelcome() {
  try {
    return localStorage.getItem(WELCOME_KEY) !== "seen";
  } catch {
    return false;
  }
}

function maybeShowWelcome() {
  if (!shouldShowWelcome()) return;
  window.setTimeout(() => {
    if (!shouldShowWelcome()) return;
    if (!$("#auth-overlay")?.classList.contains("hidden")) return;
    if (document.querySelector(".modal:not(.hidden)")) return;
    openModal("#modal-welcome");
  }, 700);
}

function closeWelcome(options = {}) {
  markWelcomeSeen();
  const modal = $("#modal-welcome");
  if (modal) closeModal(modal, { restoreFocus: false });
  if (options.openPrayers) {
    window.setTimeout(() => openDevocionario(), 90);
  }
}


/* ---------- Fallback automático de modelos Gemini ---------- */
let _modelQueue = [];
let _modelQueueKey = "";
let _modelIdx = 0;
let _resetTimer = null;
const RESET_MS = 15 * 60 * 1000; // volta ao preferido após 15 minutos

function resetModelRotation() {
  _modelIdx = 0;
  state.activeModel = state.model || "gemini-2.5-flash";
  clearTimeout(_resetTimer);
}

async function getModelQueue(force = false) {
  if (!state.apiKey) return [state.model || "gemini-2.5-flash"];
  const preferred = state.model || "gemini-2.5-flash";
  const key = `${preferred}:${state.apiKey.slice(-8)}`;

  if (!force && _modelQueue.length && _modelQueueKey === key) return _modelQueue;

  _modelQueue = await buildModelQueue({
    apiKey: state.apiKey,
    preferredModel: preferred
  });
  _modelQueueKey = key;
  _modelIdx = 0;
  return _modelQueue;
}

function currentModel(queue = _modelQueue) {
  const q = queue?.length ? queue : [state.model || "gemini-2.5-flash"];
  return q[Math.min(_modelIdx, q.length - 1)];
}

function bumpModel(queue = _modelQueue) {
  if (queue?.length) _modelIdx = Math.min(_modelIdx + 1, queue.length - 1);

  clearTimeout(_resetTimer);
  _resetTimer = setTimeout(() => {
    resetModelRotation();
    updateGemStatus();
    toast(`⏱ Voltando para ${state.model || "gemini-2.5-flash"}`);
  }, RESET_MS);
}

/* ---------- Toast ---------- */
function toast(msg, kind = "ok", ms = 2400) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "error" ? " error" : "");
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}



/* ---------- PATCH V28: chrome mobile inteligente ----------
   - A linha Lectio/Comparar/Foco/Liturgia/Buscar encolhe ao rolar para baixo.
   - Ela volta quando o usuário rola para cima ou chega ao topo.
   - Ao abrir Biblioteca/Estudo no mobile, o topo sai da frente e o painel ganha altura total.
*/
let _chromeBound = false;
let _lastReaderScrollTop = 0;
let _lastChromeIntent = "expanded";
let _chromeRaf = 0;

function isMobileChrome() {
  return window.matchMedia("(max-width: 1100px)").matches;
}

function syncChromeHeight() {
  const topbar = $(".topbar");
  if (!topbar) return;
  window.requestAnimationFrame(() => {
    if (!isMobileChrome() || document.body.classList.contains("focus-mode") || document.body.classList.contains("side-panel-open")) {
      document.documentElement.style.setProperty("--lectio-topbar-h", "56px");
      return;
    }
    const h = Math.ceil(topbar.getBoundingClientRect().height || 56);
    document.documentElement.style.setProperty("--lectio-topbar-h", `${Math.max(52, h)}px`);
  });
}

function setTopActionsCollapsed(collapsed, reason = "scroll") {
  if (!isMobileChrome()) {
    document.body.classList.remove("top-actions-collapsed", "top-actions-scroll");
    document.documentElement.style.setProperty("--lectio-topbar-h", "56px");
    return;
  }
  _lastChromeIntent = collapsed ? "collapsed" : "expanded";
  document.body.classList.toggle("top-actions-collapsed", collapsed);
  document.body.classList.toggle("top-actions-scroll", reason === "scroll");
  syncChromeHeight();
  window.setTimeout(syncChromeHeight, 260);
}

function updateSidePanelChromeState() {
  const sidebarOpen = !!$("#sidebar")?.classList.contains("open");
  const studyOpen = !!$("#study")?.classList.contains("open");
  const anyOpen = isMobileChrome() && (sidebarOpen || studyOpen);
  document.body.classList.toggle("side-panel-open", anyOpen);
  if (anyOpen) {
    document.body.classList.add("top-actions-collapsed");
  } else {
    document.body.classList.toggle("top-actions-collapsed", _lastChromeIntent === "collapsed");
  }
  syncChromeHeight();
  window.setTimeout(syncChromeHeight, 260);
}

function handleReaderChromeScroll() {
  if (!isMobileChrome()) return;
  if (document.body.classList.contains("focus-mode") || document.body.classList.contains("side-panel-open")) return;
  const reader = $("#reader");
  if (!reader) return;
  const y = reader.scrollTop || 0;
  const dy = y - _lastReaderScrollTop;

  if (y <= 18) {
    setTopActionsCollapsed(false, "scroll");
  } else if (dy > 7) {
    setTopActionsCollapsed(true, "scroll");
  } else if (dy < -7) {
    setTopActionsCollapsed(false, "scroll");
  }
  _lastReaderScrollTop = y;
}

function setupResponsiveChrome() {
  if (_chromeBound) return;
  _chromeBound = true;

  const reader = $("#reader");
  reader?.addEventListener("scroll", () => {
    if (_chromeRaf) return;
    _chromeRaf = window.requestAnimationFrame(() => {
      _chromeRaf = 0;
      handleReaderChromeScroll();
    });
  }, { passive: true });

  window.addEventListener("resize", () => {
    if (!isMobileChrome()) {
      document.body.classList.remove("top-actions-collapsed", "top-actions-scroll", "side-panel-open");
      document.documentElement.style.setProperty("--lectio-topbar-h", "56px");
      return;
    }
    updateSidePanelChromeState();
    syncChromeHeight();
  }, { passive: true });

  syncChromeHeight();
  window.setTimeout(syncChromeHeight, 320);
}


function ensureValidCurrentReference() {
  const livros = getLivros();
  if (!livros.length) return false;
  let livro = getLivro(state.livro);
  if (!livro) {
    livro = livros[0];
    state.livro = livro.id;
    state.cap = 1;
  }
  const cap = Number(state.cap) || 1;
  state.cap = Math.max(1, Math.min(livro.caps || 1, cap));
  return true;
}

function isBibliotecaExpandidaActive() {
  return getLang() === "biblioteca_expandida";
}

/* ---------- Tradução de estudo: original + português em duas linhas ---------- */
const TRANSLATION_CACHE_VERSION = "ptbr-v1";
const TRANSLATION_LANGS = new Set(["en", "biblioteca_expandida"]);

function isTranslationEligible() {
  return TRANSLATION_LANGS.has(getLang());
}

function translationCacheKey(livro = state.livro, cap = state.cap, lang = getLang()) {
  return `lectio.translation.${TRANSLATION_CACHE_VERSION}:${lang}:${livro}:${cap}`;
}

function loadCachedTranslation(livro = state.livro, cap = state.cap, lang = getLang()) {
  try {
    const raw = localStorage.getItem(translationCacheKey(livro, cap, lang));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { items: parsed, createdAt: null };
    if (Array.isArray(parsed?.items)) return parsed;
  } catch {}
  return null;
}

function saveCachedTranslation(items, livro = state.livro, cap = state.cap, lang = getLang()) {
  const payload = { version: TRANSLATION_CACHE_VERSION, lang, livro, cap, createdAt: new Date().toISOString(), items };
  try {
    localStorage.setItem(translationCacheKey(livro, cap, lang), JSON.stringify(payload));
  } catch (e) {
    console.warn("[Lectio] Não foi possível salvar tradução no cache", e);
    toast("Tradução feita, mas o navegador não conseguiu salvar em cache", "error", 5200);
  }
  return payload;
}

function ensureTranslationStyles() {
  if (document.getElementById("translation-study-styles")) return;
  const style = document.createElement("style");
  style.id = "translation-study-styles";
  style.textContent = `
    .translation-toolbar{
      margin: .85rem 0 1rem;
      padding: .75rem .85rem;
      border: 1px solid color-mix(in srgb, var(--border, #8b7d66) 55%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, var(--surface, #fff8ed) 88%, transparent);
      box-shadow: 0 8px 24px rgba(0,0,0,.06);
    }
    .translation-toolbar.hidden{display:none!important}
    .translation-main{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
    .translation-title{font-weight:700;font-size:.93rem;opacity:.92;margin-right:.15rem}
    .translation-btn{
      border:1px solid color-mix(in srgb, var(--border, #8b7d66) 70%, transparent);
      background: color-mix(in srgb, var(--card, #fff) 82%, transparent);
      color: inherit;
      border-radius: 999px;
      padding: .42rem .72rem;
      font: 600 .82rem/1 system-ui, -apple-system, Segoe UI, sans-serif;
      cursor:pointer;
    }
    .translation-btn.active{background: var(--accent, #8b5e34); color:#fff; border-color: transparent}
    .translation-btn:disabled{opacity:.55;cursor:not-allowed}
    .translation-status{margin-top:.45rem;font-size:.82rem;opacity:.78;line-height:1.35}
    .verse.verse-bilingual{display:block;margin:.52rem 0 .68rem;line-height:1.55}
    .verse.verse-bilingual .vn{vertical-align:top}
    .verse.verse-bilingual .vt{display:inline}
    .verse.verse-bilingual .vt-translated{
      display:block;
      margin:.42rem 0 .24rem 1.55rem;
      padding:.58rem .78rem .62rem .88rem;
      font-size:.94em;
      line-height:1.55;
      opacity:.95;
      font-style:italic;
      color:var(--ink-soft, inherit);
      border:1px solid color-mix(in srgb, var(--line, #2a2620) 82%, transparent);
      border-left:3px solid color-mix(in srgb, var(--gold, #c9a96a) 82%, transparent);
      border-radius:14px;
      background:
        radial-gradient(circle at 0 0, color-mix(in srgb, var(--gold, #c9a96a) 16%, transparent), transparent 38%),
        linear-gradient(135deg, color-mix(in srgb, var(--bg-soft, #221f17) 88%, transparent), color-mix(in srgb, var(--bg-card, #1c1a14) 70%, transparent));
      box-shadow:inset 0 1px 0 rgba(255,255,255,.04), 0 8px 22px rgba(0,0,0,.12);
      backdrop-filter:blur(4px);
    }
    .verse.verse-bilingual .vt-translated::before{content:"↳ ";opacity:.7;font-style:normal;color:var(--gold, #c9a96a)}
    .verse.verse-bilingual:hover .vt-translated{
      border-color:color-mix(in srgb, var(--gold-soft, #a68a4f) 64%, var(--line, #2a2620));
      background:
        radial-gradient(circle at 0 0, color-mix(in srgb, var(--gold, #c9a96a) 22%, transparent), transparent 42%),
        linear-gradient(135deg, color-mix(in srgb, var(--bg-soft, #221f17) 92%, transparent), color-mix(in srgb, var(--bg-card, #1c1a14) 78%, transparent));
    }
    [data-theme="light"] .verse.verse-bilingual .vt-translated,
    [data-theme="sepia"] .verse.verse-bilingual .vt-translated{
      box-shadow:inset 0 1px 0 rgba(255,255,255,.55), 0 8px 22px rgba(80,60,30,.08);
    }
    .translation-warning{font-size:.78rem;opacity:.72;margin-top:.35rem}
  `;
  document.head.appendChild(style);
}

function ensureTranslationToolbar() {
  ensureTranslationStyles();
  let bar = document.getElementById("translation-toolbar");
  if (bar) return bar;

  const progress = document.getElementById("reader-progress");
  const readerText = document.getElementById("reader-text");
  if (!progress || !readerText?.parentElement) return null;

  bar = document.createElement("div");
  bar.id = "translation-toolbar";
  bar.className = "translation-toolbar hidden";
  bar.innerHTML = `
    <div class="translation-main">
      <span class="translation-title">🌐 Tradução para estudo</span>
      <button type="button" class="translation-btn" id="btn-translate-chapter">Traduzir capítulo</button>
      <button type="button" class="translation-btn" id="btn-translation-original">Original</button>
      <button type="button" class="translation-btn" id="btn-translation-bilingual">Original + PT</button>
    </div>
    <div class="translation-status" id="translation-status">—</div>
    <div class="translation-warning">Tradução automática para estudo. O texto original continua sendo a referência.</div>
  `;
  progress.insertAdjacentElement("afterend", bar);

  bar.querySelector("#btn-translate-chapter")?.addEventListener("click", () => translateCurrentChapter({ force: true }));
  bar.querySelector("#btn-translation-original")?.addEventListener("click", () => setTranslationMode("original"));
  bar.querySelector("#btn-translation-bilingual")?.addEventListener("click", () => setTranslationMode("bilingual"));
  return bar;
}

function setTranslationStatus(text) {
  const el = document.getElementById("translation-status");
  if (el) el.textContent = text || "";
}

function updateTranslationToolbar() {
  const bar = ensureTranslationToolbar();
  if (!bar) return;

  const eligible = isTranslationEligible();
  bar.classList.toggle("hidden", !eligible);
  if (!eligible) return;

  const cached = loadCachedTranslation();
  const translating = !!state.translationBusy;
  const btnTranslate = bar.querySelector("#btn-translate-chapter");
  const btnOriginal = bar.querySelector("#btn-translation-original");
  const btnBilingual = bar.querySelector("#btn-translation-bilingual");

  if (btnTranslate) {
    btnTranslate.disabled = translating;
    btnTranslate.textContent = translating ? "Traduzindo…" : (cached ? "Atualizar tradução" : "Traduzir capítulo");
  }
  btnOriginal?.classList.toggle("active", state.translationMode !== "bilingual");
  btnBilingual?.classList.toggle("active", state.translationMode === "bilingual");

  if (translating) return;
  if (state.translationLastError) {
    setTranslationStatus(state.translationLastError);
  } else if (cached) {
    setTranslationStatus(state.translationMode === "bilingual"
      ? "Modo duas linhas ativo: inglês em cima, português abaixo."
      : "Tradução deste capítulo já está salva. Toque em “Original + PT” para exibir.");
  } else if (state.apiKey) {
    setTranslationStatus("Toque em “Traduzir capítulo” para gerar a tradução deste capítulo com Gemini.");
  } else {
    setTranslationStatus("Configure/desbloqueie sua chave Gemini em Configurações para traduzir capítulos.");
  }
}

function getTranslationItems(cache) {
  return Array.isArray(cache) ? cache : (Array.isArray(cache?.items) ? cache.items : []);
}

function applyChapterTranslation(items) {
  const map = new Map(getTranslationItems(items).map(x => [String(x.v), String(x.t || "").trim()]));
  document.querySelectorAll("#reader-text .verse").forEach(el => {
    const v = String(el.dataset.v || "");
    const translated = map.get(v);
    el.querySelector(".vt-translated")?.remove();
    el.classList.remove("verse-bilingual");
    if (!translated) return;
    const target = el.querySelector(".vt");
    if (!target) return;
    const tr = document.createElement("span");
    tr.className = "vt-translated";
    tr.textContent = translated;
    target.insertAdjacentElement("afterend", tr);
    el.classList.add("verse-bilingual");
  });
}

function removeChapterTranslation() {
  document.querySelectorAll("#reader-text .vt-translated").forEach(el => el.remove());
  document.querySelectorAll("#reader-text .verse-bilingual").forEach(el => el.classList.remove("verse-bilingual"));
}

async function setTranslationMode(mode) {
  state.translationMode = mode === "bilingual" ? "bilingual" : "original";
  savePref("translationMode", state.translationMode);

  if (!isTranslationEligible() || state.translationMode !== "bilingual") {
    removeChapterTranslation();
    updateTranslationToolbar();
    return;
  }

  const cached = loadCachedTranslation();
  if (cached) {
    applyChapterTranslation(cached);
    updateTranslationToolbar();
    return;
  }

  await translateCurrentChapter({ force: false });
}

function splitVersesForTranslation(verses) {
  const batches = [];
  let current = [];
  let chars = 0;
  const MAX_CHARS = 3200;
  const MAX_VERSES = 8;

  for (const verse of verses) {
    const normalized = { v: verse.v, t: String(verse.t || "") };
    const size = normalized.t.length + 20;
    if (current.length && (current.length >= MAX_VERSES || chars + size > MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(normalized);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function stripJsonFences(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return s;
}

function parseTranslationJson(text) {
  const clean = stripJsonFences(text);
  let parsed = JSON.parse(clean);
  if (!Array.isArray(parsed) && Array.isArray(parsed?.versiculos)) parsed = parsed.versiculos;
  if (!Array.isArray(parsed) && Array.isArray(parsed?.verses)) parsed = parsed.verses;
  if (!Array.isArray(parsed) && Array.isArray(parsed?.items)) parsed = parsed.items;
  if (!Array.isArray(parsed)) throw new Error("A IA não retornou um array JSON.");
  return parsed.map(item => ({
    v: Number(item.v),
    t: String(item.t ?? item.texto ?? item.translation ?? "").trim()
  })).filter(item => Number.isFinite(item.v) && item.t);
}

function normalizeTranslatedBatch(originalBatch, translatedBatch) {
  const byVerse = new Map(translatedBatch.map(x => [String(x.v), x.t]));
  const normalized = originalBatch.map(v => {
    const translated = byVerse.get(String(v.v));
    if (!translated) throw new Error(`Tradução incompleta no versículo ${v.v}`);
    return { v: Number(v.v), t: translated };
  });
  return normalized;
}

function buildChapterTranslationPrompt(livro, cap, batch) {
  return `Traduza para português do Brasil os versículos abaixo.\n\nRegras obrigatórias:\n- Retorne somente JSON válido.\n- Retorne um array JSON, sem markdown e sem bloco de código.\n- Preserve exatamente o campo "v".\n- Traduza somente o campo "t".\n- Não adicione comentários, notas, explicações ou títulos.\n- Não resuma.\n- Não mude a numeração.\n- Use linguagem bíblica clara e compreensível.\n- Esta é uma tradução automática para estudo; seja fiel ao texto fonte.\n\nReferência: ${livro?.nome || state.livro} ${cap}\n\nEntrada JSON:\n${JSON.stringify(batch)}`;
}

async function callGeminiForTranslation(userPrompt, onChunk) {
  let text = null;
  let lastErr = null;
  const queue = await getModelQueue();
  const maxAttempts = queue.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const modelo = currentModel(queue);
    try {
      state.activeModel = modelo;
      updateGemStatus();
      text = await callGemini({
        apiKey: state.apiKey,
        model: modelo,
        userPrompt,
        onChunk
      });
      break;
    } catch (e) {
      lastErr = e;
      if (isRetryableGeminiError(e) && attempt < maxAttempts - 1) {
        bumpModel(queue);
        continue;
      }
      break;
    }
  }

  if (!text) throw lastErr || new Error("Gemini não retornou texto.");
  return text;
}

async function translateCurrentChapter({ force = false } = {}) {
  if (!isTranslationEligible()) return;
  if (state.translationBusy) return;

  const cached = loadCachedTranslation();
  if (cached && !force) {
    state.translationMode = "bilingual";
    savePref("translationMode", state.translationMode);
    applyChapterTranslation(cached);
    updateTranslationToolbar();
    return;
  }

  if (!state.apiKey) {
    toast("Configure ou desbloqueie sua chave Gemini em Configurações", "error", 5600);
    updateTranslationToolbar();
    return;
  }

  state.translationBusy = true;
  state.translationLastError = "";
  updateTranslationToolbar();
  setTranslationStatus("Preparando capítulo para tradução…");

  try {
    const livro = getLivro(state.livro);
    const original = await loadCap(state.livro, state.cap);
    const cleanOriginal = original.map(v => ({ v: Number(v.v), t: String(v.t || "") }))
      .filter(v => Number.isFinite(v.v) && v.t.trim());
    if (!cleanOriginal.length) throw new Error("Capítulo vazio.");

    const batches = splitVersesForTranslation(cleanOriginal);
    const translatedAll = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      setTranslationStatus(`Traduzindo lote ${i + 1}/${batches.length}…`);
      const prompt = buildChapterTranslationPrompt(livro, state.cap, batch);
      const raw = await callGeminiForTranslation(prompt);
      const parsed = parseTranslationJson(raw);
      translatedAll.push(...normalizeTranslatedBatch(batch, parsed));
    }

    const payload = saveCachedTranslation(translatedAll);
    state.translationMode = "bilingual";
    savePref("translationMode", state.translationMode);
    applyChapterTranslation(payload);
    toast("Tradução aplicada em duas linhas");
  } catch (e) {
    console.error("[Lectio] Falha na tradução", e);
    state.translationLastError = `Erro: ${e?.message || "não foi possível traduzir este capítulo."}`;
    toast(`Erro ao traduzir: ${e?.message || "resposta inválida da IA"}`, "error", 7200);
    setTranslationStatus(state.translationLastError);
  } finally {
    state.translationBusy = false;
    updateTranslationToolbar();
  }
}

function syncTranslationForCurrentChapter() {
  state.translationLastError = "";
  updateTranslationToolbar();
  if (!isTranslationEligible()) {
    removeChapterTranslation();
    return;
  }
  if (state.translationMode !== "bilingual") {
    removeChapterTranslation();
    return;
  }
  const cached = loadCachedTranslation();
  if (cached) {
    applyChapterTranslation(cached);
  } else {
    removeChapterTranslation();
    setTranslationStatus("Este capítulo ainda não foi traduzido. Toque em “Traduzir capítulo”.");
  }
}


/* ---------- Inicialização ---------- */
async function boot() {
  const prefs = loadPrefs();

  if (location.protocol === "file:") {
    const msg = "Abra o Lectio por um servidor HTTP/HTTPS. Ex.: npx serve, Live Server ou hospedagem. O navegador bloqueia os JSON em file://.";
    $("#reader-text").innerHTML = `<p style="text-align:center;color:var(--danger);max-width:680px;margin:4rem auto">${msg}</p>`;
    toast(msg, "error", 9000);
    bindUI();
    return;
  }

  try {
    if (prefs.lang && prefs.lang !== "pt") {
      await setLang(prefs.lang);
    } else {
      await loadLivros();
    }
  } catch (e) {
    console.error(e);
    $("#reader-text").innerHTML = `<p style="text-align:center;color:var(--danger);max-width:680px;margin:4rem auto">Não foi possível carregar os livros bíblicos. Verifique se a pasta dados/ está no servidor.</p>`;
    bindUI();
    return;
  }

  try { state.refsData = await (await fetch("./referencias/cruzadas.json")).json(); } catch { state.refsData = {}; }
  try { state.cicData  = await (await fetch("./referencias/catecismo.json")).json(); } catch { state.cicData = {}; }
  try { state.cicTexto = await (await fetch("./referencias/catecismo-texto.json")).json(); } catch { state.cicTexto = {}; }

  document.body.dataset.theme = prefs.theme || "sepia";
  applyReaderBg(prefs.readerBg || "parchment");
  applyReaderFont(prefs.readerFont || "garamond");
  if (prefs.fontSize) applyFz(parseInt(prefs.fontSize) || 18);
  state.translationMode = prefs.translationMode || "original";

  renderSidebar();

  const prog = loadProgress();
  if (prog && getLivro(prog.livro)) { state.livro = prog.livro; state.cap = prog.cap; }
  ensureValidCurrentReference();

  if (FIREBASE_READY) {
    // GARANTIR que o login aparece IMEDIATAMENTE, antes de qualquer chamada
    // ao Firebase. Se setupAuth() ou onAuthStateChanged jogar erro síncrono,
    // o overlay já estará visível e o user pelo menos consegue ver a tela.
    $("#auth-overlay").classList.remove("hidden");
    $("#auth-step-login").classList.remove("hidden");
    $("#auth-step-master").classList.add("hidden");
    $("#auth-step-unlock").classList.add("hidden");

    try {
      setupAuth();
    } catch (e) {
      console.error("[Lectio] setupAuth falhou", e);
      toast("Login indisponível — abrindo em modo offline", "error", 5000);
      _authResolved = true;
      $("#auth-overlay").classList.add("hidden");
      setUid(null);
      await openReader();
      showAuthHint();
    }

    // Timeout: se Firebase não responder em 6s (CDN bloqueado, rede ruim,
    // CSP, config inválida que faz onAuthStateChanged nunca disparar),
    // libera a leitura em modo offline.
    setTimeout(async () => {
      if (_authResolved) return;
      console.warn("[Lectio] Firebase auth não respondeu em 6s — caindo para offline");
      _authResolved = true;
      $("#auth-overlay").classList.add("hidden");
      setUid(null);
      try { await openReader(); } catch (e) { showFatalError("openReader-fallback", e); }
      toast("Firebase travado — você pode usar o app offline. Confira a config Firebase.", "error", 7000);
    }, 6000);
  } else {
    setUid(null);
    await openReader();
    showAuthHint();
  }

  bindUI();
  // Estado inicial do painel de Notas — desabilitado até user selecionar versículo
  populateNote();
}

function showAuthHint() {
  $("#account-info").textContent = "Modo offline — dados salvos neste navegador";
  toast("Modo offline ativo. Para sincronizar entre dispositivos, preencha js/firebase-config.js.", "ok", 5200);
}

/* ---------- Auth ---------- */
function setupAuth() {
  onAuthStateChanged(auth, async (user) => {
    _authResolved = true;
    if (user) {
      setUid(user.uid);
      $("#auth-overlay").classList.add("hidden");
      $("#account-info").textContent = user.isAnonymous
        ? "Conta anônima"
        : `${user.displayName || user.email || "Usuário"}${user.email ? " — " + user.email : ""}`;
      await openReader();
      const blob = await loadEncryptedKey();
      if (blob?.gemini) {
        state.encBlob = blob.gemini;
        state.model   = blob.model || "gemini-2.5-flash";
        const restored = restoreSessionGeminiKey();
        if (!restored) {
          $("#auth-overlay").classList.remove("hidden");
          $("#auth-step-login").classList.add("hidden");
          $("#auth-step-master").classList.add("hidden");
          $("#auth-step-unlock").classList.remove("hidden");
        } else {
          $("#auth-overlay").classList.add("hidden");
        }
      }
      updateGemStatus();
    } else {
      setUid(null);
      $("#auth-overlay").classList.remove("hidden");
      $("#auth-step-login").classList.remove("hidden");
      $("#auth-step-master").classList.add("hidden");
      $("#auth-step-unlock").classList.add("hidden");
    }
  });
}

/* ---------- UI Bind ---------- */
function bindUI() {
  $("#btn-google")?.addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { toast("Erro no login: " + e.message, "error"); }
  });
  $("#btn-anon")?.addEventListener("click", async () => {
    // Botão realmente offline: não depende de Anonymous Auth ativado no Firebase.
    setUid(null);
    $("#auth-overlay").classList.add("hidden");
    await openReader();
    showAuthHint();
  });

  $("#btn-master-set")?.addEventListener("click", async () => {
    const p1 = $("#master-pass").value;
    const p2 = $("#master-pass-2").value;
    if (p1.length < 8) return toast("Senha-mestra precisa de ≥ 8 caracteres", "error");
    if (p1 !== p2)     return toast("Senhas não conferem", "error");
    state.master = p1;
    $("#auth-overlay").classList.add("hidden");
    toast("Senha-mestra definida. Agora cadastre sua chave Gemini em Configurações.");
  });
  $("#btn-master-skip")?.addEventListener("click", () => $("#auth-overlay").classList.add("hidden"));

  $("#btn-master-unlock")?.addEventListener("click", async () => {
    const p = $("#master-unlock").value;
    try {
      const key    = await decryptString(state.encBlob, p);
      state.apiKey = key;
      state.master = p;
      saveSessionGeminiKey(key, state.model);
      $("#auth-overlay").classList.add("hidden");
      $("#master-unlock").value = "";
      toast("Chave desbloqueada");
      updateGemStatus();
    } catch {
      toast("Senha incorreta", "error");
    }
  });
  $("#btn-master-later")?.addEventListener("click", () => $("#auth-overlay").classList.add("hidden"));
  $("#btn-master-reset")?.addEventListener("click", async () => {
    if (!confirm("Apagar a chave Gemini cifrada? Você precisará cadastrar de novo.")) return;
    await clearEncryptedKey();
    clearSessionGeminiKey();
    state.encBlob = null;
    state.apiKey  = null;
    $("#auth-overlay").classList.add("hidden");
    toast("Chave apagada.");
    updateGemStatus();
  });

  $("#btn-menu").addEventListener("click", () => togglePanel("sidebar"));
  $("#ref-pill").addEventListener("click", openRefModal);
  $("#btn-search").addEventListener("click", () => openModal("#modal-search"));
  $("#btn-liturgia").addEventListener("click", openLiturgia);
  initDevocionario({ openModal, toast });
  $("#btn-oracoes")?.addEventListener("click", openDevocionario);
  // PATCH v19: abas laterais mobile — Biblioteca à esquerda e Estudo à direita.
  $("#library-edge-tab")?.addEventListener("click", () => togglePanel("sidebar"));
  $("#study-edge-tab")?.addEventListener("click", () => togglePanel("study"));
  $("#btn-side-close")?.addEventListener("click", () => closePanels());
  $("#btn-study-close")?.addEventListener("click", () => closePanels());
  $("#panel-scrim")?.addEventListener("click", () => closePanels());
  $("#btn-settings").addEventListener("click", () => {
    openModal("#modal-settings");
    refreshSettings();
  });

  // PATCH v19: no mobile o botão superior agora é a engrenagem e abre Configurações direto.
  $("#btn-more")?.addEventListener("click", (e) => {
    e.stopPropagation();
    $("#more-menu")?.classList.add("hidden");
    openModal("#modal-settings");
    refreshSettings();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#more-menu") && !e.target.closest("#btn-more"))
      $("#more-menu")?.classList.add("hidden");
  });
  $$("#more-menu .more-item").forEach(b => b.addEventListener("click", () => {
    const action = b.dataset.action;
    $("#more-menu").classList.add("hidden");
    if (action === "settings") {
      openModal("#modal-settings");
      refreshSettings();
    }
  }));

  document.addEventListener("click", e => {
    const welcomeBtn = e.target.closest("[data-onboarding-action]");
    if (!welcomeBtn) return;
    const action = welcomeBtn.dataset.onboardingAction;
    e.preventDefault();
    if (action === "pray") return closeWelcome({ openPrayers: true });
    return closeWelcome();
  });

  document.addEventListener("click", e => {
    const closeBtn = e.target.closest("[data-close]");
    if (!closeBtn) return;
    const modal = closeBtn.closest(".modal");
    if (!modal) return;
    e.preventDefault();
    closeModal(modal);
  });
  $$(".modal").forEach(m => m.addEventListener("click", e => {
    if (e.target === m) closeModal(m);
  }));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      const modal = document.querySelector(".modal:not(.hidden)");
      if (modal) closeModal(modal);
    } else if (e.key === "Tab") {
      trapModalFocus(e);
    }
  });

  $$(".side-tab").forEach(b => b.addEventListener("click", () => {
    $$(".side-tab").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderSidebar(b.dataset.tab);
  }));

  $$(".study-tab").forEach(b => b.addEventListener("click", () => {
    $$(".study-tab").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    $$(".study-pane").forEach(p => p.classList.remove("active"));
    const pane = $(`[data-pane="${b.dataset.stab}"]`);
    pane?.classList.add("active");
    if (b.dataset.stab === "studies") renderSavedStudies();
  }));

  $("#prev-cap").addEventListener("click", () => {
    const l = getLivro(state.livro);
    if (state.cap > 1) { state.cap--; openReader(); }
    else {
      const idx = getLivros().findIndex(x => x.id === state.livro);
      if (idx > 0) {
        const prev = getLivros()[idx - 1];
        state.livro = prev.id; state.cap = prev.caps; openReader();
      }
    }
  });
  $("#next-cap").addEventListener("click", () => {
    const l = getLivro(state.livro);
    if (state.cap < l.caps) { state.cap++; openReader(); }
    else {
      const idx = getLivros().findIndex(x => x.id === state.livro);
      if (idx < getLivros().length - 1) {
        const nxt = getLivros()[idx + 1];
        state.livro = nxt.id; state.cap = 1; openReader();
      }
    }
  });

  $("#btn-lectio").addEventListener("click", openLectio);
  $("#btn-fullread").addEventListener("click", () => toggleFocus());
  $("#btn-focus-exit")?.addEventListener("click", () => toggleFocus(false));
  $("#btn-compare").addEventListener("click", openCompare);
  $("#btn-toggle-read")?.addEventListener("click", toggleCurrentChapterRead);
  $("#reader-fz-down")?.addEventListener("click", () => bumpFz(-1));
  $("#reader-fz-up")?.addEventListener("click", () => bumpFz(+1));

  $("#search-input").addEventListener("input", debounce(runSearch, 350));

  $$(".prompt-chip").forEach(c => c.addEventListener("click", () => runPrompt(c.dataset.prompt)));
  $("#ai-send").addEventListener("click", () => {
    const txt = $("#ai-input").value.trim();
    if (!txt) return;
    runFreeQuestion(txt);
    $("#ai-input").value = "";
  });
  $("#ai-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ai-send").click(); }
  });

  $("#save-note").addEventListener("click", saveCurrentNote);
  $("#btn-share-verse")?.addEventListener("click", shareSelectedVersesAsImage);
  $$(".color-dot").forEach(d => d.addEventListener("click", () => applyColor(d.dataset.color)));

  $("#btn-save-key").addEventListener("click", onSaveKey);
  $("#btn-clear-key").addEventListener("click", async () => {
    if (!confirm("Apagar chave salva?")) return;
    await clearEncryptedKey();
    clearSessionGeminiKey();
    state.encBlob = null; state.apiKey = null;
    _modelQueue = []; _modelQueueKey = ""; resetModelRotation();
    updateGemStatus();
    toast("Chave apagada");
  });
  $("#btn-logout")?.addEventListener("click", async () => {
    if (!confirm("Sair da conta? Suas marcações e notas locais permanecem neste navegador.")) return;
    try {
      if (FIREBASE_READY) await signOut(auth);
    } catch (e) {
      console.warn("[Lectio] signOut falhou", e);
    }
    // Limpa estado de sessão (mas mantém dados locais)
    clearSessionGeminiKey();
    state.apiKey = null;
    state.master = null;
    state.activeModel = null;
    setUid(null);
    _modelQueue = []; _modelQueueKey = ""; resetModelRotation();

    // Atualiza UI
    closeModal($("#modal-settings"));
    $("#account-info").textContent = FIREBASE_READY
      ? "Não conectado"
      : "Modo offline — dados salvos neste navegador";
    updateGemStatus();
    toast("Você saiu da conta");

    // Se Firebase ativo, mostra overlay de login pra entrar com outra conta
    if (FIREBASE_READY) {
      _authResolved = false;
      $("#auth-overlay").classList.remove("hidden");
      $("#auth-step-login").classList.remove("hidden");
      $("#auth-step-master").classList.add("hidden");
      $("#auth-step-unlock").classList.add("hidden");
    }
  });
  $$(".theme-pick").forEach(b => b.addEventListener("click", () => {
    document.body.dataset.theme = b.dataset.theme;
    savePref("theme", b.dataset.theme);
    refreshSettings();
  }));

  // PATCH V26: fundo de leitura limpo/pergaminho suave, salvo localmente.
  $$(".bg-pick").forEach(b => b.addEventListener("click", () => {
    const bg = b.dataset.bg || "plain";
    applyReaderBg(bg);
    savePref("readerBg", bg);
    refreshSettings();
    toast(bg === "parchment" ? "Fundo pergaminho suave ativado" : "Fundo limpo ativado");
  }));

  $("#font-size").addEventListener("input", e => {
    applyFz(parseInt(e.target.value) || 18);
    savePref("fontSize", e.target.value);
  });
  $("#reader-font")?.addEventListener("change", e => {
    const font = e.target.value || "garamond";
    applyReaderFont(font);
    savePref("readerFont", font);
    toast("Fonte da leitura atualizada");
  });

  $("#fz-down")?.addEventListener("click", () => bumpFz(-1));
  $("#fz-up")?.addEventListener("click",   () => bumpFz(+1));

  // PATCH V21: botao flutuante Aa abre um mini controle de fonte.
  $("#fz-toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("#fz-popover");
    const btn = $("#fz-toggle");
    if (!pop || !btn) return;
    const willOpen = pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !willOpen);
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });

  $("#fz-settings")?.addEventListener("click", (e) => {
    e.stopPropagation();
    $("#fz-popover")?.classList.add("hidden");
    $("#fz-toggle")?.setAttribute("aria-expanded", "false");
    openModal("#modal-settings");
    refreshSettings();
    setTimeout(() => $("#reader-font")?.focus(), 120);
  });

  $("#fz-bg-toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = document.body.dataset.readerBg || "plain";
    const next = current === "parchment" ? "plain" : "parchment";
    applyReaderBg(next);
    savePref("readerBg", next);
    refreshSettings();
    toast(next === "parchment" ? "Fundo pergaminho suave ativado" : "Fundo limpo ativado");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#fz-fab")) {
      $("#fz-popover")?.classList.add("hidden");
      $("#fz-toggle")?.setAttribute("aria-expanded", "false");
    }
  });

  $("#btn-export-studies")?.addEventListener("click", exportSavedStudies);
  $("#btn-import-studies")?.addEventListener("click", () => $("#studies-import-file")?.click());
  $("#studies-import-file")?.addEventListener("change", (e) => {
    importSavedStudiesFile(e.target.files?.[0]);
    e.target.value = "";
  });
  $("#saved-studies-list")?.addEventListener("click", handleSavedStudiesClick);
  renderSavedStudies();


  $$(".lang-pick").forEach(b => b.addEventListener("click", () => switchLang(b.dataset.lang)));
  $("#livro-filter").addEventListener("input", e => filterBooks(e.target.value));
  $$(".lectio-step").forEach(s => s.addEventListener("click", () => switchLectio(parseInt(s.dataset.step))));

  setupResponsiveChrome();
}

/* ---------- Sidebar ---------- */
function renderSidebar(tab = "livros") {
  const c = $("#side-content");
  if (tab === "livros") {
    let html = "";
    if (isBibliotecaExpandidaActive()) {
      const grupos = new Map();
      for (const l of getLivros()) {
        const nomeGrupo = l.grupo || "Outros textos antigos";
        if (!grupos.has(nomeGrupo)) grupos.set(nomeGrupo, []);
        grupos.get(nomeGrupo).push(l);
      }
      for (const [nomeGrupo, livrosNoGrupo] of grupos.entries()) {
        html += `<div class="book-group">${escape(nomeGrupo)}</div>`;
        for (const l of livrosNoGrupo) {
          const active = l.id === state.livro ? "active" : "";
          html += `<button class="book-item ${active}" data-id="${l.id}" title="${escape(l.fonte || l.categoria || l.nome)}">${escape(l.nome)}</button>`;
        }
      }
    } else {
      for (const g of BOOK_GROUPS) {
        const livrosNoGrupo = getLivros().filter(l => g.ids.includes(l.id));
        if (livrosNoGrupo.length === 0) continue;
        html += `<div class="book-group">${g.name}</div>`;
        for (const l of livrosNoGrupo) {
          const active = l.id === state.livro ? "active" : "";
          html += `<button class="book-item ${active}" data-id="${l.id}">${l.nome}</button>`;
        }
      }
    }
    c.innerHTML = html;
    c.querySelectorAll(".book-item").forEach(b => b.addEventListener("click", () => {
      state.livro = b.dataset.id; state.cap = 1; openReader();
      closePanels();
    }));
  } else if (tab === "favoritos") {
    loadHighlights().then(hls => {
      const entries = Object.entries(hls);
      if (!entries.length) { c.innerHTML = `<div class="pane-empty">Nenhum versículo marcado.</div>`; return; }
      c.innerHTML = entries.map(([k, color]) => {
        const [li, ca, vn] = k.split("/");
        const livro = getLivro(li);
        return `<div class="fav-item" data-key="${k}">
          <span class="fav-ref">${livro?.nome || li} ${ca}:${vn}</span>
          <span class="fav-text" id="ft-${k.replace(/\//g,'-')}">…</span>
          <button class="item-delete" data-act="del-hl" aria-label="Remover marcação" title="Remover marcação">✕</button>
        </div>`;
      }).join("");
      c.querySelectorAll(".fav-item").forEach(it => {
        const [li, ca, vn] = it.dataset.key.split("/");
        fillFavText(li, ca, vn);
        // Botão delete
        it.querySelector(".item-delete")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm(`Remover marcação de ${li.replace(/_/g,' ')} ${ca}:${vn}?`)) return;
          await setHighlight(it.dataset.key, "none");
          renderSidebar("favoritos");
          // Atualiza visual no leitor se o versículo estiver visível
          const verseEl = document.querySelector(`.verse[data-livro="${li}"][data-cap="${ca}"][data-v="${vn}"]`);
          if (verseEl) verseEl.classList.remove("hl-gold","hl-rose","hl-sage","hl-azure","hl-violet");
          toast("Marcação removida");
        });
        // Clique no item navega
        it.addEventListener("click", (e) => {
          if (e.target.closest(".item-delete")) return;
          jumpToVerseAndSelect(li, parseInt(ca, 10), parseInt(vn, 10));
        });
      });
    });
  } else if (tab === "notas") {
    loadNotes().then(notes => {
      const entries = Object.entries(notes);
      if (!entries.length) { c.innerHTML = `<div class="pane-empty">Nenhuma nota.</div>`; return; }
      c.innerHTML = entries.map(([k, txt]) => {
        const [li, ca, vn] = k.split("/");
        const livro = getLivro(li);
        return `<div class="fav-item" data-key="${k}">
          <span class="fav-ref">${livro?.nome || li} ${ca}:${vn}</span>
          <span class="fav-text">${escape(txt).slice(0,140)}</span>
          <button class="item-delete" data-act="del-note" aria-label="Apagar nota" title="Apagar nota">✕</button>
        </div>`;
      }).join("");
      c.querySelectorAll(".fav-item").forEach(it => {
        const [li, ca, vn] = it.dataset.key.split("/");
        // Botão delete
        it.querySelector(".item-delete")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm(`Apagar nota de ${li.replace(/_/g,' ')} ${ca}:${vn}?`)) return;
          await setNote(it.dataset.key, "");
          renderSidebar("notas");
          // Remove indicador no leitor se versículo visível
          const verseEl = document.querySelector(`.verse[data-livro="${li}"][data-cap="${ca}"][data-v="${vn}"]`);
          verseEl?.classList.remove("has-note");
          toast("Nota apagada");
        });
        // Clique no item navega e seleciona o versículo (pra editar a nota)
        it.addEventListener("click", (e) => {
          if (e.target.closest(".item-delete")) return;
          jumpToVerseAndSelect(li, parseInt(ca, 10), parseInt(vn, 10));
        });
      });
    });
  }
}

function filterBooks(q) {
  const needle = normalizeText(q.trim());
  $$(".book-item").forEach(b => {
    b.style.display = !needle || normalizeText(b.textContent).includes(needle) ? "" : "none";
  });
  $$(".book-group").forEach(g => {
    let next = g.nextElementSibling;
    let any  = false;
    while (next && next.classList.contains("book-item")) {
      if (next.style.display !== "none") any = true;
      next = next.nextElementSibling;
    }
    g.style.display = any ? "" : "none";
  });
}

async function fillFavText(livroId, cap, verso) {
  const slot = document.getElementById(`ft-${`${livroId}/${cap}/${verso}`.replace(/\//g, "-")}`);
  if (!slot) return;
  try {
    const data = await loadCap(livroId, parseInt(cap));
    const found = data.find(x => String(x.v) === String(verso));
    slot.textContent = found ? found.t.slice(0, 150) + (found.t.length > 150 ? "…" : "") : "Versículo não encontrado.";
  } catch {
    slot.textContent = "Texto indisponível.";
  }
}

/* ---------- Leitor ---------- */

function applyReaderFont(font) {
  const allowed = new Set(["garamond", "georgia", "lora", "merriweather", "sans"]);
  const value = allowed.has(font) ? font : "garamond";
  document.body.dataset.readerFont = value;
}

function applyReaderBg(bg) {
  const allowed = new Set(["plain", "parchment"]);
  const value = allowed.has(bg) ? bg : "plain";
  document.body.dataset.readerBg = value;
}

async function openReader() {
  // ← CORRIGIDO: limpa seleção ao trocar de capítulo
  state.selVerses = [];
  updateCtxDisplay();

  if (!ensureValidCurrentReference()) return;
  const livro = getLivro(state.livro);
  $("#reader-livro").textContent = livro.nome;
  $("#reader-cap").textContent   = `Capítulo ${state.cap}`;
  $("#ref-livro").textContent    = livro.nome;
  $("#ref-cap").textContent      = state.cap;

  try {
    await renderCap(state.livro, state.cap, $("#reader-text"));
  } catch (e) {
    console.error("[Lectio] Falha ao renderizar capítulo", { lang: getLang(), livro: state.livro, cap: state.cap, erro: e });
    $("#reader-text").innerHTML = `<p style="text-align:center;color:var(--danger)">Capítulo não disponível em ${escape(getLang())}: ${escape(state.livro)} ${escape(String(state.cap))}.<br><small>${escape(e?.message || "erro desconhecido")}</small></p>`;
    return;
  }

  $$(".verse").forEach(v => bindVerseGesture(v));
  syncTranslationForCurrentChapter();
  $$(".book-item").forEach(b => b.classList.toggle("active", b.dataset.id === state.livro));
  saveProgress(state.livro, state.cap);
  await updateReadProgressUI();
  const reader = $("#reader");
  if (reader) reader.scrollTop = 0;
  _lastReaderScrollTop = 0;
  setTopActionsCollapsed(false, "chapter");
  maybeShowWelcome();
}

/* ---------- Progresso de leitura da Bíblia ---------- */
function chapterKey(livro = state.livro, cap = state.cap) {
  return `${livro}/${cap}`;
}

function getTotalBibleChapters() {
  return getLivros().reduce((sum, livro) => sum + (parseInt(livro.caps, 10) || 0), 0);
}

async function updateReadProgressUI() {
  const data = await loadReadChapters();
  const readCount = Object.keys(data || {}).length;
  const total = getTotalBibleChapters() || 1;
  const pct = Math.min(100, Math.round((readCount / total) * 1000) / 10);
  const isRead = !!data[chapterKey()];

  const btn = $("#btn-toggle-read");
  const pctEl = $("#read-percent");
  const bar = $("#read-progress-fill");

  if (btn) {
    btn.classList.toggle("active", isRead);
    btn.textContent = isRead ? "✓ Capítulo lido" : "Marcar capítulo como lido";
    btn.setAttribute("aria-pressed", isRead ? "true" : "false");
  }
  if (pctEl) pctEl.textContent = `${pct}% da Bíblia lida · ${readCount}/${total} capítulos`;
  if (bar) bar.style.width = pct + "%";
}

async function toggleCurrentChapterRead() {
  const data = await loadReadChapters();
  const key = chapterKey();
  const nextValue = !data[key];
  await setReadChapter(key, nextValue);
  await updateReadProgressUI();
  toast(nextValue ? "Capítulo marcado como lido" : "Capítulo desmarcado");
}

/* ---------- CORRIGIDO: selectVerse com toggle múltiplo ---------- */
function selectVerse(el) {
  const livro = el.dataset.livro;
  const cap   = parseInt(el.dataset.cap);
  const v     = parseInt(el.dataset.v);
  const t     = el.querySelector(".vt").textContent;
  const key   = `${livro}/${cap}/${v}`;

  const idx = state.selVerses.findIndex(
    x => `${x.livro}/${x.cap}/${x.v}` === key
  );

  if (idx !== -1) {
    // já estava — remove
    state.selVerses.splice(idx, 1);
    el.classList.remove("selected");
  } else {
    // novo — adiciona
    state.selVerses.push({ livro, cap, v, t });
    el.classList.add("selected");
  }

  updateCtxDisplay();
  populateRefs();
  populateCIC();
  populateNote();
}
/* ---------- PATCH V32: salto de referência com seleção persistente ---------- */
function clearSelectedVersesUI() {
  $$(".verse.selected").forEach(v => v.classList.remove("selected"));
}

function forceSelectVerse(el, options = {}) {
  if (!el) return false;
  const replace = options.replace !== false;
  if (replace) {
    state.selVerses = [];
    clearSelectedVersesUI();
  }

  const livro = el.dataset.livro;
  const cap   = parseInt(el.dataset.cap, 10);
  const v     = parseInt(el.dataset.v, 10);
  const t     = el.querySelector(".vt")?.textContent || "";
  const key   = `${livro}/${cap}/${v}`;

  if (!state.selVerses.some(x => `${x.livro}/${x.cap}/${x.v}` === key)) {
    state.selVerses.push({ livro, cap, v, t });
  }
  el.classList.add("selected");

  if (options.flash) {
    el.classList.remove("ref-jump");
    void el.offsetWidth;
    el.classList.add("ref-jump");
    window.setTimeout(() => el.classList.remove("ref-jump"), 1800);
  }

  updateCtxDisplay();
  populateRefs();
  populateCIC();
  populateNote();
  return true;
}

async function jumpToVerseAndSelect(livro, cap, vIni, vFim = null) {
  state.livro = livro;
  state.cap = parseInt(cap, 10);
  const firstVerse = parseInt(vIni, 10);
  const lastVerse = vFim ? parseInt(vFim, 10) : firstVerse;

  await openReader();

  {
    const startEl = document.querySelector(`.verse[data-livro="${livro}"][data-cap="${state.cap}"][data-v="${firstVerse}"]`)
      || document.querySelector(`.verse[data-v="${firstVerse}"]`);
    if (!startEl) {
      toast("Referência aberta, mas o versículo não foi encontrado.", "warning");
      return;
    }

    clearSelectedVersesUI();
    state.selVerses = [];
    const max = Math.max(firstVerse, lastVerse);
    for (let n = firstVerse; n <= max; n++) {
      const el = document.querySelector(`.verse[data-livro="${livro}"][data-cap="${state.cap}"][data-v="${n}"]`)
        || document.querySelector(`.verse[data-v="${n}"]`);
      if (el) forceSelectVerse(el, { replace: false, flash: n === firstVerse });
    }

    startEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}


function getOrderedSelectedVerses() {
  const svs = state.selVerses.slice();
  if (!svs.length) return svs;

  const first = svs[0];
  const sameBook = svs.every(x => x.livro === first.livro);
  const sameCap = svs.every(x => x.cap === first.cap);

  if (sameBook && sameCap) {
    return svs.sort((a, b) => a.v - b.v);
  }

  return svs;
}

function buildSelectedReference(svs = state.selVerses) {
  if (!svs.length) return "";

  const ordered = getOrderedSelectedVerses();
  const first = ordered[0];
  const livroNome = getLivro(first.livro)?.nome || first.livro;

  if (ordered.length === 1) return `${livroNome} ${first.cap}:${first.v}`;

  const sameBook = ordered.every(x => x.livro === first.livro);
  const sameCap = ordered.every(x => x.cap === first.cap);

  if (sameBook && sameCap) {
    const vs = ordered.map(x => x.v);
    return `${livroNome} ${first.cap}:${vs[0]}–${vs[vs.length - 1]}`;
  }

  if (sameBook) return `${livroNome} (${ordered.length} versos)`;
  return `${ordered.length} versos selecionados`;
}

function getCurrentTranslationLabel() {
  const current = getBibleVersions().find(v => v.id === getLang());
  return current?.shortLabel || current?.label || getLang();
}

function buildSelectedPassageForShare() {
  const ordered = getOrderedSelectedVerses();
  if (!ordered.length) return null;

  const first = ordered[0];
  const sameBook = ordered.every(x => x.livro === first.livro);
  const sameCap = ordered.every(x => x.cap === first.cap);

  const text = ordered.length === 1
    ? ordered[0].t
    : ordered.map(sv => {
        if (sameBook && sameCap) return `${sv.v}. ${sv.t}`;
        const livroNome = getLivro(sv.livro)?.nome || sv.livro;
        return `${livroNome} ${sv.cap}:${sv.v} — ${sv.t}`;
      }).join(" ");

  return {
    text,
    reference: buildSelectedReference(ordered),
    translation: getCurrentTranslationLabel()
  };
}

async function shareSelectedVersesAsImage() {
  if (!state.selVerses.length) return toast("Selecione um versículo primeiro", "error");
  if (state.selVerses.length > MAX_SHARE_VERSES) {
    return toast(`Para a imagem ficar legível, selecione até ${MAX_SHARE_VERSES} versículos.`, "error", 5200);
  }

  const data = buildSelectedPassageForShare();
  if (!data) return toast("Selecione um versículo primeiro", "error");

  const btn = $("#btn-share-verse");
  const originalText = btn?.textContent || "Gerar imagem do versículo";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Gerando imagem…";
  }

  try {
    await downloadVerseShareImage(data, {
      background: document.body.dataset.theme || "sepia"
    });
    toast("Imagem do versículo gerada");
  } catch (err) {
    console.error("[Lectio] Falha ao compartilhar versículo", err);
    toast(err?.message || "Não foi possível gerar a imagem.", "error", 6000);
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = !state.selVerses.length;
    }
  }
}

/* ---------- NOVO: updateCtxDisplay ---------- */
function updateCtxDisplay() {
  const svs = state.selVerses;
  const shareBtn = $("#btn-share-verse");
  if (!svs.length) {
    $("#ctx-value").textContent    = "—";
    $("#notes-target").textContent = "—";
    if (shareBtn) shareBtn.disabled = true;
    $("#refs-empty")?.classList.remove("hidden");
    $("#refs-list").innerHTML = "";
    $("#cic-empty")?.classList.remove("hidden");
    $("#cic-list").innerHTML = "";
    return;
  }

  const ref = buildSelectedReference(svs);

  $("#ctx-value").textContent    = ref;
  $("#notes-target").textContent = ref;
  if (shareBtn) shareBtn.disabled = false;
}

function bindVerseGesture(el) {
  let timer = null;
  let longFired = false;
  let startX = 0, startY = 0;
  const LONG_MS  = 450;
  const MOVE_TOL = 10;

  const cancel = () => { clearTimeout(timer); timer = null; };

  el.addEventListener("pointerdown", (e) => {
    longFired = false;
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => {
      longFired = true;
      if (navigator.vibrate) navigator.vibrate(20);
      selectVerse(el);
      // só abre o painel automaticamente em desktop (em mobile fica intrusivo)
      if (window.innerWidth > 1100) togglePanel("study", true);
    }, LONG_MS);
  });

  el.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > MOVE_TOL || Math.abs(e.clientY - startY) > MOVE_TOL) cancel();
  });

  el.addEventListener("pointerup", () => {
    if (timer) {
      cancel();
      if (!longFired) {
        // Toque simples agora APENAS seleciona/desseleciona o versículo.
        // A marcação salva em “Marcados” só acontece quando o usuário
        // escolhe uma cor no painel Notas/Marcar.
        selectVerse(el);
      }
    }
  });

  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      cancel();
      selectVerse(el);
      if (window.innerWidth > 1100) togglePanel("study", true);
    }
  });
}

/* Marcação rápida por toque foi desativada.
   Motivo: o toque no versículo deve servir só para selecionar o contexto de estudo.
   Para salvar em “Marcados”, use os botões de cor no painel Notas/Marcar. */
function bumpFz(delta) {
  const cur  = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--reader-fz")) || 18;
  const next = Math.max(14, Math.min(32, cur + delta));
  applyFz(next);
  savePref("fontSize", next);
  const slider = $("#font-size");
  if (slider) slider.value = next;
}

function applyFz(px) {
  const root  = document.documentElement;
  root.style.setProperty("--reader-fz", px + "px");
  root.style.setProperty("--liturgia-fz", px + "px");
  // ✨ patch v1: --ai-fz também escala (era fixo, contra o que o comentário do CSS dizia)
  // mantém ai um pouco menor que o reader (≈ 0.92x) pra não dominar o painel lateral
  const aiPx = Math.round(px * 0.92 * 10) / 10;
  root.style.setProperty("--ai-fz", aiPx + "px");
  const ratio = px / 18;
  const scale = Math.pow(ratio, 0.7);
  root.style.setProperty("--ui-scale", scale.toFixed(3));
}

async function switchLang(lang) {
  if (!isKnownLang(lang)) {
    toast(`Tradução desconhecida no reader.js: ${lang}. Suba js/reader.js atualizado e limpe o cache.`, "error", 7000);
    console.error("[Lectio] Tradução desconhecida", lang);
    return;
  }

  const forceBibliotecaReset = lang === "biblioteca_expandida";
  if (getLang() === lang && !forceBibliotecaReset) return;

  try {
    await setLang(lang);

    // A Biblioteca Expandida não usa os mesmos IDs dos 73 livros bíblicos.
    // Então, ao entrar nela, força o primeiro item da própria biblioteca.
    // Sem isso, algumas sessões ficam presas no livro salvo anteriormente
    // e o leitor aparenta não carregar.
    if (forceBibliotecaReset) {
      const livros = getLivros();
      if (livros.length) {
        state.livro = livros[0].id;
        state.cap = 1;
      }
      const filter = $("#livro-filter");
      if (filter) filter.value = "";
    } else {
      ensureValidCurrentReference();
    }

    savePref("lang", lang);
    renderSidebar("livros");
    await openReader();
    refreshSettings();

    const version = getBibleVersions().find(v => v.id === lang);
    toast(version?.toast || `Bíblia: ${version?.label || lang}`);
  } catch (e) {
    console.error("[Lectio] erro ao trocar tradução", e);
    toast(`Erro ao trocar tradução: ${e?.message || "verifique os dados enviados."}`, "error", 7000);
  }
}

/* ---------- CORRIGIDO: populateRefs agrega todos os versos ---------- */
function populateRefs() {
  const svs = state.selVerses;
  if (!svs.length) {
    $("#refs-empty")?.classList.remove("hidden");
    $("#refs-list").innerHTML = "";
    return;
  }

  const allRefs = [];
  const seen    = new Set();
  for (const sv of svs) {
    const refs = state.refsData[`${sv.livro}/${sv.cap}/${sv.v}`] || [];
    for (const r of refs) {
      if (!seen.has(r)) { seen.add(r); allRefs.push(r); }
    }
  }

  const el    = $("#refs-list");
  const empty = $("#refs-empty");
  if (!allRefs.length) {
    empty.classList.remove("hidden");
    el.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  el.innerHTML = allRefs.map(r => {
    const parsed = parseRef(r);
    const tag = parsed.raw || `${parsed.livroNome} ${parsed.cap}:${parsed.vIni}${parsed.vFim ? "-"+parsed.vFim : ""}`;
    const disabled = parsed.invalid ? " ref-invalid" : "";
    return `<div class="ref-item${disabled}" data-livro="${parsed.livroId}" data-cap="${parsed.cap}" data-v="${parsed.vIni}" data-v-fim="${parsed.vFim || ''}" data-invalid="${parsed.invalid ? "1" : "0"}"><span class="ref-tag">${tag}</span><span id="${parsed.domId}">…</span></div>`;
  }).join("");

  el.querySelectorAll(".ref-item").forEach(it => {
    it.addEventListener("click", () => {
      if (it.dataset.invalid === "1") {
        toast("Referência indisponível nesta tradução.", "warning");
        return;
      }
      jumpToVerseAndSelect(
        it.dataset.livro,
        parseInt(it.dataset.cap, 10),
        parseInt(it.dataset.v, 10),
        it.dataset.vFim ? parseInt(it.dataset.vFim, 10) : null
      );
    });
  });

  allRefs.forEach(async r => {
    const parsed = parseRef(r);
    const slot = parsed.domId ? document.getElementById(parsed.domId) : null;
    if (parsed.invalid) {
      if (slot) slot.textContent = "Referência indisponível nesta tradução.";
      return;
    }
    try {
      const data  = await loadCap(parsed.livroId, parsed.cap);
      const found = data.find(x => x.v === parsed.vIni);
      if (found && slot) {
        slot.textContent = found.t.slice(0, 120) + (found.t.length > 120 ? "…" : "");
      } else if (slot) {
        slot.textContent = "Versículo não encontrado.";
      }
    } catch {
      if (slot) slot.textContent = "Não foi possível carregar esta referência.";
    }
  });
}

function normalizeRefBookId(raw) {
  const base = String(raw || "")
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const aliases = {
    "1_tesalonicenses": "1_tessalonicenses",
    "2_tesalonicenses": "2_tessalonicenses",
    "1_tessalonissenses": "1_tessalonicenses",
    "2_tessalonissenses": "2_tessalonicenses",
    "cantico_dos_canticos": "canticos",
    "cantares": "canticos",
    "ecclesiastes": "eclesiastes",
    "ecclesiasticus": "eclesiastico",
    "apocalipse_de_joao": "apocalipse"
  };

  if (getLivro(base)) return base;
  if (aliases[base]) return aliases[base];

  // Alguns dados vêm com prefixo explicativo, ex.: "fineias numeros 25:10-13".
  const parts = base.split("_").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join("_");
    if (getLivro(tail)) return tail;
    if (aliases[tail]) return aliases[tail];
  }
  return aliases[base] || base;
}

function parseRef(r) {
  const raw = String(r || "").trim();
  const m = raw.match(/^([\p{L}\d_ .-]+?)\s+(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?/u);
  if (!m) {
    const domId = `rt-invalid-${normalizeRefBookId(raw || "ref") || "ref"}`;
    return { livroId: "", livroNome: raw, cap: 1, vIni: 1, vFim: null, raw, domId, invalid: true };
  }

  const id = normalizeRefBookId(m[1]);
  const livro = getLivro(id);
  const cap = parseInt(m[2], 10);
  const vIni = parseInt(m[3], 10);
  const capFim = m[4] ? parseInt(m[4], 10) : cap;
  const vFim = m[5] ? parseInt(m[5], 10) : null;
  const invalid = !livro || !Number.isFinite(cap) || !Number.isFinite(vIni) || cap < 1 || vIni < 1 || cap > (livro?.caps || 0);

  return {
    livroId: id,
    livroNome: livro?.nome || m[1].trim(),
    cap,
    vIni,
    vFim: capFim === cap ? vFim : null,
    capFim,
    raw,
    domId: `rt-${id}-${cap}-${vIni}`,
    invalid
  };
}

/* ---------- CORRIGIDO: populateCIC agrega todos os versos ---------- */
function populateCIC() {
  const svs = state.selVerses;
  if (!svs.length) {
    $("#cic-empty")?.classList.remove("hidden");
    $("#cic-list").innerHTML = "";
    return;
  }

  const allItems = [], seenNums = new Set();
  for (const sv of svs) {
    const items = state.cicData[`${sv.livro}/${sv.cap}/${sv.v}`] || [];
    for (const item of items) {
      if (!seenNums.has(item.num)) { seenNums.add(item.num); allItems.push(item); }
    }
  }

  const el    = $("#cic-list");
  const empty = $("#cic-empty");
  if (!allItems.length) { empty.classList.remove("hidden"); el.innerHTML = ""; return; }
  empty.classList.add("hidden");
  el.innerHTML = allItems.map(i =>
    `<div class="cic-item" data-num="${i.num}">
       <span class="cic-tag">CIC § ${i.num}</span>
       ${i.tema ? escape(i.tema) : '<em style="color:var(--ink-mute)">Clique para ler</em>'}
     </div>`
  ).join("");

  el.querySelectorAll(".cic-item").forEach(it => {
    it.addEventListener("click", () => showCicModal(it.dataset.num));
  });
}

function showCicModal(num) {
  let modal = document.getElementById('modal-cic-text');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-cic-text';
    modal.className = 'modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'cic-modal-title');
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-card cic-modal-card">
        <header class="modal-head">
          <h2 id="cic-modal-title"></h2>
          <button class="icon-btn modal-close" data-close aria-label="Fechar texto do Catecismo">✕</button>
        </header>
        <div id="cic-modal-body" class="cic-modal-body"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal); });
  }
  modal.querySelector('#cic-modal-title').textContent = `§ ${num}`;
  const body = modal.querySelector('#cic-modal-body');
  body.style.fontFamily = getComputedStyle(document.body).getPropertyValue('--reader-font');
  body.style.fontSize = getComputedStyle(document.documentElement).getPropertyValue('--reader-fz');
  const texto = state.cicTexto?.[num];
  body.innerHTML = texto
    ? `<p>${escape(texto)}</p>`
    : `<em style="color:var(--ink-mute)">Texto do § ${num} não disponível.</em>`;
  openModal(modal);
}

/* ---------- CORRIGIDO: populateNote usa último verso ---------- */
async function populateNote() {
  const sv = state.selVerses[state.selVerses.length - 1];
  const noteEl = $("#note-text");
  const saveBtn = $("#save-note");
  if (!sv) {
    if (noteEl) {
      noteEl.value = "";
      noteEl.disabled = true;
      noteEl.placeholder = "Selecione um versículo no leitor primeiro…";
    }
    if (saveBtn) saveBtn.disabled = true;
    $$(".color-dot").forEach(d => d.classList.remove("selected"));
    return;
  }
  if (noteEl) {
    noteEl.disabled = false;
    noteEl.placeholder = "Suas anotações pessoais sobre este versículo…";
  }
  if (saveBtn) saveBtn.disabled = false;
  const key   = `${sv.livro}/${sv.cap}/${sv.v}`;
  const notes = await loadNotes();
  if (noteEl) noteEl.value = notes[key] || "";
  const hls   = await loadHighlights();
  const color = hls[key] || "none";
  $$(".color-dot").forEach(d => d.classList.toggle("selected", d.dataset.color === color));
}

/* ---------- CORRIGIDO: saveCurrentNote usa último verso ---------- */
async function saveCurrentNote() {
  const sv = state.selVerses[state.selVerses.length - 1];
  if (!sv) return toast("Selecione um versículo", "error");
  const key = `${sv.livro}/${sv.cap}/${sv.v}`;
  await setNote(key, $("#note-text").value);
  toast("Nota salva");
  const el = document.querySelector(
    `.verse[data-livro="${sv.livro}"][data-cap="${sv.cap}"][data-v="${sv.v}"]`
  );
  if (el) {
    if ($("#note-text").value.trim()) el.classList.add("has-note");
    else el.classList.remove("has-note");
  }
}

/* ---------- CORRIGIDO: applyColor aplica em todos os versos ---------- */
async function applyColor(color) {
  if (!state.selVerses.length) return toast("Selecione um versículo", "error");

  const keys = state.selVerses.map(sv => `${sv.livro}/${sv.cap}/${sv.v}`);
  await setHighlights(keys, color);

  for (const sv of state.selVerses) {
    const el = document.querySelector(
      `.verse[data-livro="${sv.livro}"][data-cap="${sv.cap}"][data-v="${sv.v}"]`
    );
    if (el) {
      el.classList.remove("hl-gold","hl-rose","hl-sage","hl-azure","hl-violet");
      if (color !== "none") el.classList.add(`hl-${color}`);
    }
  }

  $$(".color-dot").forEach(d => d.classList.toggle("selected", d.dataset.color === color));
  if (document.querySelector(".side-tab.active")?.dataset.tab === "favoritos") {
    renderSidebar("favoritos");
  }
  toast(color === "none" ? "Marcação removida" : "Versículo marcado");
}

/* ---------- Comparação PT / MS / EN ---------- */
async function openCompare() {
  if (isBibliotecaExpandidaActive()) {
    toast("A Biblioteca Bíblica Expandida é apenas para leitura/estudo e não entra na comparação.", "error");
    return;
  }
  let modal = $("#modal-compare");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modal-compare";
    modal.className = "modal hidden";
    modal.innerHTML = `
      <div class="modal-card modal-card-wide compare-modal">
        <header class="modal-head">
          <h2 id="compare-title">Comparar traduções</h2>
          <button class="icon-btn modal-close" data-close>✕</button>
        </header>
        <div id="compare-body" class="compare-body"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) closeModal(modal); });
    modal.querySelector("[data-close]").addEventListener("click", () => closeModal(modal));
  }

  openModal(modal);
  const title = $("#compare-title");
  const body = $("#compare-body");
  const livro = getLivro(state.livro);
  const versions = getComparableBibleVersions();
  title.textContent = `${livro?.nome || state.livro} ${state.cap} — ${versions.length} traduções`;
  body.innerHTML = "Carregando comparação…";

  try {
    const loaded = await Promise.all(versions.map(async version => {
      try {
        const data = await loadCapFromVersion(version.id, state.livro, state.cap, { allowFallback: false });
        return { version, data, error: null };
      } catch (e) {
        console.warn("[compare] tradução indisponível", version.id, e);
        return { version, data: null, error: e };
      }
    }));

    const principal = loaded.find(x => x.version.primary && x.data)?.data || loaded.find(x => x.data)?.data;
    if (!principal) throw new Error("Nenhuma tradução disponível para este capítulo.");

    const indisponiveis = loaded.filter(x => !x.data).map(x => x.version.label);
    const aviso = indisponiveis.length
      ? `<p class="compare-warning">⚠ Tradução não encontrada/localmente indisponível: <strong>${indisponiveis.map(escape).join(", ")}</strong>. Rode <code>python scripts/importar_biblias_v33.py</code> para gerar as pastas completas offline.</p>`
      : "";

    const maps = loaded.map(item => ({
      ...item,
      byV: new Map((item.data || []).map(x => [Number(x.v), x]))
    }));

    const allVerses = [...new Set(maps.flatMap(m => [...m.byV.keys()]))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const cssVars = `--compare-cols:${versions.length};`;

    const cell = (x, naoCarregou) => {
      if (x) return `<span class="vn">${x.v}</span> ${escape(x.t)}`;
      if (naoCarregou) return '<span class="compare-missing">tradução não disponível</span>';
      return '<em style="color:var(--ink-mute)">—</em>';
    };

    body.innerHTML = `
      ${aviso}
      <div class="compare-grid compare-head" style="${cssVars}">
        ${maps.map(m => `<div title="${escape(m.version.label)}">${escape(m.version.shortLabel || m.version.label)}</div>`).join("")}
      </div>
      ${allVerses.map(vNum => `
        <div class="compare-grid compare-row" style="${cssVars}">
          ${maps.map(m => `<div>${cell(m.byV.get(vNum), !m.data)}</div>`).join("")}
        </div>
      `).join("")}
    `;
  } catch (e) {
    body.innerHTML = `<p style="color:var(--danger)">Não foi possível comparar este capítulo: ${escape(e.message)}</p>`;
  }
}

/* ---------- Modal Ref ---------- */
function openRefModal() {
  const m = $("#modal-ref");
  openModal(m);
  const livrosCol = $("#ref-livros-list");
  livrosCol.innerHTML = getLivros().map(l =>
    `<button class="book-item ${l.id === state.livro ? "active" : ""}" data-id="${l.id}">${l.nome}</button>`
  ).join("");
  livrosCol.querySelectorAll(".book-item").forEach(b => b.addEventListener("click", () => {
    livrosCol.querySelectorAll(".book-item").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    renderCapsGrid(b.dataset.id);
  }));
  renderCapsGrid(state.livro);
}

function renderCapsGrid(livroId) {
  const l = getLivro(livroId);
  $("#ref-caps-grid").innerHTML = Array.from({ length: l.caps }, (_, i) =>
    `<button class="cap-cell" data-cap="${i+1}">${i+1}</button>`
  ).join("");
  $("#ref-caps-grid").querySelectorAll(".cap-cell").forEach(c => c.addEventListener("click", () => {
    state.livro = livroId;
    state.cap   = parseInt(c.dataset.cap);
    closeModal($("#modal-ref"));
    openReader();
  }));
}

/* ---------- Busca ---------- */
async function runSearch() {
  const q = $("#search-input").value.trim();
  if (q.length < 2) {
    $("#search-results").innerHTML = "";
    $("#search-meta").textContent  = "";
    return;
  }
  $("#search-meta").textContent = "Indexando…";
  const res = await search(q, pct => $("#search-meta").textContent = `Indexando ${pct}%…`);
  $("#search-meta").textContent = `${res.length} ocorrência(s)`;
  $("#search-results").innerHTML = res.slice(0, 200).map(h =>
    `<div class="search-hit" data-livro="${h.livroId}" data-cap="${h.cap}" data-v="${h.v}">
       <span class="search-ref">${h.livroNome} ${h.cap}:${h.v}</span>
       <span class="search-text">${highlightMatch(h.t, q)}</span>
     </div>`
  ).join("");
  $("#search-results").querySelectorAll(".search-hit").forEach(it => {
    it.addEventListener("click", () => {
      closeModal($("#modal-search"));
      jumpToVerseAndSelect(it.dataset.livro, parseInt(it.dataset.cap, 10), parseInt(it.dataset.v, 10));
    });
  });
}

/* ---------- CORRIGIDO: runPrompt usa todos os versos ---------- */
async function runPrompt(type) {
  if (!state.selVerses.length) return toast("Selecione um versículo primeiro", "error");
  if (!state.apiKey) return toast("Configure sua chave Gemini em Configurações", "error");

  const { ref, txt } = getRefTxt();

  let cicBlock = "";
  if (type === "catecismo") {
    const seen = new Set();
    for (const sv of state.selVerses) {
      const key = `${sv.livro}/${sv.cap}/${sv.v}`;
      const itens = state.cicData[key] || [];
      for (const item of itens) if (item?.num) seen.add(item.num);
    }
    if (seen.size) cicBlock = await buildCicBlock([...seen]);
  }

  const prompt = buildPrompt(type, ref, txt, cicBlock);
  await streamToOutput(prompt, true, {
    type: "IA",
    subtype: AI_PROMPT_LABELS[type] || type,
    title: `${AI_PROMPT_LABELS[type] || "Estudo IA"} — ${ref}`,
    ref,
    passage: txt
  });
}


/* ---------- CORRIGIDO: runFreeQuestion usa todos os versos ---------- */
async function runFreeQuestion(q) {
  if (!state.apiKey) return toast("Configure sua chave Gemini", "error");
  let ctx = "";
  if (state.selVerses.length) {
    const svs       = state.selVerses;
    const first     = svs[0];
    const livroNome = getLivro(first.livro).nome;
    if (svs.length === 1) {
      ctx = `Contexto: ${livroNome} ${first.cap}:${first.v} — "${first.t}"\n\n`;
    } else {
      const verses = svs.map(sv => `v.${sv.v}: "${sv.t}"`).join("\n");
      ctx = `Contexto: ${livroNome} ${first.cap}:\n${verses}\n\n`;
    }
  }
  let ref = "Sem referência selecionada";
  let passage = "";
  if (state.selVerses.length) {
    try {
      const current = getRefTxt();
      ref = current.ref;
      passage = current.txt;
    } catch {}
  }
  await streamToOutput(ctx + "Pergunta: " + q, true, {
    type: "Pergunta livre",
    subtype: q.slice(0, 80),
    title: `Pergunta livre — ${ref}`,
    ref,
    passage
  });
}

async function streamToOutput(userPrompt, clearFirst = true, meta = {}) {
  const out = $("#ai-output");
  if (clearFirst) out.innerHTML = "";

  const bubble = document.createElement("div");
  bubble.className = "ai-bubble ai-typing";
  bubble.innerHTML = `<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
  out.appendChild(bubble);
  out.scrollTop = out.scrollHeight;

  // tenta com fallback automático usando a lista real de modelos disponíveis
  let text = null;
  let lastErr = null;
  const queue = await getModelQueue();
  const maxAttempts = queue.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const modelo = currentModel(queue);
    try {
      state.activeModel = modelo;
      updateGemStatus();
      text = await callGemini({
        apiKey:     state.apiKey,
        model:      modelo,
        userPrompt,
        onChunk: (partial) => {
          bubble.classList.remove("ai-typing");
          bubble.innerHTML = mdToHtml(partial);
        }
      });
      if (_modelIdx > 0) toast(`✅ Respondido com ${modelo}`);
      break;
    } catch (e) {
      lastErr = e;
      if (isRetryableGeminiError(e) && attempt < maxAttempts - 1) {
        bumpModel(queue);
        const proximo = currentModel(queue);
        toast(`⚡ ${modelo} indisponível/sem cota → tentando ${proximo}…`, "ok", 3600);
        bubble.innerHTML = `<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
        bubble.className = "ai-bubble ai-typing";
        continue;
      }
      break;
    }
  }

  if (text) {
    bubble.classList.remove("ai-typing");
    bubble.innerHTML = mdToHtml(text);
    bubble.title = "Clique para copiar";
    bubble.style.cursor = "pointer";
    bubble.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("📋 Copiado!");
      } catch {
        toast("Selecione e copie manualmente", "error");
      }
    });
    out.appendChild(createAIResultActions({ text, html: bubble.innerHTML, meta }));
  } else {
    bubble.classList.remove("ai-typing");
    const todosEsgotados = isRetryableGeminiError(lastErr);
    bubble.textContent = todosEsgotados
      ? "⚠️ Nenhum modelo disponível respondeu agora. Aguarde alguns minutos ou confira a chave/cota do Gemini."
      : "Erro: " + (lastErr?.message || "desconhecido");
    bubble.style.color = "var(--danger)";
  }

  out.scrollTop = out.scrollHeight;
}

function updateGemStatus() {
  const el = $("#gem-status") || $("#gemini-status");
  if (!el) return;
  if (state.apiKey) {
    const usingFallback = state.activeModel && state.activeModel !== state.model;
    el.textContent = usingFallback
      ? `🟢 Ativo: ${state.activeModel}  (preferido: ${state.model})`
      : `🟢 Chave ativa — ${state.model} · rotação automática ligada`;
    el.className = "gem-status ok";
  } else if (state.encBlob) {
    el.textContent = "🔒 Chave cifrada salva — bloqueada";
    el.className   = "gem-status locked";
  } else {
    el.textContent = "Nenhuma chave cadastrada";
    el.className   = "gem-status none";
  }
  $("#ai-key-hint")?.classList.toggle("hidden", !!state.apiKey);
}

/* ---------- Settings ---------- */
function refreshSettings() {
  updateGemStatus();
  $("#gemini-model").value = state.model;
  $$(".theme-pick").forEach(b => b.classList.toggle("active", b.dataset.theme === document.body.dataset.theme));
  $$(".bg-pick").forEach(b => b.classList.toggle("active", b.dataset.bg === (document.body.dataset.readerBg || "plain")));
  const prefs = loadPrefs();
  if (prefs.fontSize) $("#font-size").value = prefs.fontSize;
  const readerFont = prefs.readerFont || document.body.dataset.readerFont || "garamond";
  if ($("#reader-font")) $("#reader-font").value = readerFont;
  const lang = getLang();
  $$(".lang-pick").forEach(b => b.classList.toggle("active", b.dataset.lang === lang));
}

async function onSaveKey() {
  const key  = $("#gemini-input").value.trim();
  state.model = $("#gemini-model").value || state.model || "gemini-2.5-flash";
  resetModelRotation();
  if (!key) return toast("Cole a chave Gemini", "error");
  if (!state.master) {
    const p = prompt("Defina sua senha-mestra (mín. 8 caracteres).");
    if (!p || p.length < 8) return toast("Senha curta", "error");
    state.master = p;
  }
  try {
    const blob       = await encryptString(key, state.master);
    await saveEncryptedKey(blob, state.model);
    state.encBlob = blob;
    state.apiKey  = key;
    saveSessionGeminiKey(key, state.model);
    $("#gemini-input").value = "";
    toast("Chave cifrada e salva");
    updateGemStatus();
  } catch (e) {
    toast("Erro ao salvar: " + e.message, "error");
  }
}

/* ---------- Lectio Divina — gera 4 passos em fila para não estourar cota ---------- */
let lectioStep = 1;
let lectioRunId = 0;
const lectioCache = {};
const lectioRawCache = {};
const lectioPending = {};

function openLectio() {
  if (!state.selVerses.length) return toast("Selecione um versículo", "error");
  if (!state.apiKey)           return toast("Configure sua chave Gemini", "error");

  lectioRunId++;
  for (const k in lectioCache) delete lectioCache[k];
  for (const k in lectioRawCache) delete lectioRawCache[k];
  for (const k in lectioPending) delete lectioPending[k];

  openModal("#modal-lectio");
  switchLectio(1);

  const runId = lectioRunId;
  (async () => {
    for (const step of [1, 2, 3, 4]) {
      if (runId !== lectioRunId) return;
      await ensureLectioStep(step, runId);
    }
  })();
}

function ensureLectioStep(step, runId = lectioRunId) {
  if (lectioCache[step]) return Promise.resolve(lectioCache[step]);
  if (lectioPending[step]) return lectioPending[step];

  lectioPending[step] = gerarPasso(step, runId)
    .finally(() => { delete lectioPending[step]; });

  return lectioPending[step];
}

function getRefTxt() {
  const svs    = state.selVerses;
  const first  = svs[0];
  const nome   = getLivro(first.livro).nome;
  if (svs.length === 1) {
    return { ref: `${nome} ${first.cap}:${first.v}`, txt: first.t };
  }
  const sorted = [...svs].sort((a, b) => a.v - b.v);
  return {
    ref: `${nome} ${first.cap}:${sorted[0].v}–${sorted[sorted.length-1].v}`,
    txt: sorted.map(sv => `(${sv.v}) ${sv.t}`).join(" ")
  };
}

async function gerarPasso(step, runId = lectioRunId) {
  const { ref, txt } = getRefTxt();
  const queue = await getModelQueue();
  const maxAttempts  = queue.length;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const modelo = currentModel(queue);
    try {
      state.activeModel = modelo;
      updateGemStatus();
      await callGemini({
        apiKey: state.apiKey, model: modelo,
        userPrompt: buildLectioPrompt(step, ref, txt),
        onChunk: (full) => {
          if (runId !== lectioRunId) return;
          lectioRawCache[step] = full;
          lectioCache[step] = mdToHtml(full);
          if (lectioStep === step) {
            const el = $("#lectio-ai");
            if (el) { el.innerHTML = lectioCache[step]; el.className = ""; }
          }
        }
      });
      if (runId === lectioRunId) return;

    } catch (e) {
      lastErr = e;
      if (isRetryableGeminiError(e) && attempt < maxAttempts - 1) {
        bumpModel(queue);
        toast(`⚡ Passo ${step}: tentando ${currentModel(queue)}…`, "ok", 3000);
        continue;
      }
      break;
    }
  }

  // Todos os modelos falharam
  const msg = `<em style="color:var(--danger)">Erro: ${escape(lastErr?.message || "desconhecido")}</em>`;
  if (runId !== lectioRunId) return;
  lectioCache[step] = msg;
  if (lectioStep === step) {
    const el = $("#lectio-ai");
    if (el) { el.innerHTML = msg; el.className = ""; }
  }
}

async function switchLectio(step) {
  lectioStep = step;
  $$(".lectio-step").forEach(s => s.classList.toggle("active", parseInt(s.dataset.step) === step));

  const { ref, txt } = getRefTxt();

  const titles = LECTIO_STEP_TITLES;
  const inst = {
    1:"Leia o texto devagar, três vezes. Note as palavras que se destacam.",
    2:"Rumine: o que o texto diz a você? Que ressoa, que desafia?",
    3:"Responda a Deus a partir do que ouviu. Em suas próprias palavras.",
    4:"Permaneça em silêncio. Deixe Deus falar sem palavras."
  };

  const lectioBody = $("#lectio-body");
  if (!lectioBody) return;

  lectioBody.innerHTML = `
    <h3>${titles[step]}</h3>
    <p class="step-instructions">${inst[step]}</p>
    <div class="lectio-passage"><strong>${ref}</strong><br>${escape(txt)}</div>
    <div id="lectio-ai" class="${lectioCache[step] ? '' : 'ai-typing'}">
      ${lectioCache[step] || 'Gerando guia…'}
    </div>
    <div class="lectio-save-actions ${lectioCache[step] ? '' : 'hidden'}">
      <button id="btn-save-lectio-step" class="mini-action-btn" type="button">💾 Salvar etapa</button>
      <button id="btn-save-lectio-all" class="mini-action-btn" type="button">💾 Salvar Lectio completa</button>
    </div>
  `;

  $("#btn-save-lectio-step")?.addEventListener("click", () => saveLectioStep(step, ref, txt));
  $("#btn-save-lectio-all")?.addEventListener("click", () => saveLectioComplete(ref, txt));

  // Garante que, ao trocar Lectio/Meditatio/Oratio/Contemplatio,
  // o conteúdo não mantenha a rolagem antiga e os botões continuem acessíveis.
  lectioBody.scrollTop = 0;

  // Se o usuário clicar antes da fila chegar neste passo, inicia sem duplicar.
  if (!lectioCache[step]) {
    ensureLectioStep(step);
  }
}


function saveLectioStep(step, ref, txt) {
  if (!lectioCache[step]) return toast("Aguarde a etapa terminar antes de salvar", "error");
  saveStudyRecord({
    type: "Lectio Divina",
    subtype: LECTIO_STEP_TITLES[step] || `Passo ${step}`,
    title: `${LECTIO_STEP_TITLES[step] || "Lectio"} — ${ref}`,
    ref,
    passage: txt,
    contentHtml: lectioCache[step],
    contentText: lectioRawCache[step] || stripHtml(lectioCache[step]),
    model: state.activeModel || state.model || ""
  });
}

function saveLectioComplete(ref, txt) {
  const steps = [1, 2, 3, 4].filter(step => lectioCache[step]);
  if (!steps.length) return toast("Aguarde a Lectio gerar antes de salvar", "error");
  const html = steps.map(step => `
    <h3>${escape(LECTIO_STEP_TITLES[step] || `Passo ${step}`)}</h3>
    ${lectioCache[step]}
  `).join("\n");
  const text = steps.map(step => `${LECTIO_STEP_TITLES[step] || `Passo ${step}`}\n${lectioRawCache[step] || stripHtml(lectioCache[step])}`).join("\n\n");
  saveStudyRecord({
    type: "Lectio Divina",
    subtype: steps.length === 4 ? "Completa" : `Parcial (${steps.length}/4)`,
    title: `Lectio Divina ${steps.length === 4 ? "completa" : "parcial"} — ${ref}`,
    ref,
    passage: txt,
    contentHtml: html,
    contentText: text,
    model: state.activeModel || state.model || ""
  });
}

/* ---------- Liturgia do dia ---------- */
async function openLiturgia() {
  openModal("#modal-liturgia");
  const body = $("#liturgia-body");
  body.innerHTML = "Carregando…";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const r = await fetch("https://liturgia.up.railway.app/v2/", {
      signal: controller.signal,
      cache: "no-store"
    }).finally(() => clearTimeout(timer));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const asList = value => Array.isArray(value) ? value : (value ? [value] : []);
    const renderLeitura = (titulo, item = {}, extraRef = "") => `
      <section class="lit-section">
        <h3>${escape(titulo)}</h3>
        <p class="lit-ref">${escape([item.referencia || "", extraRef].filter(Boolean).join(" — "))}</p>
        <p class="lit-text">${escape(item.texto || "")}</p>
      </section>
    `;
    body.innerHTML = `
      <article class="liturgia-content">
        <header class="lit-hero">
          <p class="lit-kicker">Liturgia do dia</p>
          <h3>${escape(j.liturgia || "Liturgia")}</h3>
          <p class="lit-ref lit-meta">${escape([j.data || "", j.cor || ""].filter(Boolean).join(" — "))}</p>
        </header>
        ${asList(j.leituras?.primeiraLeitura).map(l => renderLeitura("1ª Leitura", l)).join("")}
        ${asList(j.leituras?.salmo).map(l => renderLeitura("Salmo", l, l.refrao || "")).join("")}
        ${asList(j.leituras?.segundaLeitura).map(l => renderLeitura("2ª Leitura", l)).join("")}
        ${asList(j.leituras?.evangelho).map(l => renderLeitura("Evangelho", l)).join("")}
      </article>
    `;
  } catch {
    body.innerHTML = `<p style="color:var(--ink-mute)">API de liturgia indisponível. Acesse em <a href="https://www.cnbb.org.br/liturgia-diaria/" target="_blank" style="color:var(--gold)">cnbb.org.br/liturgia-diaria</a>.</p>`;
  }
}

/* ---------- Util ---------- */
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* =========================================================
   ✨ PATCH v1 — UX MOBILE: painéis, foco, ESC, swipe
   ========================================================= */
function togglePanel(which, forceOpen) {
  const isMobile = window.innerWidth <= 1100;
  const sidebar  = $("#sidebar");
  const study    = $("#study");
  const scrim    = $("#panel-scrim");
  if (!sidebar || !study) return;

  const target = which === "sidebar" ? sidebar : study;
  const other  = which === "sidebar" ? study   : sidebar;

  const willOpen = (forceOpen === true)
    ? true
    : (forceOpen === false ? false : !target.classList.contains("open"));

  if (willOpen) {
    target.classList.add("open");
    if (isMobile) other.classList.remove("open"); // só um por vez no mobile
  } else {
    target.classList.remove("open");
  }

  if (scrim && isMobile) {
    const anyOpen = sidebar.classList.contains("open") || study.classList.contains("open");
    scrim.classList.toggle("visible", anyOpen);
    scrim.classList.toggle("hidden", !anyOpen);
  }
  updateSidePanelChromeState();
}

function closePanels() {
  $("#sidebar")?.classList.remove("open");
  $("#study")?.classList.remove("open");
  const scrim = $("#panel-scrim");
  if (scrim) { scrim.classList.remove("visible"); scrim.classList.add("hidden"); }
  updateSidePanelChromeState();
}

function toggleFocus(forceOn) {
  const body = document.body;
  const layout = $("#layout");
  const exit = $("#btn-focus-exit");
  const btnFoco = $("#btn-fullread");

  // BUG FIX: se a tela de login está aberta, não permite entrar em Foco
  // (resultava em tela com login bloqueado por foco-mode no celular).
  const authVisible = !$("#auth-overlay")?.classList.contains("hidden");
  if (forceOn !== false && authVisible) {
    toast("Faça login ou continue sem login antes de usar o modo foco", "error", 3500);
    return;
  }

  const willOn = (typeof forceOn === "boolean")
    ? forceOn
    : !body.classList.contains("focus-mode");

  body.classList.toggle("focus-mode", willOn);
  // mantém compatibilidade com a classe antiga do desktop
  layout?.classList.toggle("focus", willOn);
  if (exit) {
    exit.classList.toggle("hidden", !willOn);
  }
  // Indica estado ativo no botão da topbar
  btnFoco?.classList.toggle("active", willOn);
  syncChromeHeight();
  // ao entrar em foco, fecha quaisquer painéis abertos (mobile)
  if (willOn) {
    closePanels();
    // PATCH V22: garante que o leitor continue visível no mobile e que o texto apareça.
    setTimeout(() => {
      const reader = $("#reader");
      const text = $("#reader-text");
      if (reader) reader.scrollTop = 0;
      if (text && !text.textContent.trim()) openReader().catch(e => showFatalError("focus-openReader", e));
    }, 60);
  }
}

// ESC fecha modais > painéis > foco (em ordem)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const openModal = document.querySelector(".modal:not(.hidden)");
  if (openModal) { closeModal(openModal); return; }
  if ($("#sidebar")?.classList.contains("open") || $("#study")?.classList.contains("open")) {
    closePanels(); return;
  }
  if (document.body.classList.contains("focus-mode")) {
    toggleFocus(false); return;
  }
});

// Swipe lateral pra fechar painéis no mobile
(function enableSwipeClose() {
  let startX = 0, startY = 0, startedOn = null;
  const TH = 60; // px de deslocamento mínimo
  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY;
    startedOn = e.target.closest("#sidebar, #study");
  };
  const onEnd = (e) => {
    if (!startedOn) return;
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) { startedOn = null; return; }
    if (startedOn.id === "sidebar" && dx < -TH) closePanels();
    if (startedOn.id === "study"   && dx >  TH) closePanels();
    startedOn = null;
  };
  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
})();

/* ---------- Boot ---------- */
boot().catch(e => {
  showFatalError("boot", e);
  // tenta ao menos ativar UI básica pra user não ficar travado
  try { bindUI(); } catch {}
});
