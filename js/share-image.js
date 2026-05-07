/* =========================================================
   SHARE IMAGE — gera imagem PNG de versículo selecionado
   =========================================================
   Módulo isolado e sem efeitos colaterais. Ele não altera a UI,
   não acessa storage e não chama IA. Serve como base segura para
   a futura feature "Compartilhar versículo".
*/

import { escapeHtml } from "./util.js";

const DEFAULTS = Object.freeze({
  width: 1080,
  height: 1350,
  paddingX: 96,
  paddingY: 110,
  brand: "Lectio",
  subtitle: "Bíblia católica de estudo",
  background: "sepia",
  fontSerif: "Georgia, 'Times New Roman', serif",
  fontSans: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
});

const THEMES = Object.freeze({
  sepia: {
    bg: "#efe2c8",
    bg2: "#ddc7a2",
    ink: "#302516",
    muted: "#6f5b3c",
    line: "rgba(48,37,22,.22)",
    accent: "#8b5e22",
    card: "rgba(255,250,240,.42)"
  },
  light: {
    bg: "#f7f4ed",
    bg2: "#e7dfcf",
    ink: "#23201b",
    muted: "#686158",
    line: "rgba(35,32,27,.18)",
    accent: "#7b4f19",
    card: "rgba(255,255,255,.46)"
  },
  dark: {
    bg: "#14110d",
    bg2: "#302516",
    ink: "#f3ead8",
    muted: "#c6b796",
    line: "rgba(243,234,216,.20)",
    accent: "#d6ad6b",
    card: "rgba(255,255,255,.055)"
  }
});

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function getTheme(name) {
  return THEMES[name] || THEMES.sepia;
}

function canvasSupported() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = clamp(r, 0, Math.min(w, h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function measureWrappedLines(ctx, text, maxWidth) {
  const words = cleanText(text).split(" ").filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function fitVerseTypography(ctx, text, maxWidth, maxHeight, fontFamily) {
  let fontSize = 58;
  let lineHeight = 76;
  let lines = [];

  while (fontSize >= 36) {
    lineHeight = Math.round(fontSize * 1.32);
    ctx.font = `400 ${fontSize}px ${fontFamily}`;
    lines = measureWrappedLines(ctx, text, maxWidth);
    if (lines.length * lineHeight <= maxHeight) break;
    fontSize -= 2;
  }

  return { fontSize, lineHeight, lines };
}

function drawBackground(ctx, width, height, theme) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, theme.bg);
  gradient.addColorStop(1, theme.bg2);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 1;
  for (let x = -height; x < width; x += 52) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height, height);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCard(ctx, opts, theme) {
  const x = opts.paddingX - 24;
  const y = opts.paddingY - 24;
  const w = opts.width - (opts.paddingX - 24) * 2;
  const h = opts.height - (opts.paddingY - 24) * 2;

  ctx.save();
  ctx.fillStyle = theme.card;
  drawRoundedRect(ctx, x, y, w, h, 34);
  ctx.fill();
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawDecor(ctx, opts, theme) {
  const { width, height, paddingX, paddingY } = opts;

  ctx.save();
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(paddingX, paddingY + 126);
  ctx.lineTo(width - paddingX, paddingY + 126);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(paddingX, height - paddingY - 145);
  ctx.lineTo(width - paddingX, height - paddingY - 145);
  ctx.stroke();

  ctx.fillStyle = theme.accent;
  ctx.font = `400 46px ${opts.fontSerif}`;
  ctx.textAlign = "center";
  ctx.fillText("✠", width / 2, paddingY + 98);
  ctx.restore();
}

function drawTextBlock(ctx, data, opts, theme) {
  const { width, height, paddingX, paddingY } = opts;
  const maxWidth = width - paddingX * 2;
  const availableVerseHeight = height - paddingY * 2 - 410;

  ctx.save();
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "center";
  ctx.font = `500 26px ${opts.fontSans}`;
  ctx.fillText(opts.brand.toUpperCase(), width / 2, paddingY + 30);

  ctx.font = `400 24px ${opts.fontSans}`;
  ctx.fillText(opts.subtitle, width / 2, paddingY + 64);

  const verse = fitVerseTypography(ctx, data.text, maxWidth, availableVerseHeight, opts.fontSerif);
  ctx.font = `400 ${verse.fontSize}px ${opts.fontSerif}`;
  ctx.fillStyle = theme.ink;
  ctx.textAlign = "left";

  const verseHeight = verse.lines.length * verse.lineHeight;
  let y = Math.round((height - verseHeight) / 2) - 20;
  y = clamp(y, paddingY + 210, height - paddingY - 260 - verseHeight);

  for (const line of verse.lines) {
    ctx.fillText(line, paddingX, y);
    y += verse.lineHeight;
  }

  ctx.fillStyle = theme.accent;
  ctx.textAlign = "center";
  ctx.font = `700 38px ${opts.fontSans}`;
  ctx.fillText(data.reference, width / 2, height - paddingY - 82);

  if (data.translation) {
    ctx.fillStyle = theme.muted;
    ctx.font = `400 25px ${opts.fontSans}`;
    ctx.fillText(data.translation, width / 2, height - paddingY - 44);
  }

  ctx.restore();
}

function makeCanvas(width, height) {
  if (!canvasSupported()) {
    throw new Error("Canvas indisponível neste ambiente.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("Não foi possível gerar a imagem."));
      }, type, quality);
      return;
    }

    try {
      const dataUrl = canvas.toDataURL(type, quality);
      const binary = atob(dataUrl.split(",")[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      resolve(new Blob([bytes], { type }));
    } catch (err) {
      reject(err);
    }
  });
}

export function buildShareFilename(reference = "versiculo") {
  const safe = cleanText(reference)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "versiculo";
  return `lectio-${safe}.png`;
}

export function buildSharePreviewHtml({ text, reference, translation } = {}) {
  const parts = [];
  if (text) parts.push(`<p>${escapeHtml(cleanText(text))}</p>`);
  if (reference) parts.push(`<strong>${escapeHtml(cleanText(reference))}</strong>`);
  if (translation) parts.push(`<small>${escapeHtml(cleanText(translation))}</small>`);
  return parts.join("\n");
}

export function renderVerseShareCanvas(input = {}, options = {}) {
  const text = cleanText(input.text || input.verseText);
  const reference = cleanText(input.reference || input.ref);
  const translation = cleanText(input.translation || input.version || "");

  if (!text) throw new Error("Texto do versículo ausente.");
  if (!reference) throw new Error("Referência do versículo ausente.");

  const opts = { ...DEFAULTS, ...options };
  opts.width = clamp(Number(opts.width) || DEFAULTS.width, 640, 2400);
  opts.height = clamp(Number(opts.height) || DEFAULTS.height, 640, 3000);
  opts.paddingX = clamp(Number(opts.paddingX) || DEFAULTS.paddingX, 48, 180);
  opts.paddingY = clamp(Number(opts.paddingY) || DEFAULTS.paddingY, 64, 220);

  const theme = getTheme(opts.background || opts.theme);
  const canvas = makeCanvas(opts.width, opts.height);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, opts.width, opts.height, theme);
  drawCard(ctx, opts, theme);
  drawDecor(ctx, opts, theme);
  drawTextBlock(ctx, { text, reference, translation }, opts, theme);

  return canvas;
}

export async function createVerseShareImage(input = {}, options = {}) {
  const canvas = renderVerseShareCanvas(input, options);
  const blob = await toBlob(canvas, options.type || "image/png", options.quality);
  const filename = options.filename || buildShareFilename(input.reference || input.ref);
  return { blob, filename, canvas };
}

export async function downloadVerseShareImage(input = {}, options = {}) {
  const { blob, filename } = await createVerseShareImage(input, options);
  const url = URL.createObjectURL(blob);

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { blob, filename };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}


/* =========================================================
   SHARE IMAGE — Devocionário
   =========================================================
   Reaproveita o mesmo DNA visual do Lectio para gerar imagem
   de oração. O texto é ajustado para caber com segurança; se a
   oração for muito longa, a imagem mostra uma versão visual
   legível e orienta a leitura completa no app.
*/

function splitParagraphLines(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}|\n/)
    .map(x => cleanText(x))
    .filter(Boolean);
}

function shortenForImage(text, maxChars = 980) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return { text: clean, shortened: false };
  const slice = clean.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf("."), slice.lastIndexOf(";"), slice.lastIndexOf(","), slice.lastIndexOf(" "));
  return {
    text: `${slice.slice(0, cut > 520 ? cut : maxChars).trim()}…`,
    shortened: true
  };
}

function fitPrayerTypography(ctx, text, maxWidth, maxHeight, fontFamily) {
  let fontSize = 43;
  let lineHeight = 60;
  let lines = [];

  while (fontSize >= 28) {
    lineHeight = Math.round(fontSize * 1.38);
    ctx.font = `400 ${fontSize}px ${fontFamily}`;
    lines = measureWrappedLines(ctx, text, maxWidth);
    if (lines.length * lineHeight <= maxHeight) break;
    fontSize -= 2;
  }

  return { fontSize, lineHeight, lines };
}

function drawPrayerTextBlock(ctx, data, opts, theme) {
  const { width, height, paddingX, paddingY } = opts;
  const maxWidth = width - paddingX * 2;

  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = theme.muted;
  ctx.font = `500 25px ${opts.fontSans}`;
  ctx.fillText(opts.brand.toUpperCase(), width / 2, paddingY + 30);
  ctx.font = `400 23px ${opts.fontSans}`;
  ctx.fillText(opts.subtitle || "Devocionário católico", width / 2, paddingY + 62);

  ctx.fillStyle = theme.accent;
  ctx.font = `400 48px ${opts.fontSerif}`;
  ctx.fillText("✠", width / 2, paddingY + 120);

  ctx.fillStyle = theme.muted;
  ctx.font = `700 22px ${opts.fontSans}`;
  ctx.fillText(cleanText(data.category || "Oração Católica").toUpperCase(), width / 2, paddingY + 170);

  ctx.fillStyle = theme.ink;
  ctx.font = `600 58px ${opts.fontSerif}`;
  const titleLines = measureWrappedLines(ctx, cleanText(data.title), maxWidth).slice(0, 3);
  let y = paddingY + 240;
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, y);
    y += 62;
  }

  const titleBottom = y + 10;
  const footTop = height - paddingY - 145;
  const availableTextHeight = footTop - titleBottom - 24;
  const prepared = shortenForImage(data.text, data.maxChars || 980);
  const prayer = fitPrayerTypography(ctx, prepared.text, maxWidth, availableTextHeight, opts.fontSerif);

  ctx.textAlign = "left";
  ctx.fillStyle = theme.ink;
  ctx.font = `400 ${prayer.fontSize}px ${opts.fontSerif}`;
  y = titleBottom + 22;
  for (const line of prayer.lines) {
    ctx.fillText(line, paddingX, y);
    y += prayer.lineHeight;
  }

  if (prepared.shortened) {
    ctx.textAlign = "center";
    ctx.fillStyle = theme.muted;
    ctx.font = `500 22px ${opts.fontSans}`;
    ctx.fillText("Continue a oração completa no Lectio", width / 2, footTop + 18);
  }

  const subtitle = cleanText(data.subtitle || data.source || "");
  if (subtitle) {
    ctx.textAlign = "center";
    ctx.fillStyle = theme.muted;
    ctx.font = `400 24px ${opts.fontSans}`;
    const subLines = measureWrappedLines(ctx, subtitle, maxWidth).slice(0, 2);
    let sy = height - paddingY - 82;
    for (const line of subLines) {
      ctx.fillText(line, width / 2, sy);
      sy += 30;
    }
  }

  ctx.fillStyle = theme.accent;
  ctx.font = `700 28px ${opts.fontSans}`;
  ctx.fillText("LECTIO", width / 2, height - paddingY - 22);
  ctx.restore();
}

export function buildPrayerShareFilename(title = "oracao") {
  const safe = cleanText(title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "oracao";
  return `lectio-oracao-${safe}.png`;
}

export function renderPrayerShareCanvas(input = {}, options = {}) {
  const title = cleanText(input.title || input.titulo);
  const text = String(input.text || input.texto || "").trim();
  if (!title) throw new Error("Título da oração ausente.");
  if (!text) throw new Error("Texto da oração ausente.");

  const opts = { ...DEFAULTS, ...options };
  opts.width = clamp(Number(opts.width) || DEFAULTS.width, 640, 2400);
  opts.height = clamp(Number(opts.height) || DEFAULTS.height, 900, 3000);
  opts.paddingX = clamp(Number(opts.paddingX) || 86, 48, 180);
  opts.paddingY = clamp(Number(opts.paddingY) || 92, 64, 220);

  const theme = getTheme(opts.background || opts.theme);
  const canvas = makeCanvas(opts.width, opts.height);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, opts.width, opts.height, theme);
  drawCard(ctx, opts, theme);
  drawDecor(ctx, { ...opts, paddingY: opts.paddingY + 22 }, theme);
  drawPrayerTextBlock(ctx, {
    title,
    text,
    category: input.category || input.categoria,
    subtitle: input.subtitle || input.quando_rezar,
    source: input.source || input.fonte,
    maxChars: options.maxChars
  }, opts, theme);

  return canvas;
}

export async function createPrayerShareImage(input = {}, options = {}) {
  const canvas = renderPrayerShareCanvas(input, options);
  const blob = await toBlob(canvas, options.type || "image/png", options.quality);
  const filename = options.filename || buildPrayerShareFilename(input.title || input.titulo);
  return { blob, filename, canvas };
}

export async function downloadPrayerShareImage(input = {}, options = {}) {
  const { blob, filename } = await createPrayerShareImage(input, options);
  const url = URL.createObjectURL(blob);

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { blob, filename };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}
