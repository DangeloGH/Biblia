import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const base = path.join(root, 'dados-oracoes');

function normalize(str = '') {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function inc(obj, key) {
  obj[key || 'sem_valor'] = (obj[key || 'sem_valor'] || 0) + 1;
}

const index = await readJson(path.join(base, 'index.json'));
const byCategory = {};
const byDuration = {};
const bySource = {};
const byFamily = {};
const titles = new Map();
const warnings = [];
let total = 0;

for (const pack of index.packs || []) {
  const data = await readJson(path.join(base, pack.file));
  for (const item of data.items || []) {
    total++;
    inc(byCategory, pack.id);
    inc(byDuration, item.duracao);
    inc(bySource, item.fonte_tipo || item.curadoria?.selo || 'sem_fonte');
    inc(byFamily, item.curadoria?.familia);

    const titleKey = normalize(item.titulo);
    if (titles.has(titleKey)) warnings.push(`Título possivelmente duplicado: ${item.titulo} (${titles.get(titleKey)} e ${item.id})`);
    else titles.set(titleKey, item.id);

    if (!item.quando_rezar) warnings.push(`${item.id}: sem quando_rezar`);
    if (!item.explicacao) warnings.push(`${item.id}: sem explicacao`);
    if (!Array.isArray(item.tags) || item.tags.length < 3) warnings.push(`${item.id}: poucas tags`);
  }
}

console.log('Relatório de conteúdo do Devocionário Lectio');
console.log('='.repeat(48));
console.log(`Total: ${total} orações/guias`);
console.log(`Categorias: ${index.packs?.length || 0}`);
console.log('\nPor categoria:', byCategory);
console.log('\nPor duração:', byDuration);
console.log('\nPor fonte:', bySource);
console.log('\nPor família curatorial:', byFamily);

if (warnings.length) {
  console.log(`\nAvisos (${warnings.length}):`);
  for (const warning of warnings.slice(0, 40)) console.log(`- ${warning}`);
  if (warnings.length > 40) console.log(`... mais ${warnings.length - 40} aviso(s)`);
} else {
  console.log('\nNenhum aviso de conteúdo encontrado.');
}
