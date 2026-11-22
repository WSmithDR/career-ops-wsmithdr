#!/usr/bin/env node
/**
 * apply.mjs — wrapper unificado para preparar una aplicación a una vacante.
 *
 * Uso:
 *   node scripts/apply.mjs <url-o-numero-de-reporte>
 *   pnpm run apply <url-o-numero-de-reporte>
 *
 * Delegue en automation/prepare-application.mjs que hace el trabajo real:
 * reporte, CV adaptado, carta de presentación y borrador de correo.
 * Nunca envía correos ni rellena formularios.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('Uso: node scripts/apply.mjs <url-o-numero-de-reporte> [--assist]');
  console.error('Ejemplo: node scripts/apply.mjs 002');
  console.error('Ejemplo: node scripts/apply.mjs https://empresa.com/jobs/123 --assist');
  console.error('Default: prepara borrador local. --assist abre flujo Playwright con confirmación humana explícita.');
  process.exit(64);
}

const assist = process.argv.includes('--assist');
const REPO = resolve(process.cwd(), '..');
try {
  execFileSync('node', [assist ? 'scripts/apply-assist.mjs' : 'automation/prepare-application.mjs', arg], {
    cwd: REPO,
    stdio: 'inherit',
  });
} catch (e) {
  process.exit(e.code || 1);
}
