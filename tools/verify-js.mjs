#!/usr/bin/env node
/**
 * Lectio — verificação rápida de sintaxe JS.
 *
 * Uso:
 *   node tools/verify-js.mjs
 */

import { spawnSync } from "node:child_process";

const files = [
  "js/crypto.js",
  "js/firebase-config.example.js",
  "js/firebase-config.js",
  "js/gemini.js",
  "js/main.js",
  "js/oracoes.js",
  "js/rosario.js",
  "js/share-image.js",
  "js/reader.js",
  "js/search.js",
  "js/storage.js",
  "js/util.js",
  "sw.js"
];

let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status === 0) {
    console.log(`✅ ${file}`);
  } else {
    failed = true;
    console.error(`❌ ${file}`);
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.error(result.stdout.trim());
  }
}

if (failed) process.exit(1);
console.log("\nTudo certo: sintaxe JS validada.");
