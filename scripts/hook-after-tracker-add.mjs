#!/usr/bin/env node
/**
 * scripts/hook-after-tracker-add.mjs — crea borrador de email y programa
 * follow-up después de agregar una entrada al tracker.
 *
 * Recibe número de tracker y reporte como argumentos:
 *   node scripts/hook-after-tracker-add.mjs <numero-tracker> <numero-reporte>
 *
 * Crea:
 *   output/email-{tracker}.md  — borrador de email de aplicación
 *   data/follow-ups.md         — primera fecha de follow-up (J+7 días)
 *
 * Config en config/hooks.yml:
 *   hooks:
 *     after-tracker-add:
 *       - scripts/hook-after-tracker-add.mjs
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { getCareerOpsRoot } = await import('../path-resolver.mjs');
const DATA_ROOT = getCareerOpsRoot();
const TRACKER = join(DATA_ROOT, 'data', 'applications.md');
const OUTPUT = join(DATA_ROOT, 'output');
const FOLLOWUPS = join(DATA_ROOT, 'data', 'follow-ups.md');

const trackerNum = process.argv[2];
const reportNum = process.argv[3];

if (!trackerNum) {
  console.error('Uso: node scripts/hook-after-tracker-add.mjs <numero-tracker> [numero-reporte]');
  process.exit(1);
}

// Buscar la fila en el tracker para obtener company y role
let company = '', role = '', url = '';
if (existsSync(TRACKER)) {
  const text = readFileSync(TRACKER, 'utf-8');
  for (const line of text.split('\n')) {
    const m = line.match(/\|\s*(\d+)\s*\|/);
    if (m && m[1].trim() === trackerNum.trim()) {
      const parts = line.split('|').map(s => s.trim());
      // columnas: # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL
      company = parts[2] || '';
      role = parts[3] || '';
      url = parts[9] || parts[parts.length - 1] || '';
      break;
    }
  }
}

// Crear borrador de email
mkdirSync(OUTPUT, { recursive: true });
const emailPath = join(OUTPUT, `email-${trackerNum}.md`);
const today = new Date().toISOString().slice(0, 10);
const email = `# Aplicación #${trackerNum} — ${company}

**Fecha:** ${today}
**Role:** ${role}
**URL:** ${url}

Asunto: Aplicación — ${role} — ${company}

Estimado equipo de ${company},

Me dirijo a ustedes con interés en la posición de ${role} publicada en su portal de empleos.

Adjunto encontrarán mi CV y una carta de presentación adaptada a este rol. Quedo a su disposición para conversar sobre cómo mi experiencia puede aportar valor a su equipo.

Saludos cordiales,

[Tu nombre]
[Tu email]
`;
writeFileSync(emailPath, email);

// Programar follow-up en 7 días
const followUpDate = new Date();
followUpDate.setDate(followUpDate.getDate() + 7);
const followUpStr = followUpDate.toISOString().slice(0, 10);

mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
const followUpLine = `${today}\t${trackerNum}\t${company}\t${role}\t${followUpStr}\tfirst-follow-up\tpendiente\n`;
if (!existsSync(FOLLOWUPS)) {
  writeFileSync(FOLLOWUPS, 'Date\tTracker#\tCompany\tRole\tFollowUpDate\tType\tStatus\n' + followUpLine);
} else {
  writeFileSync(FOLLOWUPS, followUpLine, { flag: 'a' });
}

console.log(`🪝 Hook after-tracker-add: #${trackerNum} — borrador en output/email-${trackerNum}.md`);
console.log(`   Follow-up programado para ${followUpStr}`);
console.log(`   ${company} | ${role}`);
