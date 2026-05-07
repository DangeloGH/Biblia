import { escapeHtml, normalizeText } from "./util.js";
import { downloadPrayerShareImage } from "./share-image.js";
import { renderRosarioGuide, renderTercoGuide, isGuidedTercoItem, getRosarioTodaySummary, exitRosarioFocusMode, enterRosarioFocusMode } from "./rosario.js?v=lectio-v67-primeira-experiencia";

const DATA_BASE = "./dados-oracoes/";
const FAVORITES_KEY = "lectio.prayers.favorites.v1";
const HISTORY_KEY = "lectio.prayers.history.v1";
const STATS_KEY = "lectio.prayers.stats.v1";
const NOVENA_STATE_KEY = "lectio.prayers.novenas.v1";
const MAX_HISTORY = 30;

let ctx = {
  openModal: null,
  toast: null
};
let bound = false;
let indexData = null;
const packs = new Map();
const itemIndex = new Map();
let currentPrayerId = null;
let activeView = { type: "inicio" };
let focusMode = false;

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const esc = (v) => escapeHtml(v == null ? "" : String(v));

function toast(msg, kind = "ok") {
  if (typeof ctx.toast === "function") ctx.toast(msg, kind);
}

function exitDevocionarioFocusModes() {
  focusMode = false;
  $("#oracoes-body")?.classList.remove("oracao-focus-mode");
  exitRosarioFocusMode();
}

function scrollDevocionarioTop(behavior = "auto") {
  requestAnimationFrame(() => {
    const body = $("#oracoes-body");
    const content = $("#oracoes-content");
    body?.scrollTo?.({ top: 0, behavior });
    content?.scrollTo?.({ top: 0, behavior });
  });
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function getFavorites() {
  const arr = readJson(FAVORITES_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function setFavorites(items) {
  writeJson(FAVORITES_KEY, Array.from(new Set(items)).slice(0, 200));
}

function isFavorite(id) {
  return getFavorites().includes(id);
}

function toggleFavorite(id) {
  const favs = getFavorites();
  const next = favs.includes(id) ? favs.filter(x => x !== id) : [id, ...favs];
  setFavorites(next);
  toast(next.includes(id) ? "Oração adicionada aos favoritos" : "Oração removida dos favoritos");
  if (currentPrayerId === id) return renderPrayer(id, { record: false });
  if (activeView.type === "categoria") return renderCategory(activeView.id);
  if (activeView.type === "favoritos") return renderFavorites();
  if (activeView.type === "pesquisa") return renderSearch($("#oracoes-search")?.value || "");
  return renderHome();
}

function getHistory() {
  const arr = readJson(HISTORY_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function recordPrayerUse(id) {
  const now = Date.now();
  const history = getHistory().filter(x => x?.id !== id);
  history.unshift({ id, ts: now });
  writeJson(HISTORY_KEY, history.slice(0, MAX_HISTORY));

  const stats = readJson(STATS_KEY, { total: 0, byId: {} });
  stats.total = Number(stats.total || 0) + 1;
  stats.byId = stats.byId || {};
  stats.byId[id] = Number(stats.byId[id] || 0) + 1;
  stats.lastId = id;
  stats.lastTs = now;
  writeJson(STATS_KEY, stats);
}

function getStats() {
  const stats = readJson(STATS_KEY, { total: 0, byId: {} });
  return stats && typeof stats === "object" ? stats : { total: 0, byId: {} };
}

function getNovenaState() {
  const data = readJson(NOVENA_STATE_KEY, {});
  return data && typeof data === "object" ? data : {};
}

function setNovenaState(state) {
  writeJson(NOVENA_STATE_KEY, state || {});
}

function getNovenaProgress(id) {
  const state = getNovenaState();
  const progress = state[id] || null;
  if (!progress) return { started: false, currentDay: 1, completedDays: [], completed: false };
  return {
    started: true,
    currentDay: Math.max(1, Math.min(9, Number(progress.currentDay || 1))),
    completedDays: Array.isArray(progress.completedDays) ? progress.completedDays : [],
    completed: !!progress.completed,
    startedAt: progress.startedAt || null,
    lastAt: progress.lastAt || null
  };
}

function updateNovenaProgress(id, updater) {
  const state = getNovenaState();
  const current = getNovenaProgress(id);
  const next = updater({ ...current, completedDays: [...current.completedDays] }) || current;
  state[id] = { ...next, started: true, lastAt: Date.now(), startedAt: next.startedAt || current.startedAt || Date.now() };
  setNovenaState(state);
  return state[id];
}

function findActiveNovenaId() {
  const state = getNovenaState();
  const active = Object.entries(state)
    .filter(([, v]) => v && !v.completed)
    .sort((a, b) => Number(b[1].lastAt || b[1].startedAt || 0) - Number(a[1].lastAt || a[1].startedAt || 0));
  return active[0]?.[0] || null;
}


function humanDate(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " · " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadIndex() {
  if (indexData) return indexData;
  indexData = await fetchJson(`${DATA_BASE}index.json`);
  return indexData;
}

async function loadPack(packId) {
  await loadIndex();
  if (packs.has(packId)) return packs.get(packId);
  const packMeta = indexData.packs.find(p => p.id === packId);
  if (!packMeta) throw new Error(`Categoria não encontrada: ${packId}`);
  const pack = await fetchJson(`${DATA_BASE}${packMeta.file}`);
  packs.set(packId, pack);
  (pack.items || []).forEach(item => itemIndex.set(item.id, { ...item, packId }));
  return pack;
}

async function loadAllPacks() {
  await loadIndex();
  await Promise.all(indexData.packs.map(p => loadPack(p.id)));
  return Array.from(itemIndex.values());
}

async function getPrayer(id) {
  if (itemIndex.has(id)) return itemIndex.get(id);
  await loadIndex();
  for (const p of indexData.packs) {
    await loadPack(p.id);
    if (itemIndex.has(id)) return itemIndex.get(id);
  }
  return null;
}

function getMomentKey() {
  const h = new Date().getHours();
  if (h < 11) return "manha";
  if (h < 14) return "meio_dia";
  if (h < 18) return "tarde";
  return "noite";
}

function momentLabel(key = getMomentKey()) {
  return {
    manha: "Para começar o dia",
    meio_dia: "Para rezar agora",
    tarde: "Para esta tarde",
    noite: "Para encerrar o dia"
  }[key] || "Para rezar agora";
}

function iconForPack(packId) {
  const meta = indexData?.packs?.find(p => p.id === packId);
  return meta?.icon || "✠";
}

function packTitle(packId) {
  const meta = indexData?.packs?.find(p => p.id === packId);
  return meta?.title || packId;
}

function curatorialBlock(blockId) {
  return indexData?.curatorial_blocks?.find(b => b.id === blockId) || null;
}

function curatorialCard(block) {
  return `
    <button class="oracoes-curadoria-card" type="button" data-oracao-curadoria="${esc(block.id)}" aria-label="Abrir bloco ${esc(block.title)}">
      <span class="oracoes-curadoria-icon">${esc(block.icon || "✠")}</span>
      <small>${esc(block.kicker || "Curadoria")}</small>
      <strong>${esc(block.title)}</strong>
      <em>${esc(block.description || "Seleção organizada de orações.")}</em>
      <span class="oracoes-curadoria-cta">Abrir caminho de oração</span>
    </button>`;
}

function shortText(item, max = 155) {
  const base = (item?.quando_rezar || item?.explicacao || item?.texto || "").replace(/\s+/g, " ").trim();
  return base.length > max ? base.slice(0, max - 1).trim() + "…" : base;
}

const DURACAO_LABELS = {
  breve: "Breve",
  media: "Média",
  longa: "Longa",
  guiada: "Guiada",
  novena: "9 dias"
};

function durationLabel(item) {
  return DURACAO_LABELS[item?.duracao] || "Oração";
}

function sourceLabel(item) {
  const selo = item?.curadoria?.selo;
  if (selo) return selo;
  if (item?.fonte_tipo === "lectio") return "Texto Lectio";
  if (item?.fonte_tipo === "tradicional") return "Tradicional";
  return item?.fonte_nome || "Católica";
}

function typeLabel(item) {
  if (item?.tipo === "novena") return "Novena";
  if (item?.tipo === "guia") return item?.categoria === "rosario" ? "Terço/Rosário" : "Guia";
  if (item?.categoria === "ladainhas") return "Ladainha";
  return "Oração";
}

function metaPills(item, limit = 3) {
  const pills = [typeLabel(item), durationLabel(item), sourceLabel(item)]
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, limit);
  return pills.length ? `<div class="oracao-meta-pills">${pills.map(p => `<span>${esc(p)}</span>`).join("")}</div>` : "";
}

function quickFilterCard(filter) {
  return `
    <button class="oracoes-filter-chip" type="button" data-oracao-quick-search="${esc(filter.query || filter.label || "")}" aria-label="Buscar ${esc(filter.label)}">
      <strong>${esc(filter.label)}</strong>
      <small>${esc(filter.description || "")}</small>
    </button>`;
}

function prayerCard(item, opts = {}) {
  if (!item) return "";
  const fav = isFavorite(item.id) ? "true" : "false";
  const badge = opts.badge || packTitle(item.packId || item.categoria);
  return `
    <article class="oracao-card" data-prayer-id="${esc(item.id)}" tabindex="0" role="button" aria-label="Abrir ${esc(item.titulo)}">
      <div class="oracao-card-top">
        <span class="oracao-card-icon">${esc(iconForPack(item.packId || item.categoria))}</span>
        <span class="oracao-card-badge">${esc(badge)}</span>
        <button class="oracao-fav-mini" type="button" data-oracao-action="favorite" data-prayer-id="${esc(item.id)}" aria-label="Favoritar ${esc(item.titulo)}" aria-pressed="${fav}">${fav === "true" ? "★" : "☆"}</button>
      </div>
      <h4>${esc(item.titulo)}</h4>
      <p>${esc(shortText(item))}</p>
      ${metaPills(item)}
      <div class="oracao-tags">${(item.tags || []).slice(0, 3).map(t => `<span>${esc(t)}</span>`).join("")}</div>
    </article>`;
}

async function renderTabs(active = "inicio") {
  await loadIndex();
  const tabs = $("#oracoes-tabs");
  if (!tabs) return;
  tabs.innerHTML = `
    <button class="oracoes-tab ${active === "inicio" ? "active" : ""}" data-oracao-tab="inicio">Início</button>
    ${indexData.packs.map(p => `
      <button class="oracoes-tab ${active === p.id ? "active" : ""}" data-oracao-tab="${esc(p.id)}">
        <span>${esc(p.icon)}</span> ${esc(p.title)}
      </button>
    `).join("")}
    <button class="oracoes-tab ${active === "favoritos" ? "active" : ""}" data-oracao-tab="favoritos">★ Favoritas</button>
  `;
}

async function renderNowSuggestion() {
  const box = $("#oracoes-now");
  if (!box) return;
  await loadIndex();
  const key = getMomentKey();
  const ids = indexData.suggestions?.[key] || indexData.featured || [];
  const prayers = (await Promise.all(ids.slice(0, 3).map(getPrayer))).filter(Boolean);
  const first = prayers[0];
  box.innerHTML = first ? `
    <div class="oracoes-now-text">
      <span>${esc(momentLabel(key))}</span>
      <strong>${esc(first.titulo)}</strong>
      <small>Uma sugestão simples para começar em silêncio.</small>
    </div>
    <button class="tool-btn oracao-now-btn" type="button" data-prayer-id="${esc(first.id)}" data-oracao-action="open">Rezar agora</button>
  ` : "";
}

async function renderHome() {
  currentPrayerId = null;
  activeView = { type: "inicio" };
  exitDevocionarioFocusModes();
  await loadIndex();
  await renderTabs("inicio");
  await renderNowSuggestion();

  const content = $("#oracoes-content");
  if (!content) return;

  const featured = (await Promise.all((indexData.featured || []).map(getPrayer))).filter(Boolean);
  const favs = (await Promise.all(getFavorites().slice(0, 4).map(getPrayer))).filter(Boolean);
  const history = getHistory();
  const last = history[0] ? await getPrayer(history[0].id) : null;
  const stats = getStats();
  const rosario = await getRosarioTodaySummary().catch(() => null);
  const activeNovenaId = findActiveNovenaId();
  const activeNovena = activeNovenaId ? await getPrayer(activeNovenaId) : null;
  const activeNovenaProgress = activeNovenaId ? getNovenaProgress(activeNovenaId) : null;
  const continueItem = last || featured[0] || null;

  content.innerHTML = `
    <section class="oracoes-dashboard">
      <div class="oracoes-stat-card">
        <span class="oracoes-stat-label">Minha oração</span>
        <strong>${esc(stats.total || 0)}</strong>
        <small>orações abertas neste navegador</small>
      </div>
      <div class="oracoes-stat-card">
        <span class="oracoes-stat-label">Continuar</span>
        <strong>${last ? esc(last.titulo) : "Rezar agora"}</strong>
        <small>${last && history[0]?.ts ? esc(humanDate(history[0].ts)) : "Escolha uma oração para começar"}</small>
        ${last ? `<button class="tool-btn small oracao-dashboard-action" type="button" data-prayer-id="${esc(last.id)}" data-oracao-action="open">Continuar</button>` : ""}
      </div>
      <div class="oracoes-stat-card oracoes-rosario-stat">
        <span class="oracoes-stat-label">Rosário de hoje</span>
        <strong>${rosario ? esc(rosario.title) : "Santo Rosário"}</strong>
        <small>${rosario ? esc(rosario.days) : "Guia interativo"}</small>
        <button class="tool-btn small oracao-dashboard-action" type="button" data-oracao-action="rosario-guide">Rezar com guia</button>
      </div>
    </section>

    <section class="oracoes-start-here" aria-label="Primeiros caminhos no Devocionário">
      <div class="oracoes-section-head">
        <div>
          <p class="oracoes-kicker">O que você deseja fazer agora?</p>
          <h3>Escolha um caminho simples</h3>
        </div>
        <p>Quatro portas de entrada para não se perder.</p>
      </div>
      <div class="oracoes-start-grid">
        <button class="oracoes-start-card primary" type="button" ${continueItem ? `data-oracao-action="open" data-prayer-id="${esc(continueItem.id)}"` : `data-oracao-action="search-focus"`}>
          <span>✠</span>
          <strong>${continueItem ? "Continuar oração" : "Rezar agora"}</strong>
          <small>${continueItem ? esc(continueItem.titulo) : "Receba uma sugestão e comece em silêncio."}</small>
        </button>
        <button class="oracoes-start-card" type="button" data-oracao-action="rosario-guide">
          <span>○</span>
          <strong>Rosário guiado</strong>
          <small>Mistérios, contas e progresso salvos.</small>
        </button>
        <button class="oracoes-start-card" type="button" data-oracao-action="search-focus">
          <span>⌕</span>
          <strong>Buscar oração</strong>
          <small>Procure por santo, intenção ou momento.</small>
        </button>
        <button class="oracoes-start-card" type="button" data-oracao-action="scroll-categories">
          <span>☩</span>
          <strong>Ver categorias</strong>
          <small>Jesus, Maria, santos, anjos, novenas e mais.</small>
        </button>
      </div>
      <div class="oracoes-howto-mini">
        <strong>Como usar o Lectio:</strong>
        <span>leia a Bíblia</span>
        <span>toque em um versículo</span>
        <span>aprofunde no estudo</span>
        <span>conclua rezando</span>
      </div>
    </section>

    ${indexData.quick_filters?.length ? `
    <section class="oracoes-section oracoes-filter-section">
      <div class="oracoes-section-head">
        <h3>Encontrar com calma</h3>
        <p>Atalhos curatoriais para chegar mais rápido à oração certa.</p>
      </div>
      <div class="oracoes-filter-grid">
        ${indexData.quick_filters.map(quickFilterCard).join("")}
      </div>
    </section>` : ""}

    ${indexData.curatorial_blocks?.length ? `
    <section class="oracoes-section oracoes-curadoria-section">
      <div class="oracoes-section-head">
        <h3>Caminhos de oração</h3>
        <p>Prateleiras prontas para escolher sem se perder.</p>
      </div>
      <div class="oracoes-curadoria-grid">
        ${indexData.curatorial_blocks.slice(0, 10).map(curatorialCard).join("")}
      </div>
    </section>` : ""}

    <section class="oracoes-rosario-callout">
      <div>
        <span>○ Rosário guiado</span>
        <h3>Reze o Santo Rosário com calma</h3>
        <p>Escolha os mistérios e entre direto no modo oração, com contador de contas e progresso salvo.</p>
      </div>
      <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="rosario-guide">Rezar com guia</button>
    </section>

    ${activeNovena ? `
    <section class="oracoes-rosario-callout compact novena-active-callout">
      <div>
        <span>9 Novena ativa</span>
        <h3>${esc(activeNovena.titulo)}</h3>
        <p>Continue de onde parou: dia ${esc(activeNovenaProgress?.currentDay || 1)}/9.</p>
      </div>
      <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="open" data-prayer-id="${esc(activeNovena.id)}">Continuar novena</button>
    </section>` : ``}

    <section class="oracoes-section" id="oracoes-categorias-section">
      <div class="oracoes-section-head">
        <h3>Categorias</h3>
        <p>Também dá para navegar por tipo de devoção.</p>
      </div>
      <div class="oracoes-category-grid">
        ${indexData.packs.map(p => `
          <button class="oracoes-category-card" type="button" data-oracao-tab="${esc(p.id)}">
            <span>${esc(p.icon)}</span>
            <strong>${esc(p.title)}</strong>
            <small>${esc(p.description || "")}</small>
          </button>
        `).join("")}
      </div>
    </section>

    ${favs.length ? `
      <section class="oracoes-section">
        <div class="oracoes-section-head"><h3>Guardadas para voltar</h3><p>Suas favoritas em um lugar só.</p></div>
        <div class="oracoes-grid">${favs.map(item => prayerCard(item, { badge: "Favorita" })).join("")}</div>
      </section>` : ""}

    <section class="oracoes-section">
      <div class="oracoes-section-head"><h3>Comece por aqui</h3><p>Clássicas, curtas e sempre úteis.</p></div>
      <div class="oracoes-grid">${featured.map(item => prayerCard(item, { badge: "Essencial" })).join("")}</div>
    </section>
  `;
  scrollDevocionarioTop("auto");
}

async function renderCategory(packId) {
  activeView = { type: "categoria", id: packId };
  currentPrayerId = null;
  exitDevocionarioFocusModes();
  await loadIndex();
  await renderTabs(packId);
  await renderNowSuggestion();
  const content = $("#oracoes-content");
  const pack = await loadPack(packId);
  const meta = indexData.packs.find(p => p.id === packId);
  content.innerHTML = `
    <section class="oracoes-section">
      <div class="oracoes-section-head oracoes-section-head-large">
        <span class="oracoes-large-icon">${esc(meta?.icon || "✠")}</span>
        <div>
          <h3>${esc(meta?.title || pack.title || packId)}</h3>
          <p>${esc(meta?.description || "Orações desta categoria.")}</p>
        </div>
      </div>
      ${packId === "rosario" ? `
        <div class="oracoes-rosario-callout compact">
          <div>
            <span>○ Guia interativo</span>
            <h3>Rosário guiado com contador</h3>
            <p>O Lectio conduz cada conta, salva seu progresso e escolhe os mistérios do dia automaticamente.</p>
          </div>
          <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="rosario-guide">Começar agora</button>
        </div>` : ""}
      <div class="oracoes-grid">${(pack.items || []).map(item => prayerCard({ ...item, packId }, { badge: meta?.title })).join("")}</div>
    </section>
  `;
  scrollDevocionarioTop("auto");
}

async function renderCuratorialBlock(blockId) {
  activeView = { type: "curadoria", id: blockId };
  currentPrayerId = null;
  exitDevocionarioFocusModes();
  await loadIndex();
  await renderTabs("inicio");
  await renderNowSuggestion();
  const content = $("#oracoes-content");
  const block = curatorialBlock(blockId);
  if (!content || !block) return renderHome();
  const prayers = (await Promise.all((block.items || []).map(getPrayer))).filter(Boolean);
  content.innerHTML = `
    <section class="oracoes-section">
      <div class="oracoes-section-head oracoes-section-head-large oracoes-curadoria-head">
        <span class="oracoes-large-icon">${esc(block.icon || "✠")}</span>
        <div>
          <p class="oracoes-kicker">${esc(block.kicker || "Curadoria Lectio")}</p>
          <h3>${esc(block.title)}</h3>
          <p>${esc(block.description || "Seleção organizada de orações para este caminho espiritual.")}</p>
        </div>
      </div>
      <div class="oracoes-grid">${prayers.map(item => prayerCard(item, { badge: block.title })).join("")}</div>
    </section>
  `;
  scrollDevocionarioTop("auto");
}

async function renderFavorites() {
  activeView = { type: "favoritos" };
  currentPrayerId = null;
  exitDevocionarioFocusModes();
  await renderTabs("favoritos");
  await renderNowSuggestion();
  const favItems = (await Promise.all(getFavorites().map(getPrayer))).filter(Boolean);
  const histItems = (await Promise.all(getHistory().slice(0, 8).map(h => getPrayer(h.id)))).filter(Boolean);
  const content = $("#oracoes-content");
  content.innerHTML = `
    <section class="oracoes-section">
      <div class="oracoes-section-head"><h3>Favoritas</h3><p>O que você marcou para voltar depois.</p></div>
      ${favItems.length ? `<div class="oracoes-grid">${favItems.map(item => prayerCard(item, { badge: "Favorita" })).join("")}</div>` : `<div class="oracoes-empty"><strong>Nenhuma favorita ainda.</strong><p>Abra uma oração e toque na estrela para guardá-la.</p></div>`}
    </section>
    <section class="oracoes-section">
      <div class="oracoes-section-head"><h3>Histórico recente</h3><p>Últimas orações abertas neste navegador.</p></div>
      ${histItems.length ? `<div class="oracoes-grid compact">${histItems.map(item => prayerCard(item, { badge: "Histórico" })).join("")}</div>` : `<div class="oracoes-empty"><p>Seu histórico aparecerá aqui após abrir uma oração.</p></div>`}
    </section>
  `;
  scrollDevocionarioTop("auto");
}

async function renderSearch(query) {
  activeView = { type: "pesquisa", query: query || "" };
  currentPrayerId = null;
  exitDevocionarioFocusModes();
  const q = normalizeText(query || "");
  await renderTabs("pesquisa");
  await renderNowSuggestion();
  const content = $("#oracoes-content");
  if (!q) return renderHome();
  const items = await loadAllPacks();
  const scored = items.map(item => {
    const hay = normalizeText([
      item.titulo,
      item.categoria,
      item.tipo,
      item.quando_rezar,
      item.explicacao,
      item.duracao,
      item.fonte_tipo,
      item.fonte_nome,
      item.curadoria?.selo,
      item.curadoria?.familia,
      item.curadoria?.uso,
      ...(item.tags || []),
      ...(item.aliases || []),
      ...(item.momento || [])
    ].join(" "));
    let score = 0;
    if (normalizeText(item.titulo).includes(q)) score += 10;
    if ((item.aliases || []).some(t => normalizeText(t).includes(q))) score += 7;
    if ((item.tags || []).some(t => normalizeText(t).includes(q))) score += 6;
    if (normalizeText(item.curadoria?.familia || "").includes(q)) score += 4;
    if (normalizeText(item.duracao || "").includes(q)) score += 3;
    if (hay.includes(q)) score += 2;
    return { item, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.item.titulo.localeCompare(b.item.titulo, "pt-BR"));

  content.innerHTML = `
    <section class="oracoes-section">
      <div class="oracoes-section-head">
        <h3>Resultado da busca</h3>
        <p>${scored.length ? `${scored.length} oração(ões) encontradas para “${esc(query)}”.` : `Nenhuma oração encontrada para “${esc(query)}”.`}</p>
      </div>
      ${scored.length ? `<div class="oracoes-grid">${scored.map(x => prayerCard(x.item, { badge: packTitle(x.item.packId || x.item.categoria) })).join("")}</div>` : `
        <div class="oracoes-empty">
          <strong>Tente buscar por intenção.</strong>
          <p>Exemplos: medo, família, trabalho, noite, São Miguel, perdão, gratidão.</p>
        </div>`}
    </section>
  `;
}

function paragraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const html = block.split(/\n/).map(line => esc(line)).join("<br>");
      return `<p>${html}</p>`;
    }).join("");
}

function metaLine(item) {
  const chunks = [];
  if (item?.curadoria?.uso) chunks.push(item.curadoria.uso);
  if (item?.curadoria?.selo) chunks.push(item.curadoria.selo);
  else if (item.fonte_tipo) chunks.push(item.fonte_tipo === "lectio" ? "Texto devocional Lectio" : item.fonte_nome || item.fonte_tipo);
  if (item?.duracao) chunks.push(`duração ${durationLabel(item).toLowerCase()}`);
  return chunks.filter(Boolean).join(" · ");
}

function focusToolbar(id, label = "Modo oração") {
  return `
    <div class="oracao-focus-toolbar" role="group" aria-label="${esc(label)}">
      <div class="oracao-focus-toolbar-mark" aria-hidden="true">✠</div>
      <div class="oracao-focus-toolbar-text">
        <strong>${esc(label)}</strong>
        <span>Reze com calma. Toque em sair para ver opções.</span>
      </div>
      <button class="tool-btn small oracao-focus-exit-btn" type="button" data-oracao-action="focus" data-prayer-id="${esc(id)}">Sair</button>
    </div>
  `;
}

function prayerActions(id) {
  if (focusMode) {
    return `
      <div class="oracao-reader-actions oracao-reader-focus-actions">
        <button class="tool-btn oracao-focus-exit-btn" type="button" data-oracao-action="focus" data-prayer-id="${esc(id)}">Sair para opções</button>
      </div>`;
  }
  return `
      <div class="oracao-reader-actions">
        <button class="tool-btn" type="button" data-oracao-action="copy" data-prayer-id="${esc(id)}">Copiar oração</button>
        <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="share-image" data-prayer-id="${esc(id)}">Gerar imagem</button>
        <button class="tool-btn" type="button" data-oracao-action="focus" data-prayer-id="${esc(id)}">Modo foco</button>
      </div>`;
}


function tercoIntroActions(item) {
  if (focusMode) {
    return `
      <div class="oracao-reader-actions oracao-reader-focus-actions terco-intro-focus-actions">
        <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="start-terco-guide" data-prayer-id="${esc(item.id)}">Começar guiado</button>
        <button class="tool-btn oracao-focus-exit-btn" type="button" data-oracao-action="category" data-category-id="rosario">Sair</button>
      </div>`;
  }
  return `
      <div class="oracao-reader-actions terco-intro-actions">
        <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="start-terco-guide" data-prayer-id="${esc(item.id)}">Começar guiado</button>
        <button class="tool-btn" type="button" data-oracao-action="copy" data-prayer-id="${esc(item.id)}">Copiar guia</button>
        <button class="tool-btn" type="button" data-oracao-action="share-image" data-prayer-id="${esc(item.id)}">Gerar imagem</button>
        <button class="tool-btn" type="button" data-oracao-action="focus" data-prayer-id="${esc(item.id)}">Modo oração</button>
        <button class="tool-btn" type="button" data-oracao-action="category" data-category-id="rosario">Voltar</button>
      </div>`;
}

async function renderTercoIntro(item, options = {}) {
  exitRosarioFocusMode();
  const content = $("#oracoes-content");
  if (!content) return;

  currentPrayerId = item.id;
  activeView = { type: "terco-intro", id: item.id };
  if (options.record !== false) recordPrayerUse(item.id);
  if (!options.preserveFocus) focusMode = true;

  await renderTabs(item.packId || item.categoria);
  await renderNowSuggestion();

  const fav = isFavorite(item.id);
  content.innerHTML = `
    ${focusMode ? focusToolbar(item.id, "Modo terço") : ""}
    <article class="oracao-reader terco-intro-reader" data-prayer-id="${esc(item.id)}">
      ${focusMode ? "" : `
      <div class="oracao-reader-actions top">
        <button class="tool-btn small" type="button" data-oracao-action="category" data-category-id="rosario">← Voltar</button>
        <button class="tool-btn small" type="button" data-oracao-action="favorite" data-prayer-id="${esc(item.id)}" aria-pressed="${fav ? "true" : "false"}">${fav ? "★ Favorita" : "☆ Favoritar"}</button>
      </div>`}
      <div class="oracao-reader-head terco-intro-head">
        <span class="oracao-reader-mark">○</span>
        <p class="oracao-reader-kicker">${esc(packTitle(item.packId || item.categoria))}</p>
        <h3>${esc(item.titulo)}</h3>
        ${metaPills(item)}
        ${item.quando_rezar ? `<p class="oracao-when"><strong>Quando rezar:</strong> ${esc(item.quando_rezar)}</p>` : ""}
        <p class="oracao-source">Guia com contas disponível · abre em modo oração</p>
      </div>

      <div class="terco-guided-callout" role="note">
        <span aria-hidden="true">○</span>
        <div>
          <strong>Este terço tem guia interativo.</strong>
          <p>Toque em <b>Começar guiado</b> para rezar este item com contas, progresso salvo e modo oração.</p>
        </div>
      </div>

      <div class="oracao-text">${paragraphs(item.texto)}</div>
      ${item.explicacao ? `<div class="oracao-explicacao"><strong>Sentido espiritual</strong><p>${esc(item.explicacao)}</p></div>` : ""}
      <div class="oracao-tags reader-tags">${(item.tags || []).map(t => `<span>${esc(t)}</span>`).join("")}</div>
      ${tercoIntroActions(item)}
    </article>
  `;

  $("#oracoes-body")?.classList.toggle("oracao-focus-mode", !!focusMode);
  scrollDevocionarioTop("auto");
}

async function startTercoGuide(id) {
  const item = await getPrayer(id);
  const content = $("#oracoes-content");
  if (!item || !content) return;
  currentPrayerId = id;
  activeView = { type: "terco-guide", id };
  focusMode = false;
  $("#oracoes-body")?.classList.remove("oracao-focus-mode");
  await renderTabs(item.packId || item.categoria);
  await renderNowSuggestion();
  return renderTercoGuide(content, item, { toast });
}

function novenaActions(item, currentDay, totalDays, completedToday) {
  if (focusMode) {
    return `
      <div class="oracao-reader-actions oracao-reader-focus-actions">
        <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="novena-mark" data-prayer-id="${esc(item.id)}">${completedToday ? "Desmarcar dia" : "Marcar dia como rezado"}</button>
        <button class="tool-btn oracao-focus-exit-btn" type="button" data-oracao-action="focus" data-prayer-id="${esc(item.id)}">Sair para opções</button>
      </div>`;
  }
  return `
      <div class="oracao-reader-actions">
        <button class="tool-btn" type="button" data-oracao-action="novena-prev" data-prayer-id="${esc(item.id)}" ${currentDay <= 1 ? "disabled" : ""}>Dia anterior</button>
        <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="novena-mark" data-prayer-id="${esc(item.id)}">${completedToday ? "Desmarcar dia" : "Marcar dia como rezado"}</button>
        <button class="tool-btn" type="button" data-oracao-action="novena-next" data-prayer-id="${esc(item.id)}" ${currentDay >= totalDays ? "disabled" : ""}>Próximo dia</button>
      </div>
      <div class="oracao-reader-actions">
        <button class="tool-btn" type="button" data-oracao-action="copy" data-prayer-id="${esc(item.id)}">Copiar novena</button>
        <button class="tool-btn oracao-share-btn" type="button" data-oracao-action="share-image" data-prayer-id="${esc(item.id)}">Gerar imagem</button>
        <button class="tool-btn" type="button" data-oracao-action="novena-reset" data-prayer-id="${esc(item.id)}">Reiniciar novena</button>
        <button class="tool-btn" type="button" data-oracao-action="focus" data-prayer-id="${esc(item.id)}">Modo foco</button>
      </div>`;
}

async function renderRosarioView() {
  currentPrayerId = null;
  activeView = { type: "rosario-guide" };

  // Fluxo V62: primeiro mostra uma tela limpa para escolher os mistérios.
  // Depois que o usuário escolhe, o rosário entra automaticamente em modo foco.
  focusMode = false;
  $("#oracoes-body")?.classList.remove("oracao-focus-mode");
  exitRosarioFocusMode();

  await renderTabs("rosario");
  await renderNowSuggestion();
  const content = $("#oracoes-content");
  if (!content) return;
  await renderRosarioGuide(content, { toast, startMode: true });
}


function dayText(day) {
  return String(day?.texto || "").trim();
}

async function renderNovena(item, options = {}) {
  exitRosarioFocusMode();
  const content = $("#oracoes-content");
  if (!content) return;
  currentPrayerId = item.id;
  activeView = { type: "novena", id: item.id };
  if (options.record !== false) recordPrayerUse(item.id);
  await renderTabs(item.packId || item.categoria);
  await renderNowSuggestion();

  const progress = getNovenaProgress(item.id);
  const totalDays = Array.isArray(item.dias) ? item.dias.length : 9;
  const currentDay = Math.max(1, Math.min(totalDays, progress.currentDay || 1));
  const day = (item.dias || []).find(d => Number(d.dia) === currentDay) || { dia: currentDay, titulo: `Dia ${currentDay}`, texto: item.texto };
  const completedToday = progress.completedDays.includes(currentDay);
  const percent = Math.round((progress.completedDays.length / totalDays) * 100);
  const fav = isFavorite(item.id);

  content.innerHTML = `
    ${focusMode ? focusToolbar(item.id, "Modo novena") : ""}
    <article class="oracao-reader novena-reader" data-prayer-id="${esc(item.id)}">
      ${focusMode ? "" : `
      <div class="oracao-reader-actions top">
        <button class="tool-btn small" type="button" data-oracao-action="home">← Voltar</button>
        <button class="tool-btn small" type="button" data-oracao-action="favorite" data-prayer-id="${esc(item.id)}" aria-pressed="${fav ? "true" : "false"}">${fav ? "★ Favorita" : "☆ Favoritar"}</button>
      </div>`}
      <div class="oracao-reader-head">
        <span class="oracao-reader-mark">9</span>
        <p class="oracao-reader-kicker">Novena ativa</p>
        <h3>${esc(item.titulo)}</h3>
        ${metaPills(item)}
        <p class="oracao-when"><strong>Progresso:</strong> Dia ${esc(currentDay)}/${esc(totalDays)} · ${esc(progress.completedDays.length)} dia(s) rezado(s)</p>
        <div class="rosario-progress" aria-label="Progresso da novena"><span style="width:${esc(percent)}%"></span></div>
      </div>

      <section class="novena-day-card">
        <p class="oracoes-kicker">${completedToday ? "Dia já marcado como rezado" : "Dia atual"}</p>
        <h3>${esc(day.titulo || `Dia ${currentDay}`)}</h3>
        <div class="oracao-text">${paragraphs(dayText(day))}</div>
      </section>

      <div class="oracao-explicacao">
        <strong>Como rezar</strong>
        <p>${esc(item.explicacao || item.quando_rezar || "Reze um dia por vez, com calma, apresentando sua intenção a Deus.")}</p>
      </div>

      ${novenaActions(item, currentDay, totalDays, completedToday)}
    </article>
  `;
  $("#oracoes-body")?.classList.toggle("oracao-focus-mode", !!focusMode);
  scrollDevocionarioTop("auto");
}

function changeNovenaDay(id, delta) {
  updateNovenaProgress(id, progress => {
    progress.currentDay = Math.max(1, Math.min(9, Number(progress.currentDay || 1) + delta));
    return progress;
  });
  renderPrayer(id, { record: false });
}

function toggleNovenaDay(id) {
  updateNovenaProgress(id, progress => {
    const day = Number(progress.currentDay || 1);
    progress.completedDays = progress.completedDays.includes(day)
      ? progress.completedDays.filter(d => d !== day)
      : Array.from(new Set([...progress.completedDays, day])).sort((a, b) => a - b);
    if (progress.completedDays.length >= 9) progress.completed = true;
    else if (day < 9 && progress.completedDays.includes(day)) progress.currentDay = day + 1;
    return progress;
  });
  toast("Progresso da novena atualizado");
  renderPrayer(id, { record: false });
}

function resetNovena(id) {
  const state = getNovenaState();
  delete state[id];
  setNovenaState(state);
  toast("Novena reiniciada");
  renderPrayer(id, { record: false });
}

async function renderPrayer(id, options = {}) {
  exitRosarioFocusMode();
  const item = await getPrayer(id);
  const content = $("#oracoes-content");
  if (!item || !content) {
    content.innerHTML = `<div class="oracoes-empty"><strong>Oração não encontrada.</strong><p>Volte ao início do Devocionário.</p></div>`;
    return;
  }

  // Por padrão, toda oração abre em modo foco: a pessoa já entra em clima de oração.
  // A tela completa continua disponível pelo botão "Sair do foco".
  if (!options.preserveFocus) focusMode = true;

  // Etapa 27: todo terço/rosário abre primeiro em uma tela limpa do item,
  // com botão "Começar guiado". Ao tocar, carrega o guia correspondente com contas.
  if (isGuidedTercoItem(item)) {
    return renderTercoIntro(item, options);
  }

  if (item.tipo === "novena") return renderNovena(item, options);

  currentPrayerId = id;
  activeView = { type: "oracao", id };
  if (options.record !== false) recordPrayerUse(id);
  await renderTabs(item.packId || item.categoria);
  await renderNowSuggestion();

  const fav = isFavorite(id);
  content.innerHTML = `
    ${focusMode ? focusToolbar(id, "Modo oração") : ""}
    <article class="oracao-reader" data-prayer-id="${esc(id)}">
      ${focusMode ? "" : `
      <div class="oracao-reader-actions top">
        <button class="tool-btn small" type="button" data-oracao-action="home">← Voltar</button>
        <button class="tool-btn small" type="button" data-oracao-action="favorite" data-prayer-id="${esc(id)}" aria-pressed="${fav ? "true" : "false"}">${fav ? "★ Favorita" : "☆ Favoritar"}</button>
      </div>`}
      <div class="oracao-reader-head">
        <span class="oracao-reader-mark">✠</span>
        <p class="oracao-reader-kicker">${esc(packTitle(item.packId || item.categoria))}</p>
        <h3>${esc(item.titulo)}</h3>
        ${metaPills(item)}
        ${item.quando_rezar ? `<p class="oracao-when"><strong>Quando rezar:</strong> ${esc(item.quando_rezar)}</p>` : ""}
        ${metaLine(item) ? `<p class="oracao-source">${esc(metaLine(item))}</p>` : ""}
      </div>
      <div class="oracao-text">${paragraphs(item.texto)}</div>
      ${item.explicacao ? `<div class="oracao-explicacao"><strong>Sentido espiritual</strong><p>${esc(item.explicacao)}</p></div>` : ""}
      <div class="oracao-tags reader-tags">${(item.tags || []).map(t => `<span>${esc(t)}</span>`).join("")}</div>
      ${prayerActions(id)}
      ${focusMode ? "" : `<p class="oracao-share-hint">A imagem usa o estilo visual do Lectio e mantém o texto completo da oração dentro do app.</p>`}
    </article>
  `;
  $("#oracoes-body")?.classList.toggle("oracao-focus-mode", !!focusMode);
  scrollDevocionarioTop("auto");
}

async function copyPrayer(id) {
  const item = await getPrayer(id);
  if (!item) return;
  const text = `${item.titulo}\n\n${item.texto}\n\n— Lectio`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Oração copiada");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("Oração copiada"); }
    catch { toast("Não foi possível copiar", "error"); }
    ta.remove();
  }
}

async function sharePrayerImage(id) {
  const item = await getPrayer(id);
  if (!item) return;
  const btn = Array.from(document.querySelectorAll(`[data-oracao-action="share-image"]`)).find(el => el.dataset.prayerId === id);
  const original = btn?.textContent;
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Gerando imagem…";
    }

    const theme = document.body?.dataset?.theme || "sepia";
    await downloadPrayerShareImage({
      title: item.titulo,
      text: item.texto,
      category: packTitle(item.packId || item.categoria),
      subtitle: item.quando_rezar || item.explicacao || "Devocionário Lectio",
      source: item.fonte_tipo === "lectio" ? "Texto devocional Lectio" : (item.fonte_nome || item.fonte_tipo || "Oração católica")
    }, {
      theme,
      background: theme,
      brand: "Lectio",
      subtitle: "Devocionário católico"
    });
    toast("Imagem da oração gerada");
  } catch (err) {
    console.error("[Lectio] Falha ao gerar imagem da oração", err);
    toast("Não foi possível gerar a imagem", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original || "Gerar imagem";
    }
  }
}

function bindDevocionario() {
  if (bound) return;
  const modal = $("#modal-oracoes");
  if (!modal) return;
  bound = true;

  modal.addEventListener("click", async (e) => {
    const quick = e.target.closest("[data-oracao-quick-search]");
    if (quick) {
      e.preventDefault();
      const q = quick.dataset.oracaoQuickSearch || "";
      const input = $("#oracoes-search", modal);
      if (input) input.value = q;
      return renderSearch(q);
    }

    const curadoria = e.target.closest("[data-oracao-curadoria]");
    if (curadoria) {
      e.preventDefault();
      $("#oracoes-search").value = "";
      return renderCuratorialBlock(curadoria.dataset.oracaoCuradoria);
    }

    const tab = e.target.closest("[data-oracao-tab]");
    if (tab) {
      e.preventDefault();
      const id = tab.dataset.oracaoTab;
      $("#oracoes-search").value = "";
      if (id === "inicio") return renderHome();
      if (id === "favoritos") return renderFavorites();
      return renderCategory(id);
    }

    const actionEl = e.target.closest("[data-oracao-action]");
    if (actionEl) {
      e.preventDefault();
      e.stopPropagation();
      const action = actionEl.dataset.oracaoAction;
      const id = actionEl.dataset.prayerId || actionEl.closest("[data-prayer-id]")?.dataset.prayerId;
      if (action === "open" && id) return renderPrayer(id);
      if (action === "favorite" && id) return toggleFavorite(id);
      if (action === "copy" && id) return copyPrayer(id);
      if (action === "share-image" && id) return sharePrayerImage(id);
      if (action === "focus" && id) { focusMode = !focusMode; return renderPrayer(id, { record: false, preserveFocus: true }); }
      if (action === "start-terco-guide" && id) return startTercoGuide(id);
      if (action === "category") {
        const categoryId = actionEl.dataset.categoryId || "inicio";
        $("#oracoes-search").value = "";
        return categoryId === "inicio" ? renderHome() : renderCategory(categoryId);
      }
      if (action === "rosario-guide") return renderRosarioView();
      if (action === "search-focus") {
        const input = $("#oracoes-search");
        input?.focus({ preventScroll: true });
        return;
      }
      if (action === "scroll-categories") {
        return $("#oracoes-categorias-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (action === "novena-prev" && id) return changeNovenaDay(id, -1);
      if (action === "novena-next" && id) return changeNovenaDay(id, 1);
      if (action === "novena-mark" && id) return toggleNovenaDay(id);
      if (action === "novena-reset" && id) return resetNovena(id);
      if (action === "home") return renderHome();
    }

    const card = e.target.closest(".oracao-card[data-prayer-id]");
    if (card) {
      e.preventDefault();
      return renderPrayer(card.dataset.prayerId);
    }
  });

  modal.addEventListener("keydown", (e) => {
    const card = e.target.closest(".oracao-card[data-prayer-id]");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      renderPrayer(card.dataset.prayerId);
    }
  });

  let searchTimer = 0;
  $("#oracoes-search", modal)?.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => renderSearch(q), 260);
  });

  $("#oracoes-clear-search", modal)?.addEventListener("click", () => {
    const input = $("#oracoes-search", modal);
    if (input) input.value = "";
    renderHome();
  });
}

export function initDevocionario(options = {}) {
  ctx = { ...ctx, ...options };
  bindDevocionario();
}

export async function openDevocionario() {
  bindDevocionario();
  if (typeof ctx.openModal === "function") ctx.openModal("#modal-oracoes");
  try {
    await renderHome();
  } catch (err) {
    console.error("[Lectio] Falha ao abrir Devocionário", err);
    const content = $("#oracoes-content");
    if (content) content.innerHTML = `<div class="oracoes-empty"><strong>Não foi possível carregar o Devocionário.</strong><p>${esc(err?.message || "Erro desconhecido")}</p></div>`;
    toast("Erro ao carregar Devocionário", "error");
  }
}

export async function findPrayerById(id) {
  return getPrayer(id);
}
