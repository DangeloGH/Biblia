#!/usr/bin/env node
/**
 * Lectio — executor de todos os smoke tests.
 *
 * Como rodar:
 *   node tests/run-all.mjs
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
  .filter(f => f.endsWith(".test.mjs"))
  .sort();

if (tests.length === 0) {
  console.error("Nenhum arquivo *.test.mjs encontrado em tests/.");
  process.exit(1);
}

let failed = 0;

for (const file of tests) {
  console.log(`\n━━━ ${file} ━━━`);
  const result = spawnSync(process.execPath, [resolve(here, file)], {
    stdio: "inherit"
  });
  if (result.status !== 0) failed++;
}

console.log("\n━━━ resumo ━━━");
if (failed === 0) {
  console.log(`✅ ${tests.length} arquivo(s) de teste, todos passaram.`);
} else {
  console.log(`❌ ${failed} de ${tests.length} arquivo(s) com falha.`);
  process.exit(1);
}
