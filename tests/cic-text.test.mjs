// tests/cic-text.test.mjs
// Teste anti-regressão: garante que catecismo-texto.json não tem parágrafos
// começando com notas de rodapé bibliográficas, e que todos os §§ referenciados
// por catecismo.json existem em catecismo-texto.json.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error("  ✗", msg); }
}

const cicTextoPath = join(ROOT, "referencias", "catecismo-texto.json");
const cicMapaPath = join(ROOT, "referencias", "catecismo.json");

const cicTexto = JSON.parse(await readFile(cicTextoPath, "utf-8"));
const cicMapa = JSON.parse(await readFile(cicMapaPath, "utf-8"));

console.log("== Teste 1: parágrafos não começam com notas de rodapé bibliográficas ==");
// Padrões que indicam contaminação por nota de rodapé
const PADROES_NOTA = [
  /^\s*Cf\.\s/i,
  /^\s*Ibid\./i,
  /^\s*\d+\.\s+(II|Sant[oa]|São|Concílio|AAS|SC\s|PL\s|CCL\s|Pio\s|Paulo\s|João Paulo|Tertuliano|Origenes|Bento|Clemente|Hermas|Aristides|Justino|Hilário|Ambrósio|Agostinho|Tomás|Gregório|Damasceno|Cirilo|Inácio|Ireneu|Crisóstomo|Atanásio|Basílio|Cipriano|Hipólito|Orígenes|Romano|Máximo|Anastásio|Hormisda|Pelágio|Leão|Símbolo|CIC\s|Cat\s|CatRom)/,
];

const contaminados = [];
for (const [num, val] of Object.entries(cicTexto)) {
  const texto = typeof val === "string" ? val : (val.texto || val.text || "");
  for (const padrao of PADROES_NOTA) {
    if (padrao.test(texto)) {
      contaminados.push({ num, inicio: texto.slice(0, 80) });
      break;
    }
  }
}
assert(contaminados.length === 0,
  `${contaminados.length} parágrafos contaminados:\n` +
  contaminados.slice(0, 10).map(c => `      § ${c.num}: ${JSON.stringify(c.inicio)}`).join("\n")
);

console.log("== Teste 2: todos os §§ referenciados existem em catecismo-texto.json ==");
// Formato: { "livro/cap/vers": [{ num: "123", tema: "..." }, ...] }
const referenciados = new Set();
for (const refs of Object.values(cicMapa)) {
  if (Array.isArray(refs)) {
    for (const r of refs) {
      const num = typeof r === "object" && r !== null ? String(r.num) : String(r);
      if (num && num !== "undefined") referenciados.add(num);
    }
  }
}
const faltantes = [...referenciados].filter(n => !(n in cicTexto));
assert(faltantes.length === 0, `${faltantes.length} §§ referenciados não existem: ${faltantes.slice(0, 10).join(", ")}`);

console.log("== Teste 3: nenhum parágrafo fora do range oficial (1-2865) ==");
const foraDoRange = Object.keys(cicTexto).filter(n => {
  const i = parseInt(n, 10);
  return isNaN(i) || i < 1 || i > 2865;
});
assert(foraDoRange.length === 0, `parágrafos fora do range: ${foraDoRange.join(", ")}`);

console.log("== Teste 4: parágrafos críticos foram corrigidos ==");
// Parágrafos com mais referências cruzadas que estavam contaminados
const criticos = [574, 162, 992, 591, 84, 627];
for (const n of criticos) {
  const texto = cicTexto[String(n)];
  const t = typeof texto === "string" ? texto : (texto?.texto || "");
  assert(t && t.length > 50, `§ ${n} existe e tem texto substancial`);
  assert(!/^\s*Cf\.\s/i.test(t), `§ ${n} não começa com "Cf. "`);
  assert(!/^\s*\d+\.\s+(II|São|Concílio)/.test(t), `§ ${n} não começa com nota numerada`);
}

console.log(`\n${pass} asserts passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
