#!/usr/bin/env node
/**
 * Lectio — atualizador seguro de versão/cache.
 *
 * Uso:
 *   node tools/bump-version.mjs lectio-v68-minha-versao
 *
 * Atualiza automaticamente:
 * - VERSION
 * - sw.js / CACHE_NAME
 * - todas as query strings ?v=lectio-v... em HTML/JS selecionados
 * - diag.html
 *
 * Observação: este script atualiza todos os imports versionados conhecidos,
 * inclusive imports internos como main.js -> oracoes.js e oracoes.js -> rosario.js.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const nextVersion = process.argv[2];

if (!nextVersion || !/^lectio-v[\w.-]+$/i.test(nextVersion)) {
  console.error("Informe uma versão válida. Exemplo: node tools/bump-version.mjs lectio-v68-ajuste-cache");
  process.exit(1);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const touched = [];

async function update(file, replacers) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    console.warn(`⚠️  Ignorado, arquivo não existe: ${file}`);
    return;
  }

  let text = await readFile(path, "utf8");
  const before = text;

  for (const [pattern, replacement] of replacers) {
    text = text.replace(pattern, replacement);
  }

  if (text !== before) {
    await writeFile(path, text, "utf8");
    touched.push(file);
  }
}

const versionedImportRe = /\?v=lectio-v[\w.-]+/g;
const anyLectioVersionRe = /lectio-v[\w.-]+/g;

await writeFile(resolve(root, "VERSION"), `${nextVersion}\n`, "utf8");
touched.push("VERSION");

await update("sw.js", [
  [/const\s+CACHE_NAME\s*=\s*["'][^"']+["'];/, `const CACHE_NAME = "${nextVersion}";`]
]);

// Arquivos que podem carregar módulos/diagnósticos com query string de cache.
for (const file of [
  "index.html",
  "diag.html",
  "js/main.js",
  "js/oracoes.js"
]) {
  await update(file, [
    [versionedImportRe, `?v=${nextVersion}`]
  ]);
}

// O diagnóstico também exibe a versão esperada em textos livres.
await update("diag.html", [
  [anyLectioVersionRe, nextVersion]
]);

console.log("✅ Versão atualizada:", nextVersion);
console.log("Arquivos alterados:");
for (const file of [...new Set(touched)]) console.log("-", file);
