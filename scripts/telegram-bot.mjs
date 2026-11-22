#!/usr/bin/env node
/**
 * scripts/telegram-bot.mjs — Bot de comandos de career-ops por Telegram.
 *
 * Escucha `getUpdates` (long polling) y ejecuta acciones del sistema:
 *   /apply N  -> genera el CV adaptado de la oferta #N (NUNCA envía/submit)
 *   /apply N --full -> prepara borrador completo (CV + carta + email)
 *   /cv N     -> genera el CV tailoreado (HTML/PDF) para la oferta #N
 *   /skip N   -> marca la oferta #N como Discarded en el tracker
 *   /list     -> lista las ofertas pendientes del shortlist
 *   /status   -> estado del sistema (último scan, tracker)
 *   /help     -> ayuda
 *
 * Seguridad: solo responde a TELEGRAM_CHAT_ID (tu chat). Ignora el resto.
 *
 * Variables de entorno (nunca las guarda en el repo):
 *   TELEGRAM_BOT_TOKEN  — token de @BotFather
 *   TELEGRAM_CHAT_ID    — tu chat_id
 *   TELEGRAM_POLL_INTERVAL_MS — ms entre peticiones (default 3000)
 *
 * Uso:
 *   node scripts/telegram-bot.mjs        # inicia el escucha (bloqueante)
 *   node scripts/telegram-bot.mjs --once  # procesa mensajes pendientes y sale
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { writeTraceRecord, isVerifiedSubmit, trackerDecision } from '../lib/apply-trace.mjs';

const DATA_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000);
const ONCE = process.argv.includes('--once');

const OFFSET_FILE = join(DATA_ROOT, 'data', 'automation', 'telegram-offset.json');
const SHORTLIST = join(DATA_ROOT, 'data', 'shortlist.md');
const TRACKER = join(DATA_ROOT, 'data', 'applications.md');

const USAGE = `
career-ops Telegram Bot

Comandos:
  /apply N   Genera el CV adaptado de #N (NUNCA envía/submit)
  /apply N --full  Prepara borrador completo (CV + carta + email) para #N
  /assist N  Instrucciones de apply asistido (Playwright local, confirmación humana explícita)
  /cv N      Genera CV PDF para el reporte de la oferta #N
  /skip N    Descarta la oferta #N del shortlist
  /sent N    Registra confirmación humana: ya enviaste #N (no lo hace el bot)
  /notsent N Registra confirmación humana: decidiste no enviar #N
  /list      Lista ofertas: descripción, score y fit del reporte
  /status    Estado del sistema (último scan, tracker)
  /help      Esta ayuda

Solo funciona para tu chat (TELEGRAM_CHAT_ID). Todo se ejecuta localmente.
`;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function err(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

// ── Offset persistente (para no reprocesar mensajes) ──────────────

function loadOffset() {
  if (!existsSync(OFFSET_FILE)) return 0;
  try {
    const d = JSON.parse(readFileSync(OFFSET_FILE, 'utf-8'));
    return Number(d.offset || 0);
  } catch { return 0; }
}

function saveOffset(offset) {
  mkdirSync(join(DATA_ROOT, 'data', 'automation'), { recursive: true });
  writeFileSync(OFFSET_FILE, JSON.stringify({ offset }, null, 2), 'utf-8');
}

// ── Llamada a la API de Telegram ──────────────────────────────────

function telegramApi(method, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : undefined;
    const opts = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    };
    const req = request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function telegramSendMessage(chatId, text, opts = {}) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...opts,
  });
}

// ── Parseo del shortlist (mapear número -> oferta) ─────────────────

function parseShortlist() {
  if (!existsSync(SHORTLIST)) return [];
  const text = readFileSync(SHORTLIST, 'utf-8');
  const offers = [];
  let currentSection = '';
  let counter = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const mSec = line.match(/^##\s+(.+)$/);
    if (mSec) { currentSection = mSec[1].trim(); continue; }

    const mOffer = line.match(/^-\s+(.+)$/);
    if (mOffer) {
      const body = mOffer[1];
      const urlMatch = body.match(/\s(https?:\/\/\S+)$/);
      const url = urlMatch ? urlMatch[1].trim() : '';
      const withoutUrl = url ? body.replace(urlMatch[0], '').trim() : body;
      const parts = withoutUrl.split(/—/).map((p) => p.trim());
      counter++;
      offers.push({
        id: counter,
        section: currentSection,
        company: parts[0] || '',
        role: parts.slice(1, -1).join(' — ').trim() || parts[1] || '',
        context: parts[parts.length - 1] || '',
        url,
      });
    }
  }
  return offers;
}

function findOfferById(id) {
  return parseShortlist().find((o) => o.id === id);
}

// ── Ejecución de acciones del sistema ─────────────────────────────

function run(cmd, args = []) {
  try {
    const out = execFileSync(process.execPath, [cmd, ...args], {
      stdio: 'pipe',
      cwd: DATA_ROOT,
      env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
      timeout: 300_000,
    });
    return { ok: true, output: out.toString() };
  } catch (e) {
    return {
      ok: false,
      output: ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || ''),
      error: e.message,
    };
  }
}

function findReportForOffer(offer) {
  if (!offer?.url) return null;
  try {
    const res = run('find.mjs', [offer.url]);
    if (!res.ok) return null;
    const m = res.output.match(/^(\d{3})\s*->/m) || res.output.match(/\b(\d{3})\b/);
    return m ? m[1] : null;
  } catch { return null; }
}

function findReportFile(num) {
  const dir = join(DATA_ROOT, 'reports');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(`${num}-`) && f.endsWith('.md'));
  return files.length ? join(dir, files[0]) : null;
}

function readReportInfo(num) {
  const file = findReportFile(num);
  if (!file) return null;
  let text = '';
  try { text = readFileSync(file, 'utf-8'); } catch { return null; }
  const info = { scoreLine: '', recommendation: '', fitLine: '', jd: '' };
  const scoreM = text.match(/\*\*Score:\*\*\s*([^\n]+)/);
  if (scoreM) info.scoreLine = scoreM[1].trim();
  const recM = text.match(/\*\*Recommendation:\*\*\s*([^\n]+)/);
  if (recM) info.recommendation = recM[1].trim();
  const fitM = text.match(/Fit reasoning:\s*([^\n]+)/);
  if (fitM) info.fitLine = fitM[1].trim();
  const jdIdx = text.indexOf('## Job Description (archived verbatim)');
  if (jdIdx >= 0) {
    const body = text.slice(jdIdx).split('\n').slice(1).join('\n');
    info.jd = body.slice(0, 300).replace(/\s+/g, ' ').trim();
  }
  if (!info.scoreLine && !info.jd) return null;
  return info;
}

function trackerRowForUrl(url) {
  if (!existsSync(TRACKER)) return null;
  const text = readFileSync(TRACKER, 'utf-8');
  for (const line of text.split('\n')) {
    if (line.includes(url)) return line.trim();
  }
  return null;
}

// ── Comandos ──────────────────────────────────────────────────────

async function cmdApply(chatId, id, text = '') {
  const offer = findOfferById(id);
  if (!offer) {
    await telegramSendMessage(chatId, `❌ No encontré la oferta #${id} en el shortlist.`);
    return;
  }

  const reportNum = findReportForOffer(offer);
  const full = /(^|\s)--full(\s|$)/.test(text);
  let msg = `🧾 *${offer.company} — ${offer.role}*\n`;
  msg += `No envío ni hago submit automático.\n`;

  if (reportNum) {
    const day = new Date().toISOString().slice(0, 10);
    if (full) {
      const prep = run('automation/prepare-application.mjs', [reportNum, '--no-open']);
      if (prep.ok) {
        msg += `📦 Borrador completo preparado (CV + carta + email) para reporte ${reportNum} (output/applications/${reportNum}/).\n`;
        const st = run('set-status.mjs', ['--report', reportNum, 'Evaluated', '--note',
          `telegram-draft: prepared ${day} report=${reportNum} manifest=output/applications/${reportNum}/manifest.json status=draft-only`]);
        if (!st.ok) err(`cmdApply: no se pudo registrar nota en tracker para ${reportNum}: ${st.error}`);
      } else {
        msg += `⚠ prepare-application falló para reporte ${reportNum}: ${prep.error}\n`;
        const st = run('set-status.mjs', ['--report', reportNum, 'Evaluated', '--note', `telegram-draft: failed ${day} report=${reportNum} not-submitted`]);
        if (!st.ok) err(`cmdApply: no se pudo registrar nota en tracker para ${reportNum}: ${st.error}`);
      }
      msg += `Revisa el borrador y confirma tú mismo el envío/submit.`;
    } else {
      const cv = run('generate-pdf.mjs', [`--report=${reportNum}`]);
      if (cv.ok) {
        msg += `📦 CV adaptado generado para reporte ${reportNum} (output/).\n`;
        msg += `🧭 Para apply asistido local: \`node scripts/apply-assist.mjs ${reportNum}\`\n`;
        const st = run('set-status.mjs', ['--report', reportNum, 'Evaluated', '--note',
          `telegram-draft: cv-prepared ${day} report=${reportNum} status=draft-only`]);
        if (!st.ok) err(`cmdApply: no se pudo registrar nota en tracker para ${reportNum}: ${st.error}`);
      } else {
        const st = run('set-status.mjs', ['--report', reportNum, 'Evaluated', '--note',
          `telegram-draft: cv-failed ${day} report=${reportNum} not-submitted`]);
        if (!st.ok) err(`cmdApply: no se pudo registrar nota en tracker para ${reportNum}: ${st.error}`);
        msg += `⚠ No se pudo generar el CV para reporte ${reportNum}.\n${cv.error}`;
      }
      msg += `Revisa el CV en output/ antes de usarlo.`;
    }
  } else {
    msg += `⚠ No encontré reporte asociada a esta URL. Evalúa primero la oferta para generar reporte/CV específicos.\n`;
  }
  msg += `\nRegistra el envío real tú mismo con /sent ${id} o /notsent ${id}.`;
  await telegramSendMessage(chatId, msg);
}

async function cmdCv(chatId, id) {
  const offer = findOfferById(id);
  if (!offer) {
    await telegramSendMessage(chatId, `❌ No encontré la oferta #${id} en el shortlist.`);
    return;
  }

  const reportNum = findReportForOffer(offer);
  if (!reportNum) {
    await telegramSendMessage(chatId,
      `⚠ No encontré reporte para *${offer.company} — ${offer.role}*.\n` +
      `Evalúa primero la oferta (auto-pipeline/oferta) para generar el reporte y luego crear el CV específico.`);
    return;
  }

  const res = run('generate-pdf.mjs', [`--report=${reportNum}`]);
  if (res.ok) {
    await telegramSendMessage(chatId,
      `📄 CV generado para *${offer.company} — ${offer.role}* (reporte ${reportNum}).\n` +
      `Revisa la carpeta \`output/\` antes de usarlo.`);
  } else {
    await telegramSendMessage(chatId, `❌ No se pudo generar el CV para reporte ${reportNum}.\n${res.error}`);
  }
}

async function cmdSkip(chatId, id) {
  const offer = findOfferById(id);
  if (!offer) {
    await telegramSendMessage(chatId, `❌ No encontré la oferta #${id} en el shortlist.`);
    return;
  }

  const reportNum = findReportForOffer(offer);
  const args = reportNum ? ['--report', reportNum, 'Discarded', '--note', `Via Telegram /skip ${id}`] : [offer.company, 'Discarded', '--note', `Via Telegram /skip ${id}`];
  const res = run('set-status.mjs', args);
  if (res.ok) {
    await telegramSendMessage(chatId, `⏭️ *${offer.company} — ${offer.role}*\nEstado: Discarded (vía Telegram)`);
  } else {
    await telegramSendMessage(chatId, `❌ set-status falló: ${res.error}`);
  }
}

async function cmdSent(chatId, id) {
  const offer = findOfferById(id);
  if (!offer) { await telegramSendMessage(chatId, `❌ No encontré la oferta #${id}.`); return; }
  const reportNum = findReportForOffer(offer);
  if (!reportNum) { await telegramSendMessage(chatId, `❌ No encontré reporte para #${id}. No puedo registrar envío sin reporte.`); return; }
  const day = new Date().toISOString().slice(0, 10);
  const manifestPath = join(DATA_ROOT, 'output', 'applications', reportNum, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : null;
  const verified = isVerifiedSubmit(manifest);
  const decision = trackerDecision('telegram', verified, day);
  writeTraceRecord(manifestPath, {
    source: 'telegram',
    event: 'human-reported-sent',
    verified,
    details: { reportNum, humanReportedSentBy: 'telegram' },
  });
  const res = run('set-status.mjs', ['--report', reportNum, decision.status, '--on', decision.on, '--note', decision.note]);
  if (!res.ok) { err(`cmdSent: no se pudo registrar envío en tracker para ${reportNum}: ${res.error}`); }
  if (res.ok) {
    if (verified) {
      await telegramSendMessage(chatId, `✅ *${offer.company} — ${offer.role}*\nRegistrado como enviado por humano (${day}) con evidencia verificada en manifest. Ningún envío fue realizado por el bot.`);
    } else {
      await telegramSendMessage(chatId, `⚠ *${offer.company} — ${offer.role}*\nRegistré reporte humano de envío (${day}), pero no hay evidencia verificada de submit en manifest. Tracker queda en Evaluated; usa apply-assist con confirmación SUBMIT para evidencia verificada.`);
    }
  } else {
    await telegramSendMessage(chatId, `❌ No pude registrar envío: ${res.error}`);
  }
}

async function cmdNotSent(chatId, id) {
  const offer = findOfferById(id);
  if (!offer) { await telegramSendMessage(chatId, `❌ No encontré la oferta #${id}.`); return; }
  const reportNum = findReportForOffer(offer);
  if (!reportNum) { await telegramSendMessage(chatId, `❌ No encontré reporte para #${id}.`); return; }
  const day = new Date().toISOString().slice(0, 10);
  const manifestPath = join(DATA_ROOT, 'output', 'applications', reportNum, 'manifest.json');
  writeTraceRecord(manifestPath, {
    source: 'telegram',
    event: 'human-reported-not-sent',
    details: { reportNum, humanReportedSentBy: 'telegram' },
  });
  const res = run('set-status.mjs', ['--report', reportNum, 'Evaluated', '--note', `human-send: not-sent ${day} source=telegram`]);
  if (!res.ok) { err(`cmdNotSent: no se pudo registrar estado en tracker para ${reportNum}: ${res.error}`); }
  if (res.ok) await telegramSendMessage(chatId, `📝 *${offer.company} — ${offer.role}*\nRegistrado como no enviado por humano (${day}). Ningún envío fue realizado por el bot.`);
  else await telegramSendMessage(chatId, `❌ No pude registrar estado: ${res.error}`);
}

async function cmdList(chatId) {
  const offers = parseShortlist();
  if (offers.length === 0) {
    await telegramSendMessage(chatId, '📋 El shortlist está vacío.');
    return;
  }

  // Solo mostrar los primeros 10 para no saturar el chat
  const lines = [];
  for (const o of offers.slice(0, 10)) {
    let line = `#${o.id} • ${o.company} — ${o.role}\n   ${o.context}\n   ${o.url}`;
    const num = findReportForOffer(o);
    if (num) {
      const info = readReportInfo(num);
      if (info) {
        if (info.jd) line += `\n   📖 ${info.jd}`;
        const parts = [info.scoreLine, info.recommendation, info.fitLine].filter(Boolean);
        if (parts.length) line += `\n   📊 ${parts.join(' | ')}`;
      }
    }
    lines.push(line);
  }
  const extra = offers.length > 10 ? `\n…y ${offers.length - 10} más.` : '';
  await telegramSendMessage(chatId, `📋 *Shortlist (primeras 10)*:\n\n${lines.join('\n\n')}${extra}`);
}

async function cmdStatus(chatId) {
  const scheduler = run('scripts/scheduler-status.mjs');
  let text = `🤖 *career-ops status*\n`;
  if (scheduler.ok) {
    text += `\`\`\`\n${scheduler.output.slice(0, 1500)}\n\`\`\``;
  } else {
    text += `No se pudo obtener el estado del programador.`;
  }
  await telegramSendMessage(chatId, text);
}

async function cmdAssist(chatId, id) {
  const offer = findOfferById(id);
  if (!offer) { await telegramSendMessage(chatId, `❌ No encontré la oferta #${id} en el shortlist.`); return; }
  const reportNum = findReportForOffer(offer);
  if (!reportNum) {
    await telegramSendMessage(chatId, `⚠ No encontré reporte para *${offer.company} — ${offer.role}*. Evalúa primero.`);
    return;
  }
  await telegramSendMessage(chatId,
    `🧭 *Apply asistido (local, humano confirma)*\n` +
    `Reporte ${reportNum} — ${offer.company} — ${offer.role}\n\n` +
    `Ejecuta en tu máquina:\n` +
    `\`node scripts/apply-assist.mjs ${reportNum}\`\n\n` +
    `Reglas: abre browser del proyecto, prellena borrador, NUNCA hace submit automático. Solo hace click si escribes exactamente SUBMIT.\n` +
    `Después registra: /sent ${id} o /notsent ${id}.`);
}

async function cmdHelp(chatId) {
  await telegramSendMessage(chatId, USAGE);
}

const COMMANDS = {
  apply: cmdApply,
  assist: cmdAssist,
  cv: cmdCv,
  skip: cmdSkip,
  sent: cmdSent,
  notsent: cmdNotSent,
  list: cmdList,
  status: cmdStatus,
  help: cmdHelp,
};

// ── Procesar un mensaje entrante ──────────────────────────────────

async function handleMessage(update) {
  const message = update.message || update.edited_message;
  if (!message) return;

  const from = message.from || {};
  const chat = message.chat || {};
  const text = message.text || '';

  // Solo tu chat puede enviar comandos
  if (String(chat.id) !== String(CHAT_ID)) {
    log(`Mensaje ignorado de chat no autorizado: ${chat.id}`);
    return;
  }

  const m = text.match(/^\/(\w+)(?:\s+(\d+))?/);
  if (!m) {
    await telegramSendMessage(chat.id, 'Comando no reconocido. Usa /help para ver la lista.');
    return;
  }

  const [, cmd, arg] = m;
  const handler = COMMANDS[cmd];
  if (!handler) {
    await telegramSendMessage(chat.id, `Comando /${cmd} no reconocido. Usa /help.`);
    return;
  }

  log(`Comando /${cmd} ${arg || ''} de ${chat.id}`);
  try {
    if (arg) await handler(chat.id, Number(arg), text);
    else await handler(chat.id, undefined, text);
  } catch (e) {
    err(`Error ejecutando /${cmd}:`, e.message);
    await telegramSendMessage(chat.id, `❌ Error ejecutando /${cmd}: ${e.message}`);
  }
}

// ── Loop de polling ───────────────────────────────────────────────

async function pollOnce(offset) {
  const res = await telegramApi('getUpdates', {
    offset,
    limit: 100,
    timeout: 30,
    allowed_updates: JSON.stringify(['message', 'edited_message']),
  });

  if (!res.ok) {
    err('getUpdates falló:', JSON.stringify(res).slice(0, 200));
    return offset;
  }

  const updates = res.result || [];
  let nextOffset = offset;

  for (const update of updates) {
    nextOffset = update.update_id + 1;
    await handleMessage(update);
  }

  if (updates.length > 0) saveOffset(nextOffset);
  return nextOffset;
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    err('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.');
    process.exit(1);
  }

  let offset = loadOffset();
  log(`Bot iniciado. Chat autorizado: ${CHAT_ID}. Offset: ${offset}`);

  if (ONCE) {
    offset = await pollOnce(offset);
    log(`Procesado. Offset guardado: ${offset}`);
    return;
  }

  while (true) {
    try {
      offset = await pollOnce(offset);
    } catch (e) {
      err('Error en poll:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  main().catch((e) => {
    err('Fatal:', e.message);
    process.exit(1);
  });
}
