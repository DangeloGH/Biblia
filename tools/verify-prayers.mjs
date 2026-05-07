import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const base = path.join(root, 'dados-oracoes');
const required = ['id', 'titulo', 'categoria', 'tipo', 'texto'];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const indexPath = path.join(base, 'index.json');
if (!existsSync(indexPath)) fail('dados-oracoes/index.json não encontrado');

const index = await readJson(indexPath);
const ids = new Set();
const relatedRefs = [];
let count = 0;

for (const pack of index.packs || []) {
  const file = path.join(base, pack.file || '');
  if (!existsSync(file)) {
    fail(`Arquivo de categoria não encontrado: ${pack.file}`);
    continue;
  }
  const data = await readJson(file);
  if (!Array.isArray(data.items)) {
    fail(`${pack.file} precisa ter items[]`);
    continue;
  }
  for (const item of data.items) {
    count++;
    for (const field of required) {
      if (!item[field]) fail(`${pack.file}: item sem campo obrigatório ${field}`);
    }
    if (ids.has(item.id)) fail(`ID duplicado: ${item.id}`);
    ids.add(item.id);
    if (!Array.isArray(item.tags) || !item.tags.length) fail(`${item.id}: precisa ter tags[]`);
    if (String(item.texto || '').trim().length < 20) fail(`${item.id}: texto muito curto`);
    if (!item.duracao) fail(`${item.id}: precisa ter duracao`);
    if (!item.curadoria?.selo) fail(`${item.id}: precisa ter curadoria.selo`);
    if (!item.curadoria?.familia) fail(`${item.id}: precisa ter curadoria.familia`);
    if (!item.curadoria?.uso) fail(`${item.id}: precisa ter curadoria.uso`);
    for (const rel of item.relacionados || []) relatedRefs.push([item.id, rel]);
  }
}

for (const id of index.featured || []) {
  if (!ids.has(id)) fail(`featured aponta para oração inexistente: ${id}`);
}

for (const [moment, arr] of Object.entries(index.suggestions || {})) {
  for (const id of arr || []) {
    if (!ids.has(id)) fail(`suggestions.${moment} aponta para oração inexistente: ${id}`);
  }
}

for (const [from, rel] of relatedRefs) {
  if (!ids.has(rel)) fail(`${from}: relacionado inexistente: ${rel}`);
}


const rosarioPath = path.join(base, 'rosario-guiado.json');
if (!existsSync(rosarioPath)) {
  fail('dados-oracoes/rosario-guiado.json não encontrado');
} else {
  const rosario = await readJson(rosarioPath);
  const sets = rosario.mystery_sets || {};
  const prayers = rosario.prayers || {};
  for (const key of ['sinal_da_cruz', 'credo', 'pai_nosso', 'ave_maria', 'gloria', 'fatima', 'salve_rainha']) {
    if (!prayers[key]?.title || !prayers[key]?.text) fail(`rosario-guiado: oração obrigatória ausente: ${key}`);
  }
  for (const setId of ['gozosos', 'luminosos', 'dolorosos', 'gloriosos']) {
    const set = sets[setId];
    if (!set?.title) fail(`rosario-guiado: mistérios ausentes: ${setId}`);
    if (!Array.isArray(set?.mysteries) || set.mysteries.length !== 5) fail(`rosario-guiado: ${setId} precisa ter 5 mistérios`);
  }
  for (const [day, setId] of Object.entries(rosario.default_by_weekday || {})) {
    if (!sets[setId]) fail(`rosario-guiado: dia ${day} aponta para mistérios inexistentes: ${setId}`);
  }
}

if (!process.exitCode) {
  console.log(`✓ Devocionário validado: ${count} orações/guias em ${index.packs?.length || 0} categorias.`);
}
