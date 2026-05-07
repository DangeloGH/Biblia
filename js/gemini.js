/* =========================================================
   GEMINI — chamadas à API com prompts católicos
   ========================================================= */

const SYSTEM_PROMPT = `Você é um assistente de estudo bíblico católico, fiel ao Magistério da Igreja Católica Apostólica Romana, ao Catecismo da Igreja Católica (CIC) e à Tradição. Suas respostas:
- São doutrinariamente católicas, respeitando a Sagrada Tradição, o Magistério e os 73 livros do cânon católico (incluindo deuterocanônicos).
- Citam, quando pertinente, Padres da Igreja (Agostinho, Crisóstomo, Aquino, Jerônimo etc.), o CIC (com número quando souber), documentos conciliares e papais.
- Distinguem claramente o sentido literal, alegórico, moral e anagógico (4 sentidos da Escritura).
- NUNCA promovem leituras protestantes como equivalentes, embora possam mencioná-las academicamente quando relevante.
- São redigidas em português do Brasil, em prosa fluida, com uso moderado de **negrito** para realces e cabeçalhos H3 (### ) quando útil.
- Mantêm tom reverente, contemplativo, formativo. Não evangélico-emocional.
- Quando incerto sobre fato histórico ou citação literal, declaram a incerteza em vez de inventar.
Responda concisamente (máx. ~250 palavras), salvo se a pergunta exigir profundidade.`;

const PROMPTS = {
  contexto: (ref, txt) =>
    `**Passagem:** ${ref}\n"${txt}"\n\nSituar historicamente: autor, datação aproximada, audiência original, gênero literário, contexto imediato no livro e cultural. Sem doutrina, apenas o pano de fundo necessário para entender o texto.`,

  catolico: (ref, txt) =>
    `**Passagem:** ${ref}\n"${txt}"\n\nApresentar a leitura católica desta passagem: o que a Igreja, a Tradição e o Magistério ensinam sobre ela? Quais doutrinas se sustentam ou são iluminadas por ela? Qual seu lugar na economia da salvação?`,

  patristica: (ref, txt) =>
    `**Passagem:** ${ref}\n"${txt}"\n\nApresentar a leitura dos Padres da Igreja sobre esta passagem. Citar 2 ou 3 Padres (ex.: Agostinho, Crisóstomo, Jerônimo, Ireneu, Orígenes, Aquino) com a essência do que ensinaram, incluindo, quando souber, a obra de origem. Se a passagem não tiver tradição patrística específica conhecida, declare-o.`,

  // ← CORRIGIDO: injeta os textos REAIS dos §§ quando disponíveis
  catecismo: (ref, txt, cicBlock = "") =>
    `**Passagem:** ${ref}\n"${txt}"\n\n` +
    (cicBlock
      ? `Os parágrafos abaixo são o TEXTO OFICIAL do Catecismo da Igreja Católica (extraídos do site do Vaticano). Use SOMENTE eles — cite o número e o texto exato, sem parafrasear além do necessário. NÃO invente nem cite parágrafos que não estejam na lista abaixo.\n\n${cicBlock}\n\nCom base nesses parágrafos, explique como o Catecismo ilumina a passagem bíblica acima.`
      : `Indicar passagens do Catecismo da Igreja Católica (com números CIC §) que tratam dos temas desta perícope. Para cada uma, parafrasear brevemente o ensinamento. Se não houver vínculo direto, citar parágrafos do CIC sobre os temas adjacentes.\n\nAVISO: os textos dos parágrafos não estão disponíveis localmente. Seja criterioso e declare incerteza sobre citações literais.`
    ),

  aplicacao: (ref, txt) =>
    `**Passagem:** ${ref}\n"${txt}"\n\nSugerir aplicação prática para a vida cristã hoje: virtudes a cultivar, exames de consciência, posturas concretas, possíveis tentações relacionadas, pequenos passos. Tom prático e pastoral, sem moralismo raso.`,

  oracao: (ref, txt) =>
    `**Passagem:** ${ref}\n"${txt}"\n\nCompor uma oração breve (8 a 12 linhas), na linha das colectas litúrgicas católicas: invocação, motivo, pedido, doxologia. Linguagem reverente, em prosa.`
};

const LECTIO_PROMPTS = {
  1: (ref, txt) => `Etapa **Lectio** (leitura atenta) para ${ref}: "${txt}"\n\nDestacar 3 a 5 palavras-chave do texto e seu peso no original (hebraico/grego, brevíssimo). O foco é ler devagar, não interpretar ainda.`,
  2: (ref, txt) => `Etapa **Meditatio** (meditação) para ${ref}: "${txt}"\n\nPropor 3 a 4 perguntas meditativas que ajudem a ruminar o texto. Que ressoa? Que incomoda? Onde isso toca minha vida hoje?`,
  3: (ref, txt) => `Etapa **Oratio** (oração) para ${ref}: "${txt}"\n\nCompor uma oração pessoal a partir do texto, em primeira pessoa, dirigida ao Pai pelo Filho no Espírito. Curta, em prosa.`,
  4: (ref, txt) => `Etapa **Contemplatio** (contemplação) para ${ref}: "${txt}"\n\nUma palavra ou imagem do texto para guardar em silêncio. Sugerir como permanecer em silêncio com ela por alguns minutos. Brevíssimo.`
};


/* ==========================================================
   MODELOS GEMINI — lista dinâmica + fallback
   ========================================================== */
export const FALLBACK_TEXT_MODELS = [
  "gemini-2.5-pro",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemma-3-27b-it",
  "gemma-3-12b-it",
  "gemma-3-4b-it",
  "gemini-2.0-flash"
];

let _modelsCache = null;
let _modelsCacheAt = 0;
const MODEL_CACHE_MS = 10 * 60 * 1000;

function cleanModelName(name) {
  return String(name || "").replace(/^models\//, "").trim();
}

function isTextGenerationModel(model) {
  const id = cleanModelName(model?.name || model?.baseModelId || model);
  const methods = model?.supportedGenerationMethods || model?.supported_actions || [];
  const supportsGenerate = !Array.isArray(methods) || methods.length === 0
    ? true
    : methods.includes("generateContent") || methods.includes("streamGenerateContent");

  if (!supportsGenerate) return false;
  if (!id) return false;

  // Evita endpoints que são de embedding, áudio, imagem/vídeo ou ferramentas.
  return !/(embedding|embed|imagen|image|veo|lyria|tts|aqa|robotics|computer-use|deep-research|live|music)/i.test(id);
}

function modelRank(id, preferredModel = "") {
  id = cleanModelName(id);
  preferredModel = cleanModelName(preferredModel);
  if (preferredModel && id === preferredModel) return -1000;

  // Prioridade: qualidade alta primeiro, depois modelos rápidos/baratos, por fim Gemma.
  let score = 500;
  if (/gemini/i.test(id)) score -= 200;
  if (/gemma/i.test(id)) score += 150;

  if (/pro/i.test(id)) score -= 90;
  if (/flash-latest/i.test(id)) score -= 80;
  if (/3(\.|-)/i.test(id)) score -= 60;
  if (/2\.5/i.test(id)) score -= 50;
  if (/flash(?!-lite)/i.test(id)) score -= 35;
  if (/flash-lite/i.test(id)) score += 15;
  if (/latest/i.test(id)) score -= 20;
  if (/preview/i.test(id)) score += 20;
  if (/deprecated/i.test(id)) score += 300;

  const size = id.match(/(?:gemma|gemini).*?(\d+)b/i);
  if (size) score -= Math.min(40, parseInt(size[1], 10));

  return score;
}

function dedupeModels(models) {
  const out = [];
  const seen = new Set();
  for (const m of models) {
    const id = cleanModelName(m);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function listGeminiTextModels(apiKey, { force = false } = {}) {
  if (!apiKey) return [];
  const now = Date.now();
  if (!force && _modelsCache && (now - _modelsCacheAt) < MODEL_CACHE_MS) {
    return _modelsCache;
  }

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${apiKey}`);
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Gemini modelos ${resp.status}: ${err.slice(0, 180)}`);
  }

  const data = await resp.json();
  const models = (data.models || [])
    .filter(isTextGenerationModel)
    .map(m => cleanModelName(m.name || m.baseModelId))
    .filter(Boolean);

  _modelsCache = dedupeModels(models);
  _modelsCacheAt = now;
  return _modelsCache;
}

export async function buildModelQueue({ apiKey, preferredModel } = {}) {
  let live = [];
  try {
    live = await listGeminiTextModels(apiKey);
  } catch (e) {
    console.warn("[Lectio] Não foi possível listar modelos Gemini; usando fallback local.", e);
  }

  // Quando a API retorna a lista, respeitamos somente modelos realmente disponíveis
  // para essa chave. Se a lista falhar, usamos a fila segura local.
  const base = live.length ? live : FALLBACK_TEXT_MODELS;
  const preferred = cleanModelName(preferredModel || "gemini-2.5-flash");

  const queue = dedupeModels(base)
    .sort((a, b) => modelRank(a, preferred) - modelRank(b, preferred) || a.localeCompare(b));

  return queue.length ? queue : FALLBACK_TEXT_MODELS.slice();
}

export function isRetryableGeminiError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("500") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("resource_exhausted") ||
    msg.includes("unavailable") ||
    msg.includes("deadline") ||
    msg.includes("not found") ||
    msg.includes("not supported") ||
    msg.includes("permission_denied")
  );
}

/* ==========================================================
   ← NOVO: carrega catecismo-texto.json uma única vez (cache)
   ========================================================== */
let _cicTextos = null;

export async function loadCicTextos() {
  if (_cicTextos) return _cicTextos;
  try {
    const r = await fetch("./referencias/catecismo-texto.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    _cicTextos = await r.json();
  } catch (e) {
    console.warn("catecismo-texto.json não carregado:", e.message);
    _cicTextos = {};
  }
  return _cicTextos;
}

/* ==========================================================
   Monta o bloco de §§ reais para injetar no prompt catecismo
   ========================================================== */
export async function buildCicBlock(cicNums = []) {
  if (!cicNums.length) return "";
  const textos = await loadCicTextos();
  const linhas = cicNums
    .filter(n => textos[String(n)])
    .map(n => `§ ${n}: "${textos[String(n)]}"`)
    .join("\n\n");
  return linhas;
}

/* ==========================================================
   callGemini — sem alteração
   ========================================================== */
export async function callGemini({ apiKey, model, userPrompt, onChunk }) {
  if (!apiKey) throw new Error("Sem chave");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 4096 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_ONLY_HIGH" }
    ]
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini erro ${resp.status}: ${err.slice(0, 200)}`);
  }

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buf  = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const data = JSON.parse(json);
        const cand = data?.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
        if (text) { full += text; onChunk?.(full); }
        if (cand?.finishReason && cand.finishReason !== "STOP") {
          const aviso = `

⚠️ Resposta encerrada pelo modelo: ${cand.finishReason}. Se ficou incompleta, selecione menos versículos ou peça uma resposta mais objetiva.`;
          if (!full.includes(aviso)) { full += aviso; onChunk?.(full); }
        }
      } catch (e) { /* ignora chunk parcial */ }
    }
  }
  // processa qualquer linha restante no buffer após o stream fechar
  if (buf.trim().startsWith("data:")) {
    try {
      const json = buf.trim().slice(5).trim();
      if (json && json !== "[DONE]") {
        const data = JSON.parse(json);
        const cand = data?.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || "").join("");
        if (text) { full += text; onChunk?.(full); }
      }
    } catch {}
  }
  return full;
}

/* ==========================================================
   buildPrompt — ← CORRIGIDO: aceita cicBlock opcional
   ========================================================== */
export function buildPrompt(kind, ref, txt, cicBlock = "") {
  const fn = PROMPTS[kind];
  if (!fn) throw new Error("Prompt desconhecido: " + kind);
  // catecismo recebe cicBlock; os demais ignoram o 4º argumento
  return fn(ref, txt, cicBlock);
}

export function buildLectioPrompt(step, ref, txt) {
  const fn = LECTIO_PROMPTS[step];
  if (!fn) throw new Error("Etapa desconhecida");
  return fn(ref, txt);
}

/* ==========================================================
   mdToHtml — sem alteração
   ========================================================== */
export function mdToHtml(md) {
  let h = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  h = h.replace(/^## (.+)$/gm,  "<h3>$1</h3>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*(.+?)\*/g,    "<em>$1</em>");
  h = h.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  h = h.replace(/(<li>.*<\/li>\n?)+/g, b => `<ul>${b}</ul>`);
  h = h.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  const blocks = h.split(/\n{2,}/);
  h = blocks.map(b => {
    if (/^<(h[23]|ul|ol|li)/.test(b.trim())) return b;
    return `<p>${b.replace(/\n/g, "<br>")}</p>`;
  }).join("\n\n");
  return h;
}