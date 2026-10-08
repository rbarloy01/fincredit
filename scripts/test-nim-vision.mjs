#!/usr/bin/env node
// Prueba REAL de NVIDIA NIM (gratis) leyendo una imagen o un PDF escaneado, antes de depender de él.
//
// Uso:
//   NVIDIA_API_KEY=nvapi-... node scripts/test-nim-vision.mjs "<archivo.pdf|png|jpg>" [--page 1] [--dpi 150] \
//        [--model google/gemma-4-31b-it] [--expect "102,093,545;7,746,674;357,117,315"]
//
// Muestra: código HTTP, tiempo, tamaño del payload, la respuesta del modelo y cuántas de las cifras que esperas aparecieron.
// La llave se lee del entorno y nunca se imprime.

import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const file = args.find(a => !a.startsWith('--') && (existsSync(a)));
const key = process.env.NVIDIA_API_KEY;

if (!key) { console.error('Falta NVIDIA_API_KEY. Ejemplo: NVIDIA_API_KEY=nvapi-... node scripts/test-nim-vision.mjs estado.pdf'); process.exit(1); }
if (!file) { console.error('Indica un archivo existente (.pdf, .png o .jpg).'); process.exit(1); }

let imagePath = file;
if (/\.pdf$/i.test(file)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nim-test-'));
  const out = path.join(dir, 'page');
  const page = String(flag('page', '1'));
  execFileSync('pdftoppm', ['-r', String(flag('dpi', '150')), '-jpeg', '-jpegopt', 'quality=70', '-f', page, '-l', page, file, out]);
  imagePath = execFileSync('sh', ['-c', `ls ${dir}/page*.jpg | head -1`]).toString().trim();
}
const bytes = readFileSync(imagePath);
const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
const expected = String(flag('expect', '')).split(';').map(s => s.trim()).filter(Boolean);
const models = flag('model') ? [flag('model')] : ['google/gemma-4-31b-it', 'meta/llama-3.2-90b-vision-instruct', 'meta/llama-3.2-11b-vision-instruct'];

console.log(`Imagen: ${imagePath} · ${(bytes.length / 1024).toFixed(0)} KB (base64 ≈ ${(dataUrl.length / 1024).toFixed(0)} KB)`);

for (const model of models) {
  const body = {
    model,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: 'Transcribe TODAS las líneas de este estado financiero como JSON: {"lineas":[{"cuenta":"...","importe":0}]}. Conserva los importes exactamente como aparecen (con signo y separadores). Devuelve solo JSON.' },
    ] }],
    temperature: 0,
    max_tokens: 4096,
  };
  const started = Date.now();
  let res; let text = '';
  try {
    res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    text = await res.text();
  } catch (error) { console.log(`\n[${model}] error de red: ${error.message}`); continue; }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[${model}] HTTP ${res.status} en ${secs}s`);
  if (!res.ok) { console.log(`  ${text.slice(0, 300)}`); console.log(res.status === 403 ? '  → este modelo pide registro aparte en build.nvidia.com (abre su página y acepta los términos).' : ''); continue; }
  const answer = JSON.parse(text).choices?.[0]?.message?.content || '';
  console.log(answer.slice(0, 1200));
  if (expected.length) {
    const flat = answer.replace(/\s/g, '');
    const hits = expected.filter(e => flat.includes(e.replace(/\s/g, '')));
    console.log(`\n  Cifras esperadas encontradas: ${hits.length}/${expected.length}${hits.length < expected.length ? ` · faltan: ${expected.filter(e => !hits.includes(e)).join(', ')}` : ''}`);
  }
  break; // el primer modelo que responde es suficiente para la prueba
}
