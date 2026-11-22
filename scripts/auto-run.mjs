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

const KNOWN_FLAGS = ['--limit', '--scan-only', '--eval-only', '--queue-limit', '--queue-only', '--help', '-h', '--dry-run'];
const VALUE_FLAGS = ['--limit', '--queue-limit'];

const USAGE = `Usage:
  node scripts/auto-run.mjs [--limit N] [--queue-limit N] [--scan-only] [--eval-only] [--queue-only] [--dry-run]
  --limit N       evaluar máximo N ofertas pendientes del pipeline (default: 25)
  --queue-limit N procesar máximo N tareas de cola por ejecución (default: 10)
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
const QUEUE_LIMIT = QUEUE_LIMIT_ARG ? Number(QUEUE_LIMIT_ARG.split('=')[1] || args[args.indexOf(QUEUE_LIMIT_ARG) + 1]) : 10;
const QUEUE_MAX_ATTEMPTS = 3;

function flagValue(arr, flag) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === flag && arr[i + 1] && !arr[i + 1].startsWith('--')) return arr[i + 1];
  }
  return undefined;
}

// ── Cola de tareas persistente ──────────────────────────────────────

function normalizeQueue(q) {
  const base = { version: 2, pending: [], completed: [], failed: [] };
  const inQ = q && typeof q === 'object' ? q : base;
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
    };
  };
  const pending = Array.isArray(inQ.pending) ? inQ.pending.map((t) => normItem(t, 'pending')) : [];
  const failed = Array.isArray(inQ.failed) ? inQ.failed.map((t) => normItem(t, 'failed')) : [];
  const completed = Array.isArray(inQ.completed) ? inQ.completed.slice(-200) : [];
  return dedupeQueue({ ...base, pending, failed, completed });
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
  return q;
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { version: 2, pending: [], completed: [], failed: [] };
  try {
    return normalizeQueue(JSON.parse(readFileSync(QUEUE_FILE, 'utf-8')));
  } catch { return { version: 2, pending: [], completed: [], failed: [] }; }
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
  const normalized = normalizeQueue({ pending: [{ ...task }], completed: [], failed: [] }).pending[0];
  const key = normalized.dedupeKey;
  const exists = [...q.pending, ...q.failed].some((t) => t.dedupeKey === key);
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

function processQueue() {
  const q = loadQueue();
  const now = Date.now();
  const pending = [];
  const failed = [...q.failed];
  const completed = [...q.completed];
  let ran = 0, skipped = 0, dead = 0;

  for (const task of q.pending) {
    if (ran >= QUEUE_LIMIT) { pending.push(task); continue; }
    if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now) { pending.push(task); continue; }
    if (task.attempts >= (task.maxAttempts || QUEUE_MAX_ATTEMPTS)) { failed.push({ ...task, status: 'failed' }); dead++; continue; }

    let reserved = null;
    try {
      const materialized = materializeCmd(task);
      if (materialized.skip) { completed.push({ ...task, status: 'completed', completedAt: new Date().toISOString(), reason: materialized.reason }); skipped++; continue; }
      reserved = materialized.reserved || null;
      console.log(`▶ Ejecutando tarea encolada: ${task.action} — ${task.target || ''}`);
      execFileSync(process.execPath, materialized.cmd, {
        stdio: 'inherit', cwd: DATA_ROOT, env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT }, timeout: 300_000,
      });
      completed.push({ ...task, status: 'completed', completedAt: new Date().toISOString(), attempts: task.attempts + 1 });
      ran++;
    } catch (err) {
      if (reserved) releaseReportNum(reserved);
      const attempts = (task.attempts || 0) + 1;
      const next = { ...task, attempts, lastError: err.message, updatedAt: new Date().toISOString() };
      if (attempts >= (task.maxAttempts || QUEUE_MAX_ATTEMPTS)) { failed.push({ ...next, status: 'failed', failedAt: new Date().toISOString() }); dead++; }
      else { next.nextAttemptAt = new Date(Date.now() + Math.min(30, attempts * 10) * 60 * 1000).toISOString(); next.status = 'pending'; pending.push(next); }
      console.warn(`⚠ Tarea falló: ${task.action} — ${err.message}`);
    }
  }

  q.pending = pending;
  q.failed = failed.slice(-500);
  q.completed = completed.slice(-500);
  saveQueue(q);
  return { ran, pending: q.pending.length, failed: q.failed.length, skipped, dead };
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

  if (QUEUE_ONLY) {
    console.log('♻️ Modo queue-only: no se escanea ni evalúa pipeline.');
    return;
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
    const q = loadQueue();
    const queuedKeys = new Set([...q.pending, ...q.failed].map((t) => t.dedupeKey));
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
  const qFinal = loadQueue();
  const state = {
    lastRun: new Date().toISOString(),
    scan: SCAN_ONLY ? 'scan-only' : 'full',
    evaluatedLimit: LIMIT,
    queueLimit: QUEUE_LIMIT,
    dryRun: DRY_RUN,
    queue: { pending: qFinal.pending.length, failed: qFinal.failed.length, completed: qFinal.completed.length },
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
