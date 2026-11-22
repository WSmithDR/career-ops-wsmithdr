#!/usr/bin/env node
/**
 * scripts/scheduler-status.mjs — Estado del programador automático de career-ops.
 *
 * Muestra:
 *   - Última ejecución exitosa
 *   - Tareas pendientes en la cola
 *   - Tareas fallidas
 *   - Próxima ejecución programada (cron/systemd)
 *
 * Uso:
 *   node scripts/scheduler-status.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const STATE_FILE = join(DATA_ROOT, 'data', 'auto-run-state.json');
const QUEUE_FILE = join(DATA_ROOT, 'data', 'auto-queue.json');
const LOG_FILE = join(DATA_ROOT, 'data', 'auto-run.log');

function loadJson(path, def) {
  if (!existsSync(path)) return def;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return def; }
}

function main() {
  const state = loadJson(STATE_FILE, { lastRun: 'nunca', dryRun: false });
  const queue = loadJson(QUEUE_FILE, { pending: [], completed: [], failed: [] });

  console.log('═══ career-ops Scheduler Status ═══');
  console.log('');
  console.log('Última ejecución:');
  console.log(`  Fecha:      ${state.lastRun}`);
  console.log(`  Modo:       ${state.scan || 'desconocido'}`);
  console.log(`  Dry-run:    ${state.dryRun ? 'sí' : 'no'}`);
  console.log('');
  console.log('Cola de tareas:');
  console.log(`  Pendientes: ${queue.pending.length}`);
    for (const t of queue.pending.slice(0, 10)) {
      const created = t.created || t.createdAt || '';
      console.log(`    • ${t.action} — ${t.target || ''} (creado: ${created.slice(0, 16)})`);
    }
  if (queue.pending.length > 10) {
    console.log(`    ... y ${queue.pending.length - 10} más`);
  }
  console.log(`  Completadas: ${queue.completed.length}`);
  console.log(`  Fallidas:    ${queue.failed.length}`);
  for (const t of queue.failed.slice(0, 5)) {
    console.log(`    ✗ ${t.action} — ${t.target || ''} (${t.error || 'sin error'})`);
  }
  console.log('');
  console.log('Logs recientes:');
  if (existsSync(LOG_FILE)) {
    const lines = readFileSync(LOG_FILE, 'utf-8').split('\n').filter(l => l.trim());
    for (const l of lines.slice(-5)) {
      console.log(`  ${l.slice(0, 120)}`);
    }
  } else {
    console.log('  (sin logs aún)');
  }
  console.log('');
  console.log('Para instalar el temporizador automático:');
  console.log('  sudo cp config/career-ops-scan.service /etc/systemd/system/');
  console.log('  sudo cp config/career-ops-scan.timer /etc/systemd/system/');
  console.log('  sudo systemctl daemon-reload');
  console.log('  sudo systemctl enable --now career-ops-scan.timer');
  console.log('');
  console.log('O con crontab (cada 6 horas):');
  console.log('  0 */6 * * * /usr/bin/node /home/wagner/Documents/career-ops-wsmithdr/scripts/auto-run.mjs');
}

main();
