import { escapeHtml } from "./util.js";

const DATA_URL = "./dados-oracoes/rosario-guiado.json";
const TERCOS_DATA_URL = "./dados-oracoes/tercos-guiados.json";
const PROGRESS_KEY = "lectio.rosario.progress.v1";
const HISTORY_KEY = "lectio.rosario.history.v1";
const STATS_KEY = "lectio.rosario.stats.v1";
const TERCO_PROGRESS_KEY_PREFIX = "lectio.terco.progress.v1.";
const TERCO_HISTORY_KEY = "lectio.terco.history.v1";
const MAX_HISTORY = 20;

let rosarioData = null;
let tercosData = null;
let currentContainer = null;
let currentCtx = { toast: null };
let rosarioFocusMode = false;
let rosarioOptionsOpen = false;
let preserveScrollOnce = false;
let rosarioStartMode = false;
let tercoOptionsOpen = false;
let currentTercoGuide = null;
let currentTercoItem = null;

const esc = (v) => escapeHtml(v == null ? "" : String(v));

function toast(message, kind = "ok") {
  if (typeof currentCtx.toast === "function") currentCtx.toast(message, kind);
}

function applyRosarioFocusMode(enabled = rosarioFocusMode) {
  const body = currentContainer?.closest?.("#oracoes-body") || document.querySelector("#oracoes-body");
  body?.classList.toggle("rosario-focus-mode", !!enabled);
}

function scheduleRosarioScrollReset(behavior = "smooth") {
  const mode = behavior === "instant" ? "auto" : behavior;
  requestAnimationFrame(() => {
    const body = currentContainer?.closest?.("#oracoes-body") || document.querySelector("#oracoes-body");
    const modalCard = currentContainer?.closest?.(".oracoes-modal-card");
    const target = rosarioFocusMode
      ? currentContainer?.querySelector?.(".rosario-focus-topbar") || currentContainer?.querySelector?.(".rosario-step-card")
      : currentContainer?.querySelector?.(".rosario-guide");

    body?.scrollTo?.({ top: 0, behavior: mode });
    currentContainer?.scrollTo?.({ top: 0, behavior: mode });

    // Em alguns navegadores mobile, o scroll real fica no card/modal.
    modalCard?.scrollTo?.({ top: 0, behavior: mode });

    if (target && rosarioFocusMode) {
      target.scrollIntoView({ block: "start", inline: "nearest", behavior: mode });
    }
  });
}

function goToRosarioStep(delta) {
  const progress = getProgress();
  const steps = buildSteps(progress.setId);
  const nextIndex = Math.max(0, Math.min(Number(progress.stepIndex || 0) + delta, steps.length - 1));
  if (nextIndex === Number(progress.stepIndex || 0)) return;
  rosarioOptionsOpen = false;
  saveProgress({ stepIndex: nextIndex });
  return rerender();
}

export function exitRosarioFocusMode() {
  rosarioFocusMode = false;
  rosarioOptionsOpen = false;
  rosarioStartMode = false;
  applyRosarioFocusMode(false);
}

export function enterRosarioFocusMode() {
  rosarioFocusMode = true;
  rosarioOptionsOpen = false;
  rosarioStartMode = false;
  applyRosarioFocusMode(true);
}


async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadRosarioData() {
  if (rosarioData) return rosarioData;
  rosarioData = await fetchJson(DATA_URL);
  return rosarioData;
}

async function loadTercosData() {
  if (tercosData) return tercosData;
  tercosData = await fetchJson(TERCOS_DATA_URL);
  return tercosData;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function todaySetId(data = rosarioData) {
  const day = String(new Date().getDay());
  return data?.default_by_weekday?.[day] || "gozosos";
}

function getProgress() {
  const data = rosarioData;
  const fallback = { setId: todaySetId(data), stepIndex: 0, updatedAt: Date.now() };
  const saved = readJson(PROGRESS_KEY, fallback);
  const setId = data?.mystery_sets?.[saved?.setId] ? saved.setId : todaySetId(data);
  return {
    setId,
    stepIndex: Math.max(0, Number(saved?.stepIndex || 0)),
    updatedAt: Number(saved?.updatedAt || Date.now())
  };
}

function saveProgress(next) {
  const current = getProgress();
  const value = { ...current, ...next, updatedAt: Date.now() };
  writeJson(PROGRESS_KEY, value);
  return value;
}

function resetProgress(setId) {
  return saveProgress({ setId: setId || todaySetId(), stepIndex: 0 });
}

function getHistory() {
  const arr = readJson(HISTORY_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function recordCompletion(setId) {
  const set = rosarioData?.mystery_sets?.[setId];
  const item = { setId, title: set?.title || setId, ts: Date.now() };
  writeJson(HISTORY_KEY, [item, ...getHistory()].slice(0, MAX_HISTORY));

  const stats = readJson(STATS_KEY, { total: 0, bySet: {} });
  stats.total = Number(stats.total || 0) + 1;
  stats.bySet = stats.bySet || {};
  stats.bySet[setId] = Number(stats.bySet[setId] || 0) + 1;
  stats.last = item;
  writeJson(STATS_KEY, stats);
}

function getStats() {
  const stats = readJson(STATS_KEY, { total: 0, bySet: {} });
  return stats && typeof stats === "object" ? stats : { total: 0, bySet: {} };
}

function humanDate(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) +
      " · " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function paragraphHtml(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `<p>${block.split(/\n/).map(line => esc(line)).join("<br>")}</p>`)
    .join("");
}

function prayerStep(prayerKey, badge, extra = {}) {
  const prayer = rosarioData.prayers?.[prayerKey] || { title: prayerKey, text: "" };
  return { kind: "prayer", prayerKey, badge, title: prayer.title, text: prayer.text, ...extra };
}

function buildSteps(setId) {
  const set = rosarioData.mystery_sets?.[setId] || rosarioData.mystery_sets?.[todaySetId()];
  const steps = [];
  steps.push(prayerStep("sinal_da_cruz", "Início"));
  steps.push(prayerStep("credo", "Profissão de fé"));
  steps.push(prayerStep("pai_nosso", "Primeira conta grande"));
  for (let i = 1; i <= 3; i++) {
    steps.push(prayerStep("ave_maria", `Três Ave-Marias · ${i}/3`, { beadType: "intro", beadIndex: i, beadTotal: 3 }));
  }
  steps.push(prayerStep("gloria", "Glória inicial"));

  (set?.mysteries || []).forEach((mystery, index) => {
    const decade = index + 1;
    steps.push({ kind: "mystery", badge: `${decade}º mistério`, title: mystery.title, text: mystery.meditation, reference: mystery.reference, mysteryIndex: decade });
    steps.push(prayerStep("pai_nosso", `${decade}º mistério · Pai-Nosso`, { mysteryIndex: decade }));
    for (let i = 1; i <= 10; i++) {
      steps.push(prayerStep("ave_maria", `${decade}ª dezena · Ave-Maria ${i}/10`, { beadType: "decade", mysteryIndex: decade, beadIndex: i, beadTotal: 10 }));
    }
    steps.push(prayerStep("gloria", `${decade}º mistério · Glória`, { mysteryIndex: decade }));
    steps.push(prayerStep("fatima", `${decade}º mistério · Jaculatória`, { mysteryIndex: decade }));
  });

  steps.push(prayerStep("salve_rainha", "Conclusão"));
  steps.push({ kind: "done", badge: "Final", title: "Rosário concluído", text: "Permaneça alguns instantes em silêncio. Entregue a Deus as intenções rezadas e agradeça pela intercessão de Nossa Senhora." });
  return steps;
}

function beadDots(step, placement = "inline") {
  const total = Number(step?.beadTotal || 0);
  if (!total) return "";
  const active = Number(step?.beadIndex || 0);
  const cls = placement === "top" ? "rosario-beads rosario-beads-top" : "rosario-beads rosario-beads-inline";
  const label = `Conta ${Math.max(1, active)} de ${total}. Deslize para avançar ou voltar uma conta.`;
  return `<div class="${cls}" data-rosario-swipe="true" role="group" aria-label="${esc(label)}">${Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const state = n < active ? "active" : n === active ? "active current" : "";
    return `<span class="${state}" aria-hidden="true"></span>`;
  }).join("")}</div>`;
}

function focusTopBar(step, stepIndex, steps, isFirst) {
  const beadMarkup = beadDots(step, "top") || `<div class="rosario-focus-mini-progress" aria-label="Progresso"><span>${esc(stepIndex + 1)}</span><small>/ ${esc(steps.length)}</small></div>`;
  return `
    <div class="rosario-focus-topbar" data-rosario-swipe="true">
      <div class="rosario-focus-label">
        <span>${esc(step.badge || "Rosário")}</span>
        <small>${esc(`${stepIndex + 1}/${steps.length}`)}</small>
      </div>
      <div class="rosario-focus-bead-row">
        <span class="rosario-string-line" aria-hidden="true"></span>
        ${beadMarkup}
      </div>
      <div class="rosario-gear-wrap">
        <button class="rosario-gear-btn" type="button" data-rosario-action="menu" aria-expanded="${rosarioOptionsOpen ? "true" : "false"}" aria-label="Abrir opções do Rosário">⚙</button>
        <div class="rosario-gear-menu ${rosarioOptionsOpen ? "open" : ""}">
          <button type="button" data-rosario-action="prev" ${isFirst ? "disabled" : ""}>← Conta anterior</button>
          <button type="button" data-rosario-action="reset">Recomeçar do início</button>
          <button type="button" data-rosario-action="focus">Sair do modo oração</button>
        </div>
      </div>
    </div>`;
}


function renderRosarioStartChoice(setId, stats, todaySet) {
  return `
    <section class="rosario-guide rosario-start-guide" data-rosario-view="true" data-rosario-start="true">
      <div class="rosario-start-card">
        <div class="rosario-start-mark" aria-hidden="true">○</div>
        <p class="oracoes-kicker">Rosário guiado</p>
        <h3>Escolha os mistérios para começar</h3>
        <p>Depois da escolha, o Lectio abre direto no modo oração, limpo e sem distrações.</p>
        <div class="rosario-start-today">
          <span>Mistérios sugeridos para hoje</span>
          <strong>${esc(todaySet?.title || "Mistérios do dia")}</strong>
          <small>${esc(todaySet?.days || "")}</small>
        </div>
      </div>
      <section class="rosario-start-panel">
        <div class="oracoes-section-head"><h3>Selecione os mistérios</h3><p>Ao escolher, o Rosário já começa no topo da primeira oração.</p></div>
        <div class="rosario-set-grid">${renderSetChips(setId)}</div>
        <button class="tool-btn oracao-share-btn rosario-start-now-btn" type="button" data-rosario-action="start-today">Começar com os mistérios de hoje</button>
      </section>
      <div class="rosario-start-stats">
        <div class="oracoes-stat-card"><span class="oracoes-stat-label">Rosários concluídos</span><strong>${esc(stats.total || 0)}</strong><small>Salvo somente neste navegador</small></div>
      </div>
    </section>`;
}

function renderSetChips(activeSetId) {
  return Object.entries(rosarioData.mystery_sets || {}).map(([id, set]) => `
    <button class="rosario-set-chip ${id === activeSetId ? "active" : ""}" type="button" data-rosario-action="set" data-set-id="${esc(id)}">
      <strong>${esc(set.title.replace("Mistérios ", ""))}</strong>
      <small>${esc(set.days)}</small>
    </button>
  `).join("");
}

function progressBar(stepIndex, total) {
  const pct = total <= 1 ? 0 : Math.round((stepIndex / (total - 1)) * 100);
  return `<div class="rosario-progress" aria-label="Progresso do Rosário"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
}

function renderStepCard(step, stepIndex, steps, set) {
  const isFirst = stepIndex <= 0;
  const isLast = stepIndex >= steps.length - 1;
  const focusBar = focusTopBar(step, stepIndex, steps, isFirst);
  const normalActions = `
      <div class="rosario-actions">
        <button class="tool-btn small" type="button" data-rosario-action="prev" ${isFirst ? "disabled" : ""}>Anterior</button>
        <button class="tool-btn small" type="button" data-rosario-action="reset">Reiniciar</button>
        <button class="tool-btn small rosario-focus-btn" type="button" data-rosario-action="focus">${rosarioFocusMode ? "Sair do modo oração" : "Modo oração"}</button>
        <button class="tool-btn rosario-next-btn" type="button" data-rosario-action="${isLast ? "finish" : "next"}">${isLast ? "Concluir Rosário" : "Próxima conta"}</button>
      </div>`;
  const focusActions = `
      <div class="rosario-actions rosario-focus-actions">
        <button class="tool-btn rosario-next-btn" type="button" data-rosario-action="${isLast ? "finish" : "next"}">${isLast ? "Concluir Rosário" : "Próxima conta →"}</button>
      </div>`;

  return `
    ${focusBar}
    <article class="rosario-step-card ${step.kind === "mystery" ? "is-mystery" : ""} ${step.kind === "done" ? "is-done" : ""}">
      <div class="rosario-step-meta"><span>${esc(step.badge || "Rosário")}</span><small>${esc(`${stepIndex + 1}/${steps.length}`)}</small></div>
      <h3>${esc(step.title)}</h3>
      ${step.reference ? `<p class="rosario-reference">${esc(step.reference)}</p>` : ""}
      <div class="rosario-step-text">${paragraphHtml(step.text)}</div>
      ${beadDots(step, "inline")}
      ${step.mysteryIndex ? `<p class="rosario-current-mystery">${esc(set.title)} · ${esc(step.mysteryIndex)}º mistério</p>` : ""}
      ${rosarioFocusMode ? focusActions : normalActions}
    </article>`;
}

function renderHistory() {
  const history = getHistory().slice(0, 4);
  if (!history.length) return `<p class="rosario-muted">Seu histórico aparecerá aqui depois que você concluir um Rosário.</p>`;
  return `<ul class="rosario-history">${history.map(h => `<li><strong>${esc(h.title)}</strong><span>${esc(humanDate(h.ts))}</span></li>`).join("")}</ul>`;
}

async function rerender(options = {}) {
  if (!currentContainer) return;
  preserveScrollOnce = !!options.preserveScroll;
  await renderRosarioGuide(currentContainer, currentCtx);
}

export async function renderRosarioGuide(container, options = {}) {
  currentContainer = container;
  currentCtx = { ...currentCtx, ...options };
  if (Object.prototype.hasOwnProperty.call(options, "startMode")) {
    rosarioStartMode = !!options.startMode;
  }
  await loadRosarioData();
  const progress = getProgress();
  const setId = progress.setId || todaySetId();
  const set = rosarioData.mystery_sets?.[setId];
  const steps = buildSteps(setId);
  const stepIndex = Math.max(0, Math.min(progress.stepIndex, steps.length - 1));
  if (stepIndex !== progress.stepIndex) saveProgress({ stepIndex });
  const step = steps[stepIndex];
  const stats = getStats();
  const today = todaySetId();
  const todaySet = rosarioData.mystery_sets?.[today];

  if (rosarioStartMode && !rosarioFocusMode) {
    container.innerHTML = renderRosarioStartChoice(setId, stats, todaySet);
    applyRosarioFocusMode(false);
    container.querySelectorAll("[data-rosario-action]").forEach(btn => btn.addEventListener("click", handleRosarioClick));
    scheduleRosarioScrollReset("smooth");
    return;
  }

  container.innerHTML = `
    <section class="rosario-guide" data-rosario-view="true">
      <div class="rosario-hero-card">
        <div>
          <p class="oracoes-kicker">Rosário guiado</p>
          <h3>Santo Rosário</h3>
          <p>Reze passo a passo, com mistérios do dia, contador de contas e progresso salvo neste navegador.</p>
        </div>
        <div class="rosario-hero-mark">○</div>
      </div>
      <div class="rosario-summary-grid">
        <div class="oracoes-stat-card"><span class="oracoes-stat-label">Mistérios de hoje</span><strong>${esc(todaySet?.title || "—")}</strong><small>${esc(todaySet?.days || "")}</small></div>
        <div class="oracoes-stat-card"><span class="oracoes-stat-label">Rosários concluídos</span><strong>${esc(stats.total || 0)}</strong><small>Salvo somente neste navegador</small></div>
      </div>
      <section class="rosario-set-panel">
        <div class="oracoes-section-head"><h3>Escolha os mistérios</h3><p>O Lectio sugere automaticamente os mistérios do dia, mas você pode trocar quando quiser.</p></div>
        <div class="rosario-set-grid">${renderSetChips(setId)}</div>
      </section>
      ${progressBar(stepIndex, steps.length)}
      ${renderStepCard(step, stepIndex, steps, set || {})}
      <section class="rosario-history-panel">
        <div class="oracoes-section-head"><h3>Histórico do Rosário</h3><p>Últimas conclusões registradas neste navegador.</p></div>
        ${renderHistory()}
      </section>
    </section>`;

  applyRosarioFocusMode();
  container.querySelectorAll("[data-rosario-action]").forEach(btn => btn.addEventListener("click", handleRosarioClick));
  bindRosarioSwipe(container);

  if (preserveScrollOnce) {
    preserveScrollOnce = false;
  } else {
    scheduleRosarioScrollReset(rosarioFocusMode ? "instant" : "smooth");
  }
}

function bindRosarioSwipe(container) {
  const targets = container.querySelectorAll("[data-rosario-swipe]");
  targets.forEach(el => {
    let startX = 0;
    let startY = 0;
    let startTime = 0;

    el.addEventListener("touchstart", (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
    }, { passive: true });

    el.addEventListener("touchend", (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t || !startTime) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const elapsed = Date.now() - startTime;
      startTime = 0;

      if (elapsed > 900) return;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < 48 || absX < absY * 1.25) return;

      // Uma conta por gesto horizontal: puxa para a esquerda avança; puxa para a direita volta.
      ev.preventDefault?.();
      goToRosarioStep(dx < 0 ? 1 : -1);
    }, { passive: false });
  });
}

async function handleRosarioClick(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.rosarioAction;
  const progress = getProgress();
  const steps = buildSteps(progress.setId);
  if (action === "set") {
    const setId = btn.dataset.setId;
    if (!rosarioData.mystery_sets?.[setId]) return;
    rosarioOptionsOpen = false;
    rosarioStartMode = false;
    resetProgress(setId);
    enterRosarioFocusMode();
    toast("Mistérios selecionados. Vamos rezar.");
    return rerender();
  }
  if (action === "start-today") {
    rosarioOptionsOpen = false;
    rosarioStartMode = false;
    resetProgress(todaySetId());
    enterRosarioFocusMode();
    toast("Vamos rezar os mistérios de hoje.");
    return rerender();
  }
  if (action === "menu") {
    rosarioOptionsOpen = !rosarioOptionsOpen;
    return rerender({ preserveScroll: true });
  }
  if (action === "focus") {
    rosarioFocusMode = !rosarioFocusMode;
    rosarioOptionsOpen = false;
    rosarioStartMode = false;
    applyRosarioFocusMode();
    toast(rosarioFocusMode ? "Modo foco do Rosário ativado" : "Modo foco encerrado");
    return rerender();
  }
  if (action === "next") return goToRosarioStep(1);
  if (action === "prev") return goToRosarioStep(-1);
  if (action === "reset") { rosarioOptionsOpen = false; resetProgress(progress.setId); toast("Rosário reiniciado"); return rerender(); }
  if (action === "finish") { rosarioOptionsOpen = false; recordCompletion(progress.setId); resetProgress(progress.setId); toast("Rosário concluído. Deus seja louvado."); return rerender(); }
}


function tercoProgressKey(id) {
  return TERCO_PROGRESS_KEY_PREFIX + String(id || "terco").replace(/[^a-z0-9_-]+/gi, "-");
}

function getTercoProgress(id, totalSteps = 1) {
  const saved = readJson(tercoProgressKey(id), { stepIndex: 0, updatedAt: Date.now() });
  const max = Math.max(0, Number(totalSteps || 1) - 1);
  return {
    stepIndex: Math.max(0, Math.min(Number(saved?.stepIndex || 0), max)),
    updatedAt: Number(saved?.updatedAt || Date.now())
  };
}

function saveTercoProgress(id, next) {
  const current = getTercoProgress(id, Number(next?.totalSteps || 1));
  const value = { ...current, ...next, updatedAt: Date.now() };
  delete value.totalSteps;
  writeJson(tercoProgressKey(id), value);
  return value;
}

function resetTercoProgress(id) {
  saveTercoProgress(id, { stepIndex: 0, totalSteps: 1 });
}

function recordTercoCompletion(id, title) {
  const item = { id, title, ts: Date.now() };
  const history = readJson(TERCO_HISTORY_KEY, []);
  writeJson(TERCO_HISTORY_KEY, [item, ...(Array.isArray(history) ? history : [])].slice(0, MAX_HISTORY));
}

function resolveGuideToken(token) {
  if (typeof token === "string") return tercosData?.common_prayers?.[token] || { title: token, text: "" };
  return token || { title: "Oração", text: "" };
}

function tercoPrayerStep(token, badge) {
  const prayer = resolveGuideToken(token);
  return { kind: "prayer", badge: badge || prayer.title, title: prayer.title, text: prayer.text };
}

function buildTercoSteps(guide) {
  const steps = [];
  steps.push({ kind: "intro", badge: "Início", title: guide.title || "Terço guiado", text: guide.intro || "Reze com calma, avançando uma conta por vez." });

  (guide.start || []).forEach(token => {
    if (token && typeof token === "object" && token.repeat) {
      const prayer = resolveGuideToken(token.repeat);
      for (let i = 1; i <= Number(token.count || 1); i++) {
        steps.push({ kind: "prayer", badge: `${token.badge || prayer.title} · ${i}/${token.count}`, title: prayer.title, text: prayer.text, beadType: "intro", beadIndex: i, beadTotal: Number(token.count || 1) });
      }
    } else {
      steps.push(tercoPrayerStep(token));
    }
  });

  (guide.groups || []).forEach((group, groupIndex) => {
    const groupNumber = groupIndex + 1;
    steps.push({
      kind: "mystery",
      badge: `${groupNumber}ª parte`,
      title: group.title || `${groupNumber}ª parte`,
      text: group.meditation || "Apresente sua intenção e avance com calma.",
      reference: group.reference,
      mysteryIndex: groupNumber
    });

    if (group.large?.text) {
      steps.push({ kind: "prayer", badge: `${groupNumber}ª parte · ${group.large.title || "Conta grande"}`, title: group.large.title || "Conta grande", text: group.large.text, mysteryIndex: groupNumber });
    }

    const small = group.small || null;
    const count = Number(small?.count || 0);
    if (small?.text && count > 0) {
      for (let i = 1; i <= count; i++) {
        steps.push({ kind: "prayer", badge: `${groupNumber}ª parte · ${small.title || "Conta"} ${i}/${count}`, title: small.title || "Conta", text: small.text, beadType: "decade", beadIndex: i, beadTotal: count, mysteryIndex: groupNumber });
      }
    }

    if (group.closing?.text) {
      steps.push({ kind: "prayer", badge: `${groupNumber}ª parte · ${group.closing.title || "Conclusão"}`, title: group.closing.title || "Conclusão", text: group.closing.text, mysteryIndex: groupNumber });
    }
  });

  (guide.ending || []).forEach(token => steps.push(tercoPrayerStep(token, "Conclusão")));
  steps.push({ kind: "done", badge: "Final", title: "Oração concluída", text: "Permaneça alguns instantes em silêncio. Entregue a Deus as intenções rezadas e agradeça pela graça deste momento de oração." });
  return steps;
}

function tercoFocusTopBar(step, stepIndex, steps, isFirst) {
  const beadMarkup = beadDots(step, "top") || `<div class="rosario-focus-mini-progress" aria-label="Progresso"><span>${esc(stepIndex + 1)}</span><small>/ ${esc(steps.length)}</small></div>`;
  return `
    <div class="rosario-focus-topbar terco-focus-topbar" data-terco-swipe="true">
      <div class="rosario-focus-label">
        <span>${esc(step.badge || "Terço")}</span>
        <small>${esc(`${stepIndex + 1}/${steps.length}`)}</small>
      </div>
      <div class="rosario-focus-bead-row">
        <span class="rosario-string-line" aria-hidden="true"></span>
        ${beadMarkup}
      </div>
      <div class="rosario-gear-wrap">
        <button class="rosario-gear-btn" type="button" data-terco-action="menu" aria-expanded="${tercoOptionsOpen ? "true" : "false"}" aria-label="Abrir opções do guia">⚙</button>
        <div class="rosario-gear-menu ${tercoOptionsOpen ? "open" : ""}">
          <button type="button" data-terco-action="prev" ${isFirst ? "disabled" : ""}>← Conta anterior</button>
          <button type="button" data-terco-action="reset">Recomeçar do início</button>
          <button type="button" data-terco-action="focus">Sair do modo oração</button>
        </div>
      </div>
    </div>`;
}

function renderTercoStepCard(step, stepIndex, steps, guide) {
  const isFirst = stepIndex <= 0;
  const isLast = stepIndex >= steps.length - 1;
  const focusBar = tercoFocusTopBar(step, stepIndex, steps, isFirst);
  const normalActions = `
      <div class="rosario-actions terco-actions">
        <button class="tool-btn small" type="button" data-terco-action="prev" ${isFirst ? "disabled" : ""}>Anterior</button>
        <button class="tool-btn small" type="button" data-terco-action="reset">Reiniciar</button>
        <button class="tool-btn small rosario-focus-btn" type="button" data-terco-action="focus">${rosarioFocusMode ? "Sair do modo oração" : "Modo oração"}</button>
        <button class="tool-btn rosario-next-btn" type="button" data-terco-action="${isLast ? "finish" : "next"}">${isLast ? "Concluir" : "Próxima conta"}</button>
      </div>`;
  const focusActions = `
      <div class="rosario-actions rosario-focus-actions terco-focus-actions">
        <button class="tool-btn rosario-next-btn" type="button" data-terco-action="${isLast ? "finish" : "next"}">${isLast ? "Concluir oração" : "Próxima conta →"}</button>
      </div>`;
  return `
    ${focusBar}
    <article class="rosario-step-card terco-step-card ${step.kind === "mystery" ? "is-mystery" : ""} ${step.kind === "done" ? "is-done" : ""}">
      <div class="rosario-step-meta"><span>${esc(step.badge || "Terço")}</span><small>${esc(`${stepIndex + 1}/${steps.length}`)}</small></div>
      <h3>${esc(step.title)}</h3>
      ${step.reference ? `<p class="rosario-reference">${esc(step.reference)}</p>` : ""}
      <div class="rosario-step-text">${paragraphHtml(step.text)}</div>
      ${beadDots(step, "inline")}
      ${step.mysteryIndex ? `<p class="rosario-current-mystery">${esc(guide.title || "Terço guiado")} · ${esc(step.mysteryIndex)}ª parte</p>` : ""}
      ${rosarioFocusMode ? focusActions : normalActions}
    </article>`;
}

function bindTercoSwipe(container) {
  const targets = container.querySelectorAll("[data-terco-swipe], [data-rosario-swipe]");
  targets.forEach(el => {
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    el.addEventListener("touchstart", (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
    }, { passive: true });
    el.addEventListener("touchend", (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t || !startTime) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const elapsed = Date.now() - startTime;
      startTime = 0;
      if (elapsed > 900) return;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < 48 || absX < absY * 1.25) return;
      ev.preventDefault?.();
      goToTercoStep(dx < 0 ? 1 : -1);
    }, { passive: false });
  });
}

function goToTercoStep(delta) {
  if (!currentTercoGuide) return;
  const steps = buildTercoSteps(currentTercoGuide);
  const progress = getTercoProgress(currentTercoGuide.id, steps.length);
  const nextIndex = Math.max(0, Math.min(Number(progress.stepIndex || 0) + delta, steps.length - 1));
  if (nextIndex === Number(progress.stepIndex || 0)) return;
  tercoOptionsOpen = false;
  saveTercoProgress(currentTercoGuide.id, { stepIndex: nextIndex, totalSteps: steps.length });
  return rerenderTerco();
}

async function rerenderTerco(options = {}) {
  if (!currentContainer || !currentTercoItem) return;
  await renderTercoGuide(currentContainer, currentTercoItem, { ...currentCtx, ...options, preserveStartFocus: true });
}

async function handleTercoClick(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.tercoAction;
  if (!currentTercoGuide) return;
  const steps = buildTercoSteps(currentTercoGuide);
  const progress = getTercoProgress(currentTercoGuide.id, steps.length);
  if (action === "menu") {
    tercoOptionsOpen = !tercoOptionsOpen;
    return rerenderTerco({ preserveScroll: true });
  }
  if (action === "focus") {
    rosarioFocusMode = !rosarioFocusMode;
    tercoOptionsOpen = false;
    applyRosarioFocusMode(rosarioFocusMode);
    toast(rosarioFocusMode ? "Modo oração ativado" : "Modo oração encerrado");
    return rerenderTerco();
  }
  if (action === "next") return goToTercoStep(1);
  if (action === "prev") return goToTercoStep(-1);
  if (action === "reset") {
    tercoOptionsOpen = false;
    saveTercoProgress(currentTercoGuide.id, { stepIndex: 0, totalSteps: steps.length });
    toast("Guia reiniciado");
    return rerenderTerco();
  }
  if (action === "finish") {
    tercoOptionsOpen = false;
    recordTercoCompletion(currentTercoGuide.id, currentTercoGuide.title);
    saveTercoProgress(currentTercoGuide.id, { stepIndex: 0, totalSteps: steps.length });
    toast("Oração concluída. Deus seja louvado.");
    return rerenderTerco();
  }
}

export function isGuidedTercoItem(item) {
  return item?.categoria === "rosario" || item?.packId === "rosario";
}

export async function renderTercoGuide(container, item, options = {}) {
  currentContainer = container;
  currentCtx = { ...currentCtx, ...options };
  currentTercoItem = item;
  await loadTercosData();
  const guide = tercosData?.guides?.[item?.id];
  if (!guide) {
    container.innerHTML = `<div class="oracoes-empty"><strong>Guia não encontrado.</strong><p>Volte ao Devocionário e escolha outro terço ou rosário.</p></div>`;
    return;
  }
  currentTercoGuide = guide;
  if (!options.preserveStartFocus) rosarioFocusMode = true;
  rosarioStartMode = false;
  rosarioOptionsOpen = false;
  const steps = buildTercoSteps(guide);
  const progress = getTercoProgress(guide.id, steps.length);
  const stepIndex = Math.max(0, Math.min(progress.stepIndex, steps.length - 1));
  if (stepIndex !== progress.stepIndex) saveTercoProgress(guide.id, { stepIndex, totalSteps: steps.length });
  const step = steps[stepIndex];

  container.innerHTML = `
    <section class="rosario-guide terco-guide" data-terco-view="true">
      <div class="rosario-hero-card terco-hero-card">
        <div>
          <p class="oracoes-kicker">Terço guiado</p>
          <h3>${esc(guide.title || item.titulo)}</h3>
          <p>${esc(guide.intro || item.quando_rezar || "Reze passo a passo, avançando uma conta por vez.")}</p>
        </div>
        <div class="rosario-hero-mark">○</div>
      </div>
      ${progressBar(stepIndex, steps.length)}
      ${renderTercoStepCard(step, stepIndex, steps, guide)}
    </section>`;

  applyRosarioFocusMode(rosarioFocusMode);
  container.querySelectorAll("[data-terco-action]").forEach(btn => btn.addEventListener("click", handleTercoClick));
  bindTercoSwipe(container);

  if (options.preserveScroll) return;
  scheduleRosarioScrollReset(rosarioFocusMode ? "instant" : "smooth");
}

export async function getRosarioTodaySummary() {
  await loadRosarioData();
  const id = todaySetId();
  const set = rosarioData.mystery_sets?.[id];
  const progress = getProgress();
  return { id, title: set?.title || "Mistérios do dia", days: set?.days || "", activeSetId: progress.setId, stepIndex: progress.stepIndex, totalSteps: buildSteps(progress.setId).length };
}
