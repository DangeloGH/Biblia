#!/usr/bin/env node
/**
 * Lectio — auditoria rápida de integridade dos capítulos locais.
 *
 * Uso:
 *   node tools/audit-data-integrity.mjs
 *   node tools/audit-data-integrity.mjs --strict
 *
 * Por padrão, imprime alertas sem quebrar o build. Com --strict, retorna erro
 * quando encontrar capítulos locais faltando.
 */

import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const strict = process.argv.includes("--strict");

const versions = [
  ["Ave-Maria", "livros.json", "dados"],
  ["Pe. Matos Soares", "livros-ms.json", "dados-ms"],
  ["Douay-Rheims", "livros-en.json", "dados-en"],
  ["LeandroLFE", "livros-leandro.json", "dados-leandro"],
  ["Pastoral", "livros-pastoral.json", "dados-pastoral"],
  ["Biblioteca Expandida", "livros-biblioteca-expandida.json", "dados-biblioteca-expandida"]
];

function legacyUnicodeFolderId(id) {
  return String(id || "").replace(/[^\x00-\x7F]/g, ch => {
    return "#U" + ch.codePointAt(0).toString(16).padStart(4, "0");
  });
}

function bookTries(id) {
  const tries = [id];
  if (id === "canticos") tries.push("cantico-dos-canticos");
  if (id === "cantico-dos-canticos") tries.push("canticos");
  const legacy = legacyUnicodeFolderId(id);
  if (legacy !== id) tries.push(legacy);
  return [...new Set(tries)];
}

async function existsAny(dataDir, livroId, cap) {
  for (const id of bookTries(livroId)) {
    try {
      await access(resolve(root, dataDir, id, `${cap}.json`));
      return true;
    } catch {}
  }
  return false;
}

let totalMissing = 0;

for (const [label, livrosFile, dataDir] of versions) {
  const livros = JSON.parse(await readFile(resolve(root, livrosFile), "utf8"));
  const missing = [];

  for (const livro of livros) {
    const caps = Number(livro.caps || 0);
    for (let cap = 1; cap <= caps; cap++) {
      if (!(await existsAny(dataDir, livro.id, cap))) {
        missing.push(`${livro.id}/${cap}`);
      }
    }
  }

  totalMissing += missing.length;
  if (missing.length === 0) {
    console.log(`✅ ${label}: todos os capítulos locais encontrados.`);
  } else {
    console.warn(`⚠️  ${label}: ${missing.length} capítulo(s) local(is) faltando.`);
    console.warn("   " + missing.slice(0, 30).join(", ") + (missing.length > 30 ? " ..." : ""));
  }
}

if (strict && totalMissing > 0) {
  console.error(`\n❌ Auditoria strict falhou: ${totalMissing} capítulo(s) faltando.`);
  process.exit(1);
}

console.log(`\nResumo: ${totalMissing} capítulo(s) local(is) faltando no total.`);
if (!strict && totalMissing > 0) {
  console.log("Use --strict quando quiser bloquear publicação com capítulos faltando.");
}
