#!/usr/bin/env node
/**
 * scripts/hook-after-evaluate.mjs — auto-clasifica una oferta por su score
 * después de generar el reporte de evaluación.
 *
 * Uso:
 *   node scripts/hook-after-evaluate.mjs <numero-de-reporte> [ruta-del-reporte]
 *
 * Lee el reporte en reports/{NNN}-*.md, extrae el **Score** y clasifica:
 *   score >= 4.0  → PRIORITARIA (aplicar)
 *   score <= 2.5 o BLOCKED → DESCARTAR (SKIP)
 *   entre medio → REVISAR (decisión manual)
 *
 * Escribe el resultado en data/auto-classified.md.
 *
 * Config en config/hooks.yml:
 *   hooks:
 *     after-evaluate:
 *       - scripts/hook-after-evaluate.mjs
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { getCareerOpsRoot } = await import('../path-resolver.mjs');
const DATA_ROOT = getCareerOpsRoot();
const REPORTS_DIR = join(DATA_ROOT, 'reports');
const CLASSIFIED = join(DATA_ROOT, 'data', 'auto-classified.md');

const reportNum = process.argv[2];
const explicitPath = process.argv[3];

if (!reportNum) {
  console.error('Uso: node scripts/hook-after-evaluate.mjs <numero-de-reporte> [ruta-del-reporte]');
  process.exit(1);
}

const padded = String(reportNum).padStart(3, '0');

// Determinar ruta del reporte
let reportPath = null;
if (explicitPath && existsSync(explicitPath)) {
  reportPath = explicitPath;
} else {
  const files = readdirSync(REPORTS_DIR).filter(f => f.startsWith(`${padded}-`) && f.endsWith('.md'));
  if (files.length === 0) {
    console.error(`No se encontró reporte para #${padded} en reports/`);
    process.exit(1);
  }
  reportPath = join(REPORTS_DIR, files[0]);
}

const text = readFileSync(reportPath, 'utf-8');

// Extraer Score (busca **Score:** X.X/5 — Clasificación)
const scoreMatch = text.match(/\*\*Score:\*\*\s*([^\n]+)/i);
const rawScore = scoreMatch ? scoreMatch[1].trim() : '';
const blocked = /BLOCKED/i.test(rawScore);
const numericMatch = rawScore.match(/(\d+(?:\.\d+)?)/);
const numericScore = numericMatch ? Number(numericMatch[1]) : undefined;

let classification, reason;
if (blocked || (numericScore !== undefined && numericScore <= 2.5)) {
  classification = 'DESCARTAR';
  reason = blocked ? 'Score: BLOCKED' : `Score: ${numericScore}/5 (<= 2.5)`;
} else if (numericScore !== undefined && numericScore >= 4.0) {
  classification = 'PRIORITARIA';
  reason = `Score: ${numericScore}/5 (>= 4.0)`;
} else {
  classification = 'REVISAR';
  reason = numericScore !== undefined ? `Score: ${numericScore}/5` : 'Score no numérico';
}

// Extraer título de la primera línea # NNN — Título
const titleMatch = text.match(/^# \d+ — (.+)\n/);
const title = titleMatch ? titleMatch[1].trim() : 'Sin título';

// Extraer empresa: buscar en tabla markdown | Company | ... | o **Company:**
let company = '?';
const companyTableMatch = text.match(/\|\s*Company\s*\|\s*([^|]+)\|/i);
if (companyTableMatch) {
  company = companyTableMatch[1].trim();
} else {
  const companyLineMatch = text.match(/\*\*Company:\*\*\s*(.+)/i);
  if (companyLineMatch) company = companyLineMatch[1].trim();
}

// Extraer URL
const urlMatch = text.match(/\*\*URL:\*\*\s*(.+)/i);
const url = urlMatch ? urlMatch[1].trim() : '';

mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
const line = `- #${padded} | ${company} | ${title} | ${classification} | ${reason} | ${url} | ${new Date().toISOString().slice(0, 10)}`;
writeFileSync(CLASSIFIED, line + '\n', { flag: 'a' });

console.log(`🪝 Hook after-evaluate: #${padded} → ${classification} (${reason})`);
console.log(`   ${company} | ${title}`);
console.log(`   Registrado en data/auto-classified.md`);
