#!/usr/bin/env node
/**
 * apply-pipeline.mjs — prepara aplicaciones para todas las ofertas pendientes
 * en data/pipeline.md, una por una, usando prepare-application.mjs.
 *
 * Lee la sección "## Pending" de data/pipeline.md, extrae cada URL que no esté
 * tachada (no empiece con ~~), y ejecuta prepare-application.mjs para cada una.
 *
 * Úsalo después de un scan para dejar listos todos los borradores de aplicación
 * de una sola pasada.
 *
 * Uso:
 *   node scripts/apply-pipeline.mjs [--limit N]
 *   pnpm run apply-pipeline [--limit N]
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const PIPELINE = join(REPO, 'data', 'pipeline.md');

const argv = process.argv.slice(2);
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(argv[limitArg + 1]) : Infinity;

if (!existsSync(PIPELINE)) {
  console.error(`apply-pipeline: no existe ${PIPELINE}. Ejecuta primero node scan.mjs`);
  process.exit(1);
}

const content = readFileSync(PIPELINE, 'utf8');

function repoNode(script, ...args) {
  const full = [script, ...args].filter(Boolean);
  try {
    return execFileSync('node', full, { cwd: REPO, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    const msg = stderr || String(e.message || e).trim();
    throw new Error(`apply-pipeline: \`node ${full.join(' ')}\` falló\n${msg}`);
  }
}

function extractPendingUrls(text) {
  const urls = [];
  const lines = text.split('\n');
  let inPending = false;
  for (const line of lines) {
    if (line.trim() === '## Pending') { inPending = true; continue; }
    if (inPending && line.trim().startsWith('##')) break;
    if (!inPending) continue;
    // Línea de tarea: "- [ ] url | company | role ..." o "- [x] ~~url~~ ..."
    const m = line.match(/^- \[[x ]\]\s+(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    // Si está tachada (~~url~~), saltar
    if (rest.startsWith('~~')) continue;
    const urlPart = rest.split('|')[0].trim();
    if (urlPart.startsWith('http')) urls.push(urlPart);
  }
  return urls;
}

const urls = extractPendingUrls(content);
if (urls.length === 0) {
  console.log('apply-pipeline: no hay ofertas pendientes en data/pipeline.md');
  process.exit(0);
}

const toProcess = urls.slice(0, LIMIT);
console.log(`apply-pipeline: ${urls.length} pendientes, procesando ${toProcess.length} (--limit ${LIMIT})`);

let ok = 0, fail = 0;
for (const url of toProcess) {
  console.log(`\n── ${url} ──`);
  try {
    repoNode('automation/prepare-application.mjs', url);
    ok++;
  } catch (e) {
    console.error(`  ❌ ${String(e.message).slice(0, 200)}`);
    fail++;
  }
}

console.log(`\napply-pipeline: listo. ${ok} OK, ${fail} falló, ${urls.length - toProcess.length} pendientes restantes`);
process.exit(fail > 0 && ok === 0 ? 1 : 0);
