#!/usr/bin/env node
/**
 * Lectio — verificação de imports não usados em main.js.
 *
 * Lê js/main.js, extrai todos os símbolos importados nomeadamente, e
 * confere que cada um aparece pelo menos uma vez fora do bloco de import.
 *
 * Pega regressões do tipo: "alguém adicionou um import durante refatoração
 * mas esqueceu de remover quando a função deixou de ser usada".
 *
 * Como rodar:
 *   node tests/main-imports.test.mjs
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = resolve(here, "..", "js", "main.js");
const code = await readFile(mainPath, "utf8");

// Extrai imports nomeados: `import { a, b as c } from "..."`.
const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
const imports = [];

let match;
while ((match = importRe.exec(code)) !== null) {
  const block = match[1];
  const source = match[2];
  const symbols = block.split(",").map(s => {
    // Suporta `nome as alias`.
    const trimmed = s.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(/\s+as\s+/);
    return {
      // O alias é o nome usado no código local.
      localName: (parts[1] || parts[0]).trim(),
      source
    };
  }).filter(Boolean);
  imports.push(...symbols);
}

// Marca o final do bloco de imports para procurar uso só depois.
// Usa o último `import ... from ...;` encontrado.
const allImports = [...code.matchAll(/import[\s\S]*?from\s*["'][^"']+["']\s*;?/g)];
const lastImportEnd = allImports.length > 0
  ? allImports[allImports.length - 1].index + allImports[allImports.length - 1][0].length
  : 0;

const codeAfterImports = code.slice(lastImportEnd);

const unused = [];
for (const { localName, source } of imports) {
  // Procura como identificador isolado (palavra inteira).
  const usageRe = new RegExp(`\\b${localName}\\b`);
  if (!usageRe.test(codeAfterImports)) {
    unused.push({ localName, source });
  }
}

if (unused.length === 0) {
  console.log(`✅ ${imports.length} imports verificados, todos em uso.`);
  process.exit(0);
}

console.error(`❌ ${unused.length} import(s) não usado(s) em js/main.js:\n`);
for (const { localName, source } of unused) {
  console.error(`   - ${localName}  ←  ${source}`);
}
console.error("\nRemova ou passe a usar cada um. Imports mortos sujam o código.");
process.exit(1);
