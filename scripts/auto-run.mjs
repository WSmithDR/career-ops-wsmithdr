#!/usr/bin/env node
/**
 * scripts/auto-run.mjs — Ejecuta el flujo completo de carrera-ops de forma automática.
 *
 * Secuencia:
 *   1. scan.mjs                           (busca ofertas nuevas, dispara hooks before/after-scan)
 *   2. evaluate-pending.mjs               (evalúa ofertas pendientes en pipeline, dispara after-evaluate)
 *   3. merge-tracker.mjs                  (mueve TSVs al tracker, dispara after-tracker-add + learn-keywords)
 *
 * Diseñado para ejecutarse desde cron/systemd sin supervisión.
 * Toda la lógica es advisory: nunca aplica automáticamente, solo prepara.
 *
 * Uso:
 *   node scripts/auto-run.mjs [--limit N]   # evalúa máximo N ofertas pendientes
 *   node scripts/auto-run.mjs --scan-only   # solo escanea, no evalúa
 *   node scripts/auto-run.mjs --eval-only   # solo evalúa pendientes, no escanea
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const QUEUE_FILE = join(DATA_ROOT, 'data', 'auto-queue.json');
const STATE_FILE = join(DATA_ROOT, 'data', 'auto-run-state.json');

const KNOWN_FLAGS = ['--limit', '--scan-only', '--eval-only', '--help', '-h', '--dry-run'];
const VALUE_FLAGS = ['--limit'];

const USAGE = `Usage:
  node scripts/auto-run.mjs [--limit N] [--scan-only] [--eval-only] [--dry-run]
  --limit N     evaluar máximo N ofertas pendientes del pipeline
  --scan-only   solo ejecutar node scan.mjs
  --eval-only   solo evaluar ofertas pendientes (no escanea)
  --dry-run     modo preview, no escribe archivos
  --help, -h    esta ayuda
`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan-only');
const EVAL_ONLY = args.includes('--eval-only');
const LIMIT_ARG = args.find((a) => a === '--limit' || a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1] || args[args.indexOf(LIMIT_ARG) + 1]) : Infinity;

function flagValue(arr, flag) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === flag && arr[i + 1] && !arr[i + 1].startsWith('--')) return arr[i + 1];
  }
  return undefined;
}

// ── Cola de tareas persistente ──────────────────────────────────────

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { pending: [], completed: [], failed: [] };
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  } catch { return { pending: [], completed: [], failed: [] }; }
}

function saveQueue(q) {
  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), 'utf-8');
}

function enqueue(task) {
  const q = loadQueue();
  q.pending.push({ ...task, id: Date.now() + Math.random(), created: new Date().toISOString() });
  saveQueue(q);
  console.log(`📥 Tarea encolada: ${task.action} — ${task.target || ''}`);
}

function processQueue() {
  const q = loadQueue();
  let ran = 0;
  const stillPending = [];

  for (const t of q.pending) {
    try {
      console.log(`▶ Ejecutando tarea encolada: ${t.action} — ${t.target || ''}`);
      execFileSync(process.execPath, t.cmd, {
        stdio: 'inherit',
        env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
        timeout: 300_000,
      });
      ran++;
    } catch (err) {
      console.warn(`⚠ Tarea falló: ${t.action} — ${err.message}`);
      q.failed.push({ ...t, error: err.message, failedAt: new Date().toISOString() });
      continue;
    }
  }

  q.completed.push(...q.pending.slice(0, ran));
  q.pending = stillPending.length ? stillPending : [];
  saveQueue(q);
  return { ran, pending: q.pending.length, failed: q.failed.length };
}

// ── Ejecutar comandos ───────────────────────────────────────────────

function run(cmd, args = []) {
  if (DRY_RUN) {
    console.log(`[dry-run] node ${cmd} ${args.join(' ')}`);
    return { ok: true };
  }
  try {
    execFileSync(process.execPath, [cmd, ...args], {
      stdio: 'inherit',
      env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
      timeout: 300_000,
    });
    return { ok: true };
  } catch (err) {
    console.error(`✗ Falló: node ${cmd} ${args.join(' ')} — ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });

  // Si hay tareas pendientes de una ejecución anterior interrumpida, procesarlas primero
  const q = loadQueue();
  if (q.pending.length > 0) {
    console.log(`🔄 Recuperando ${q.pending.length} tarea(s) pendiente(s) de ejecución anterior…`);
    const res = processQueue();
    console.log(`   Recuperadas: ${res.ran} ejecutadas, ${res.pending} pendientes, ${res.failed} fallidas`);
  }

  if (EVAL_ONLY) {
    // Solo evaluar ofertas pendientes del pipeline
    console.log('🔍 Modo eval-only: evaluando ofertas pendientes…');
    // Las ofertas se evalúan una por una vía evaluate-url.mjs; aquí solo dispararíamos si hay TSVs
    // El merge-tracker ya cubre after-tracker-add
    run('merge-tracker.mjs');
    run('scripts/hook-learn-negative-keywords.mjs');
    return;
  }

  if (!SCAN_ONLY) {
    // 1. Escanear
    console.log('🔍 Paso 1/3: Escaneando portales…');
    const scanRes = run('scan.mjs', DRY_RUN ? ['--dry-run'] : []);
    if (!scanRes.ok && !DRY_RUN) {
      // Si el scan falló, encolar para reintento
      enqueue({ action: 'scan', target: 'portals', cmd: ['scan.mjs'] });
    }
  }

  if (SCAN_ONLY) {
    console.log('✅ Scan-only completado.');
    return;
  }

  // 2. Evaluar ofertas pendientes del pipeline
  console.log('\n📋 Paso 2/3: Evaluando ofertas pendientes del pipeline…');
  const pipeline = join(DATA_ROOT, 'data', 'pipeline.md');
  if (existsSync(pipeline)) {
    const text = readFileSync(pipeline, 'utf-8');
    const pendingUrls = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^- \[ \]\s+(https?:\/\/[^|]+)\|/);
      if (m) pendingUrls.push(m[1].trim());
    }

    let evaluated = 0;
    for (const url of pendingUrls) {
      if (evaluated >= LIMIT) break;
      // Extraer número de reporte siguiente (buscar max existente + 1)
      // Usar reserve-report-num para obtener un número único
      try {
        const reserveOut = execFileSync(process.execPath, ['reserve-report-num.mjs'], {
          stdio: 'pipe',
          env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
          timeout: 30_000,
        }).toString().trim();
        const reportNum = reserveOut;
        console.log(`\n📝 Evaluando: ${url} → reporte #${reportNum}`);
        const res = run('scripts/evaluate-url.mjs', [reportNum, url]);
        if (res.ok) evaluated++;
        else enqueue({ action: 'evaluate', target: url, cmd: ['scripts/evaluate-url.mjs', reportNum, url] });
      } catch (err) {
        console.warn(`⚠ No se pudo reservar número de reporte para ${url}: ${err.message}`);
        enqueue({ action: 'evaluate', target: url, cmd: ['scripts/evaluate-url.mjs', '0', url] });
      }
    }
    console.log(`\n   Evaluadas: ${evaluated} de ${pendingUrls.length} pendientes`);
  }

  // 3. Mover al tracker
  console.log('\n📦 Paso 3/3: Mergando al tracker…');
  const mergeRes = run('merge-tracker.mjs');
  if (!mergeRes.ok && !DRY_RUN) {
    enqueue({ action: 'merge-tracker', target: 'tracker', cmd: ['merge-tracker.mjs'] });
  }

  // 4. Aprender keywords negativas
  console.log('\n🧠 Paso 4/4: Aprendiendo keywords negativas…');
  run('scripts/hook-learn-negative-keywords.mjs');

  // 5. Procesar cola de tareas falladas/pendientes
  console.log('\n♻️ Paso 5/5: Procesando cola de tareas pendientes…');
  const qRes = processQueue();
  console.log(`   Cola: ${qRes.ran} ejecutadas, ${qRes.pending} pendientes, ${qRes.failed} fallidas`);

  // 6. Notificar nuevas ofertas del shortlist por Telegram (opcional, delta)
  console.log('\n📱 Paso 6/6: Notificando shortlist por Telegram…');
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const notifyRes = run('scripts/notify-new-shortlist.mjs');
    if (!notifyRes.ok && !DRY_RUN) {
      console.warn('⚠ Notificación por Telegram falló (verifica TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).');
    }
  } else {
    console.log('   Saltado: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no configurados.');
  }

  // Guardar estado de ejecución
  const state = {
    lastRun: new Date().toISOString(),
    scan: SCAN_ONLY ? 'scan-only' : 'full',
    evaluated: LIMIT === Infinity ? 'all' : LIMIT,
    dryRun: DRY_RUN,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

  console.log('\n✅ Auto-run completado.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
