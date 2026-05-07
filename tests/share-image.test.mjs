#!/usr/bin/env node
/**
 * Lectio — smoke test do share-image.js.
 *
 * Garante:
 *  1. Módulo importa sem erro.
 *  2. Exporta as funções da API pública esperadas.
 *  3. buildShareFilename normaliza referências em filenames seguros.
 *  4. buildSharePreviewHtml escapa caracteres perigosos.
 *  5. renderVerseShareCanvas valida ausência de texto/referência.
 *
 * Não exige libs externas (canvas/jsdom) — usa stubs leves para o DOM.
 *
 * Como rodar:
 *   node tests/share-image.test.mjs
 */

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error("   →", err?.message || err);
    failed++;
  }
}

// Stub mínimo de DOM para o módulo importar e rodar validações de erro.
// O fluxo real de renderização exige canvas real e é exercitado no navegador.
globalThis.document = {
  createElement(tag) {
    if (tag === "canvas") {
      // Retorna objeto que vai falhar em getContext — mas validações de erro
      // em renderVerseShareCanvas disparam ANTES de chegar no canvas, que é
      // o que esse smoke test exercita.
      return {
        getContext: () => {
          throw new Error("Canvas real não disponível em Node — esperado neste smoke test.");
        }
      };
    }
    return {};
  }
};

const mod = await import("../js/share-image.js");

test("exporta API pública esperada", () => {
  const expected = [
    "buildShareFilename",
    "buildSharePreviewHtml",
    "renderVerseShareCanvas",
    "createVerseShareImage",
    "downloadVerseShareImage"
  ];
  for (const name of expected) {
    assert.equal(typeof mod[name], "function", `esperava função: ${name}`);
  }
});

test("buildShareFilename normaliza referência simples", () => {
  assert.equal(mod.buildShareFilename("Gênesis 1,1"), "lectio-genesis-1-1.png");
});

test("buildShareFilename lida com intervalo de versículos", () => {
  assert.equal(mod.buildShareFilename("Salmos 23,1-6"), "lectio-salmos-23-1-6.png");
});

test("buildShareFilename remove acentos e símbolos", () => {
  assert.equal(mod.buildShareFilename("João 14:6 — único caminho"), "lectio-joao-14-6-unico-caminho.png");
});

test("buildShareFilename usa fallback para entrada vazia", () => {
  assert.equal(mod.buildShareFilename(""), "lectio-versiculo.png");
  assert.equal(mod.buildShareFilename("!!!@@##"), "lectio-versiculo.png");
  assert.equal(mod.buildShareFilename(undefined), "lectio-versiculo.png");
});

test("buildSharePreviewHtml escapa caracteres HTML perigosos", () => {
  const html = mod.buildSharePreviewHtml({
    text: '<script>alert("xss")</script>',
    reference: "Gn 1,1",
    translation: "Ave-Maria & Pastoral"
  });
  assert.ok(!html.includes("<script>"), "tag <script> não deveria aparecer crua");
  assert.ok(html.includes("&lt;script&gt;"), "deveria escapar < e >");
  assert.ok(html.includes("&amp;"), "deveria escapar & no nome da tradução");
});

test("buildSharePreviewHtml lida com campos ausentes", () => {
  const html = mod.buildSharePreviewHtml({ reference: "Mt 5,3" });
  assert.ok(html.includes("Mt 5,3"));
  assert.ok(!html.includes("<p>"), "sem <p> quando texto ausente");
  assert.ok(!html.includes("<small>"), "sem <small> quando tradução ausente");
});

test("renderVerseShareCanvas rejeita texto ausente", () => {
  assert.throws(
    () => mod.renderVerseShareCanvas({ reference: "Gn 1,1" }),
    /Texto do versículo ausente/
  );
});

test("renderVerseShareCanvas rejeita referência ausente", () => {
  assert.throws(
    () => mod.renderVerseShareCanvas({ text: "No princípio…" }),
    /Referência do versículo ausente/
  );
});

test("renderVerseShareCanvas aceita aliases verseText/ref", () => {
  // Apenas valida que aceita os campos alternativos — a falha vem do canvas,
  // não da validação de input.
  assert.throws(
    () => mod.renderVerseShareCanvas({ verseText: "x", ref: "Gn 1,1" }),
    /Canvas real não disponível/
  );
});

console.log(`\n${passed} passou, ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
