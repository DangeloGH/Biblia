import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const rosario = read('dados-oracoes/rosario.json');
const guided = read('dados-oracoes/tercos-guiados.json');
const items = Array.isArray(rosario.items) ? rosario.items : [];
const guides = guided.guides || {};
const common = guided.common_prayers || {};
let errors = 0;

function fail(msg) {
  console.error('✗ ' + msg);
  errors += 1;
}

for (const item of items) {
  if (!guides[item.id]) fail(`Item de Rosário/Terço sem guia: ${item.id}`);
}

for (const [id, guide] of Object.entries(guides)) {
  if (!items.some(item => item.id === id)) fail(`Guia sem item correspondente em rosario.json: ${id}`);
  if (!guide.title || !guide.intro) fail(`Guia incompleto: ${id}`);
  if (!Array.isArray(guide.groups) || !guide.groups.length) fail(`Guia sem grupos: ${id}`);

  for (const token of guide.start || []) {
    if (typeof token === 'string' && !common[token]) fail(`Guia ${id} usa oração comum inexistente no início: ${token}`);
    if (token && typeof token === 'object' && token.repeat && !common[token.repeat]) fail(`Guia ${id} repete oração comum inexistente: ${token.repeat}`);
  }
  for (const token of guide.ending || []) {
    if (typeof token === 'string' && !common[token]) fail(`Guia ${id} usa oração comum inexistente no fim: ${token}`);
  }
}

if (errors) {
  console.error(`\n${errors} erro(s) encontrados nos terços guiados.`);
  process.exit(1);
}

console.log(`✓ Terços/Rosários guiados validados: ${items.length} item(ns) cobertos por ${Object.keys(guides).length} guia(s).`);
