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
 *   node scripts/auto-run.mjs [--limit N] [--queue-limit N] [--max-cost N]
 *       [--scan-only] [--eval-only] [--queue-only] [--dry-run]
 *   --limit N       evaluar máximo N ofertas pendientes del pipeline (default: 25)
 *   --queue-limit N procesar máximo N tareas de cola por ejecución (default: 30)
 *   --max-cost N    coste estimado máximo (USD) para esta ejecución (default: sin límite)
 *   --scan-only     solo ejecutar node scan.mjs
 *   --eval-only     solo evaluar ofertas pendientes (no escanea)
 *   --queue-only    solo procesar cola pendiente/fallida con backoff
 *   --dry-run       modo preview, no escribe archivos
 *   --help, -h      esta ayuda
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const QUEUE_FILE = join(DATA_ROOT, 'data', 'auto-queue.json');
const STATE_FILE = join(DATA_ROOT, 'data', 'auto-run-state.json');

function loadTelegramEnv() {
  const f = join(DATA_ROOT, 'config', 'telegram.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    process.env[key] = t.slice(eq + 1).trim();
  }
}
loadTelegramEnv();

const KNOWN_FLAGS = ['--limit', '--scan-only', '--eval-only', '--queue-limit', '--max-cost', '--queue-only', '--help', '-h', '--dry-run'];
const VALUE_FLAGS = ['--limit', '--queue-limit', '--max-cost'];

const USAGE = `Usage:
  node scripts/auto-run.mjs [--limit N] [--queue-limit N] [--max-cost N] [--scan-only] [--eval-only] [--queue-only] [--dry-run]
  --limit N       evaluar máximo N ofertas pendientes del pipeline (default: 25)
  --queue-limit N procesar máximo N tareas de cola por ejecución (default: 10)
  --max-cost N    coste estimado máximo (USD) para esta ejecución (default: sin límite)
  --scan-only     solo ejecutar node scan.mjs
  --eval-only     solo evaluar ofertas pendientes (no escanea)
  --queue-only    solo procesar cola pendiente/fallida con backoff
  --dry-run       modo preview, no escribe archivos
  --help, -h      esta ayuda
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const DRY_RUN = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan-only');
const EVAL_ONLY = args.includes('--eval-only');
const QUEUE_ONLY = args.includes('--queue-only');
const LIMIT_ARG = args.find((a) => a === '--limit' || a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1] || args[args.indexOf(LIMIT_ARG) + 1]) : 25;
const QUEUE_LIMIT_ARG = args.find((a) => a === '--queue-limit' || a.startsWith('--queue-limit='));
const QUEUE_LIMIT = QUEUE_LIMIT_ARG ? Number(QUEUE_LIMIT_ARG.split('=')[1] || args[args.indexOf(QUEUE_LIMIT_ARG) + 1]) : 30;
const MAX_COST_ARG = args.find((a) => a === '--max-cost' || a.startsWith('--max-cost='));
const MAX_COST = MAX_COST_ARG ? Number(MAX_COST_ARG.split('=')[1] || args[args.indexOf(MAX_COST_ARG) + 1]) : Infinity;
const QUEUE_MAX_ATTEMPTS = 3;

// Coste estimado por tipo de tarea (USD, aproximado). Solo se usa para el
// guardado de presupuesto --max-cost; nunca se cobra de verdad aquí.
const COST_PER_ACTION = {
  evaluate: 0.03,
  scan: 0.01,
  'merge-tracker': 0.002,
  notify: 0.001,
};
function costEstimate(action) {
  return COST_PER_ACTION[action] ?? 0.01;
}

function flagValue(arr, flag) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === flag && arr[i + 1] && !arr[i + 1].startsWith('--')) return arr[i + 1];
  }
  return undefined;
}

// ── Cola de tareas persistente ──────────────────────────────────────

const QUEUE_BASE = { version: 2, pending: [], completed: [], failed: [], deadLetter: [] };

function normalizeQueue(q) {
  const inQ = q && typeof q === 'object' ? q : QUEUE_BASE;
  const normItem = (t, status = 'pending') => {
    const target = String(t?.target || t?.cmd?.[2] || '').trim();
    const action = String(t?.action || 'evaluate').trim();
    const dedupeKey = action === 'evaluate' && target ? `evaluate:${normalizeUrl(target)}` : `${action}:${target}`;
    const attempts = Number.isFinite(t?.attempts) ? t.attempts : (status === 'failed' ? 1 : 0);
    const cmd = Array.isArray(t?.cmd) ? [...t.cmd] : [];
    if (action === 'evaluate' && cmd[0] === 'scripts/evaluate-url.mjs') cmd[1] = '__RESERVE__';
    return {
      id: t?.id || `${Date.now()}-${Math.random()}`,
      action,
      target,
      dedupeKey,
      cmd,
      attempts,
      maxAttempts: Number.isFinite(t?.maxAttempts) ? t.maxAttempts : QUEUE_MAX_ATTEMPTS,
      nextAttemptAt: t?.nextAttemptAt || t?.created || new Date().toISOString(),
      lastError: t?.lastError || t?.error || null,
      createdAt: t?.createdAt || t?.created || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status,
      ...(t.deadLetter !== undefined ? { deadLetter: t.deadLetter } : {}),
      ...(t.deadLetterAt ? { deadLetterAt: t.deadLetterAt } : {}),
      ...(t.deadLetterReason ? { deadLetterReason: t.deadLetterReason } : {}),
      ...(t.cost !== undefined ? { cost: t.cost } : {}),
    };
  };
  const pending = Array.isArray(inQ.pending) ? inQ.pending.map((t) => normItem(t, 'pending')) : [];
  const failed = Array.isArray(inQ.failed) ? inQ.failed.map((t) => normItem(t, 'failed')) : [];
  const completed = Array.isArray(inQ.completed) ? inQ.completed.slice(-200) : [];
  const deadLetter = Array.isArray(inQ.deadLetter) ? inQ.deadLetter.map((t) => normItem(t, 'deadLetter')) : [];
  return dedupeQueue({ ...QUEUE_BASE, pending, failed, completed, deadLetter });
}

function dedupeQueue(q) {
  const seen = new Set();
  const dedupe = (arr) => {
    const out = [];
    for (const item of arr) {
      const key = item.dedupeKey || `${item.action}:${item.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };
  q.pending = dedupe(q.pending);
  q.failed = dedupe(q.failed);
  q.deadLetter = dedupe(q.deadLetter);
  return q;
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { ...QUEUE_BASE };
  try {
    return normalizeQueue(JSON.parse(readFileSync(QUEUE_FILE, 'utf-8')));
  } catch { return { ...QUEUE_BASE }; }
}

function saveQueue(q) {
  try {
    mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
    const tmp = `${QUEUE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n', 'utf-8');
    writeFileSync(QUEUE_FILE, readFileSync(tmp, 'utf-8'), 'utf-8');
  } catch (err) {
    console.warn(`⚠ No se pudo guardar cola (${QUEUE_FILE}): ${err.message}`);
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','ref','fbclid','gclid'].forEach((k) => u.searchParams.delete(k));
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch { return String(url || '').trim(); }
}

function enqueue(task) {
  const q = loadQueue();
  const normalized = normalizeQueue({ pending: [{ ...task }], completed: [], failed: [], deadLetter: [] }).pending[0];
  const key = normalized.dedupeKey;
  const exists = [...q.pending, ...q.failed, ...q.deadLetter].some((t) => t.dedupeKey === key);
  if (exists) return { enqueued: false, dedupeKey: key };
  q.pending.push(normalized);
  saveQueue(q);
  console.log(`📥 Tarea encolada: ${normalized.action} — ${normalized.target || ''}`);
  return { enqueued: true, dedupeKey: key };
}

const REPORTS_DIR = join(DATA_ROOT, 'reports');

function reportExistsForUrl(url) {
  if (!existsSync(REPORTS_DIR)) return false;
  const needle = normalizeUrl(url);
  for (const f of readdirSync(REPORTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    try {
      const text = readFileSync(join(REPORTS_DIR, f), 'utf-8');
      const m = text.match(/\*\*URL:\*\*\s*(\S+)/i);
      if (m && normalizeUrl(m[1]) === needle) return true;
    } catch {}
  }
  return false;
}

function reserveReportNum() {
  return execFileSync(process.execPath, ['reserve-report-num.mjs'], {
    stdio: 'pipe', cwd: DATA_ROOT, env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT }, timeout: 30_000,
  }).toString().trim();
}

function releaseReportNum(num) {
  if (!num || !/^\d+$/.test(String(num))) return;
  try {
    execFileSync(process.execPath, ['reserve-report-num.mjs', '--release', String(num)], {
      stdio: 'pipe', cwd: DATA_ROOT, env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT }, timeout: 30_000,
    });
  } catch {}
}

function materializeCmd(task) {
  const cmd = Array.isArray(task.cmd) ? [...task.cmd] : [];
  if (task.action === 'evaluate') {
    const target = task.target || cmd[2];
    if (!target) throw new Error('evaluate task missing target URL');
    if (reportExistsForUrl(target)) return { skip: true, reason: 'report-exists' };
    const reserved = reserveReportNum();
    cmd[0] = 'scripts/evaluate-url.mjs';
    cmd[1] = reserved;
    cmd[2] = target;
    return { cmd, reserved };
  }
  return { cmd };
}

// ── Procesamiento de cola ───────────────────────────────────────────

function processQueue(opts = {}) {
  const q = loadQueue();
  const now = Date.now();
  const pending = [];
  const failed = [...q.failed];
  const completed = [...q.completed];
  const deadLetter = [...(q.deadLetter || [])];

  const limit = Number.isFinite(opts.limit) ? opts.limit : Infinity;
  const maxCost = Number.isFinite(opts.maxCost) ? opts.maxCost : Infinity;

  let ran = 0, succeeded = 0, skipped = 0, retried = 0, deadLettered = 0;
  let costSoFar = 0;
  let stoppedByLimit = false, stoppedByCost = false;

  for (const task of q.pending) {
    if (ran >= limit) { stoppedByLimit = true; pending.push(task); continue; }
    if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now) { pending.push(task); continue; }

    const estCost = costEstimate(task.action);
    if (costSoFar + estCost > maxCost) { stoppedByCost = true; pending.push(task); continue; }

    if (task.attempts >= (task.maxAttempts || QUEUE_MAX_ATTEMPTS)) {
      deadLetter.push({
        ...task,
        attempts: task.attempts,
        status: 'deadLetter',
        deadLetter: true,
        deadLetterAt: new Date().toISOString(),
        deadLetterReason: task.lastError || 'excedió reintentos máximos',
        updatedAt: new Date().toISOString(),
        cost: estCost,
      });
      deadLettered++;
      console.warn(`💀 Carta muerta: ${task.action} — ${task.target || ''} (${task.lastError || 'sin reintentos restantes'})`);
      continue;
    }

    let reserved = null;
    try {
      const materialized = materializeCmd(task);
      if (materialized.skip) { completed.push({ ...task, status: 'completed', completedAt: new Date().toISOString(), reason: materialized.reason }); skipped++; continue; }
      reserved = materialized.reserved || null;
      console.log(`▶ Ejecutando tarea encolada: ${task.action} — ${task.target || ''}`);
      let execCmd = materialized.cmd;
      // Mirrar el comportamiento del paso 2 de main(): con CAREER_OPS_EVAL_LLM=1
      // se pide la evaluación real de oferta/auto-pipeline en vez del esqueleto.
      if (task.action === 'evaluate' && execCmd[0] === 'scripts/evaluate-url.mjs'
        && process.env.CAREER_OPS_EVAL_LLM === '1' && !execCmd.includes('--with-llm')) {
        execCmd = [...execCmd, '--with-llm'];
      }
      if (!DRY_RUN) {
        execFileSync(process.execPath, execCmd, {
          stdio: 'inherit', cwd: DATA_ROOT, env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT }, timeout: 300_000,
        });
      }
      costSoFar += estCost;
      ran++;
      succeeded++;
      completed.push({ ...task, status: 'completed', completedAt: new Date().toISOString(), attempts: task.attempts + 1, cost: estCost });
    } catch (err) {
      if (reserved) releaseReportNum(reserved);
      const attempts = (task.attempts || 0) + 1;
      costSoFar += estCost;
      ran++;
      if (attempts >= (task.maxAttempts || QUEUE_MAX_ATTEMPTS)) {
        deadLetter.push({
          ...task,
          attempts,
          lastError: err.message,
          status: 'deadLetter',
          deadLetter: true,
          deadLetterAt: new Date().toISOString(),
          deadLetterReason: err.message,
          updatedAt: new Date().toISOString(),
          cost: estCost,
        });
        deadLettered++;
        console.warn(`💀 Carta muerta: ${task.action} — ${task.target || ''} (${err.message})`);
      } else {
        retried++;
        const next = { ...task, attempts, lastError: err.message, updatedAt: new Date().toISOString(), status: 'pending' };
        next.nextAttemptAt = new Date(Date.now() + Math.min(60, attempts * 15) * 1000).toISOString();
        pending.push(next);
        console.warn(`⚠ Tarea falló, reintento ${attempts}/${task.maxAttempts || QUEUE_MAX_ATTEMPTS}: ${task.action} — ${err.message}`);
      }
    }
    if (stoppedByLimit || stoppedByCost) break;
  }

  q.pending = pending;
  q.failed = failed.slice(-500);
  q.completed = completed.slice(-500);
  q.deadLetter = deadLetter.slice(-1000);
  saveQueue(q);

  return {
    ran,
    succeeded,
    errored: retried + deadLettered,
    retried,
    deadLettered,
    skipped,
    remaining: q.pending.length,
    costSoFar,
    stoppedByLimit,
    stoppedByCost,
  };
}

function printQueueSummary(res) {
  console.log(`   Cola: ${res.ran} ejecutadas, ${res.succeeded} OK, ${res.retried} reintentadas, ${res.deadLettered} carta(s) muerta(s), ${res.skipped} omitidas (ya evaluadas), ${res.remaining} restantes, coste estimado ≈ $${res.costSoFar.toFixed(3)}`);
  if (res.stoppedByLimit) console.log('   ⏹ Límite de cola alcanzado (--queue-limit).');
  if (res.stoppedByCost) console.log(`   💰 Presupuesto de coste alcanzado (--max-cost ${MAX_COST}).`);
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

  // Modo exclusivo de cola: solo se procesa la cola, nunca scan/eval/merge/notify.
  if (QUEUE_ONLY) {
    console.log('♻️ Modo queue-only: solo se procesa la cola pendiente/fallida (no se escanea ni evalúa pipeline).');
    const res = processQueue({ limit: QUEUE_LIMIT, maxCost: MAX_COST });
    printQueueSummary(res);
    const qFinal = loadQueue();
    writeState({
      lastRun: new Date().toISOString(),
      mode: 'queue-only',
      queueLimit: QUEUE_LIMIT,
      maxCost: MAX_COST,
      dryRun: DRY_RUN,
      queue: {
        pending: qFinal.pending.length,
        failed: qFinal.failed.length,
        completed: qFinal.completed.length,
        deadLetter: qFinal.deadLetter.length,
      },
      cost: { maxCost: MAX_COST, estimatedUsd: res.costSoFar },
    });
    console.log('\n✅ Auto-run (queue-only) completado.');
    return;
  }

  // 1. Escanear
  if (!SCAN_ONLY) {
    console.log('🔍 Paso 1/3: Escaneando portales…');
    const scanRes = run('scan.mjs', DRY_RUN ? ['--dry-run'] : []);
    if (!scanRes.ok && !DRY_RUN) {
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
      const m = line.match(/^- \[\]\s+(https?:\/\/[^|]+)\|/);
      if (m) pendingUrls.push(m[1].trim());
    }

    let evaluated = 0;
    const q = loadQueue();
    const queuedKeys = new Set([...q.pending, ...q.failed, ...q.deadLetter].map((t) => t.dedupeKey));
    for (const url of pendingUrls) {
      if (evaluated >= LIMIT) break;
      const key = `evaluate:${normalizeUrl(url)}`;
      if (queuedKeys.has(key) || reportExistsForUrl(url)) continue;
      let reserved = null;
      try {
        reserved = reserveReportNum();
        console.log(`\n📝 Evaluando: ${url} → reporte #${reserved}`);
        const evalArgs = [reserved, url];
        if (process.env.CAREER_OPS_EVAL_LLM === '1') evalArgs.push('--with-llm');
        const res = run('scripts/evaluate-url.mjs', evalArgs);
        if (res.ok) evaluated++;
        else {
          releaseReportNum(reserved);
          enqueue({ action: 'evaluate', target: url, cmd: ['scripts/evaluate-url.mjs', '__RESERVE__', url] });
        }
      } catch (err) {
        if (reserved) releaseReportNum(reserved);
        console.warn(`⚠ No se pudo evaluar ${url}: ${err.message}`);
        enqueue({ action: 'evaluate', target: url, cmd: ['scripts/evaluate-url.mjs', '__RESERVE__', url] });
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

  // 5. Procesar cola de tareas pendientes/fallidas
  console.log('\n♻️ Paso 5/5: Procesando cola de tareas pendientes…');
  const qRes = processQueue({ limit: QUEUE_LIMIT, maxCost: MAX_COST });
  printQueueSummary(qRes);

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
  const qFinal = loadQueue();
  const state = {
    lastRun: new Date().toISOString(),
    scan: SCAN_ONLY ? 'scan-only' : 'full',
    queueOnly: false,
    evaluatedLimit: LIMIT,
    queueLimit: QUEUE_LIMIT,
    maxCost: MAX_COST,
    dryRun: DRY_RUN,
    queue: {
      pending: qFinal.pending.length,
      failed: qFinal.failed.length,
      completed: qFinal.completed.length,
      deadLetter: qFinal.deadLetter.length,
    },
    cost: { maxCost: MAX_COST, estimatedUsd: qRes.costSoFar },
    stoppedByLimit: qRes.stoppedByLimit,
    stoppedByCost: qRes.stoppedByCost,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

  console.log('\n✅ Auto-run completado.');
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`⚠ No se pudo guardar estado (${STATE_FILE}): ${err.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
