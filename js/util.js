/* =========================================================
   UTIL — funções pequenas compartilhadas entre módulos
   Mantém sanitização/normalização em um lugar só.
   ========================================================= */

/**
 * Escapa texto antes de inserir em HTML via template string.
 * Evita que conteúdo de notas, livros, buscas ou versículos vire markup.
 */
export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

/**
 * Normaliza texto para busca/filtro: remove acentos e ignora caixa.
 */
export function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Formata datas de forma segura para exibição curta no app.
 */
export function formatDateTime(value, locale = "pt-BR") {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
