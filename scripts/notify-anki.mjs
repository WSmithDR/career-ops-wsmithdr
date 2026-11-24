#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main-module.mjs';
import { loadRelevanceCache } from '../lib/anki-relevance.mjs';

const INBOX_RE = /^- \[ \] (?<stamp>[^\n]*?) — ANKI \(fuente del perfil\):(?: "(?<text>.*?)")?(?: ·[^\n]*?)? — baraja "(?<deck>.*)" \(#(?<id>\d+)\)/;
const TARGET_RE = /\b(?:proyecto|project|logro|achievement|métrica|metric|proof point)\b/i;
export const DEFAULT_LIMIT = 8;

const USAGE = `Usage:
  node scripts/notify-anki.mjs [--all] [--force] [--limit N] [--dry-run]
`;

export function loadTelegramEnv(root) {
  const file = join(root, 'config', 'telegram.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    process.env[key] = t.slice(eq + 1).trim();
  }
}

export function parseAnkiInbox(text) {
  const entries = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    const m = line.match(INBOX_RE);
    if (!m) return;
    entries.push({
      lineNumber: i + 1,
      cardId: Number(m.groups.id),
      deck: m.groups.deck,
      text: (m.groups.text ?? '').trim(),
      stamp: m.groups.stamp.trim(),
    });
  });
  return entries;
}

export function suggestedTarget(entry, verdict) {
  const signal = `${entry.deck} ${verdict?.reason ?? ''} ${verdict?.archetype ?? ''}`.toLowerCase();
  return TARGET_RE.test(signal) ? 'article-digest.md' : 'cv.md';
}

export function loadNotified(path) {
  if (!existsSync(path)) return { version: 1, notified: {} };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!data || typeof data !== 'object') return { version: 1, notified: {} };
    if (!data.notified || typeof data.notified !== 'object' || Array.isArray(data.notified)) data.notified = {};
    data.version = 1;
    return data;
  } catch {
    return { version: 1, notified: {} };
  }
}

export function saveNotified(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, notified: state.notified }, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function short(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plain(value, max = 160) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[*_`\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return short(text, max);
}

function sourceAnnotation(proposal) {
  return `**Source:** tarjeta Anki, baraja "${plain(proposal.deck, 60)}", #${proposal.cardId}, clasificada ${plain(proposal.classifiedAt || 'fecha desconocida', 20)}, motivo: ${plain(proposal.reason, 160)}`;
}

export function buildAnkiMessage(proposals, meta = {}) {
  const lines = [
    '🧠 *Propuestas Anki → perfil*',
    `${proposals.length} propuesta(s) relevante(s) para revisar.`,
    '',
  ];
  proposals.forEach((p, i) => {
    lines.push(`${i + 1}. #${p.cardId} · ${plain(p.deck, 60)} — "${plain(p.cardText, 120)}"`);
    lines.push(`   destino sugerido: ${p.target}`);
    lines.push(`   ${sourceAnnotation(p)}`);
  });
  lines.push('');
  lines.push('Nada se escribe hasta que toques Aprobar; nunca se envía ninguna postulación.');
  return lines.join('\n');
}

export function buildAnkiKeyboard(proposals) {
  const inline_keyboard = proposals.map((p) => [{
    text: `⬜ #${p.cardId} ${short(p.cardText, 30)}`,
    callback_data: `ak:${p.cardId}`,
  }]);
  if (proposals.length > 0) {
    inline_keyboard.push([
      { text: '✅ Aprobar seleccionadas', callback_data: 'aka' },
      { text: '💬 ¿Por qué no?', callback_data: `akw:${proposals[0].cardId}` },
      { text: '❌ Cerrar', callback_data: 'akx' },
    ]);
  }
  return { inline_keyboard };
}

export function telegramSendMessage({ chatId, text, replyMarkup }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');
  const body = { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const payload = JSON.stringify(body);
  const script = `
    import { request } from 'node:https';
    const data = ${JSON.stringify(payload)};
    const opts = {
      hostname: 'api.telegram.org', port: 443,
      path: '/bot${token}/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(JSON.stringify({ status: res.statusCode }));
        process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
      });
    });
    req.on('error', (e) => { console.error(e.message); process.exit(1); });
    req.write(data); req.end();
  `;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe', timeout: 30_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function runNotifyAnki(opts = {}) {
  const root = opts.root ?? process.cwd();
  const out = opts.out ?? console.log;
  const dryRun = Boolean(opts.dryRun);
  const all = Boolean(opts.all);
  const force = Boolean(opts.force);
  const now = opts.now ?? new Date();
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const inboxPath = join(root, 'data/agent-inbox.md');
  const relevancePath = join(root, 'data/anki-relevance.json');
  const statePath = join(root, 'data/automation/telegram-anki-notified.json');

  if (!existsSync(inboxPath)) {
    out('notify-anki: sin data/agent-inbox.md; nada que notificar.');
    return { status: 'noop', reason: 'missing-inbox', proposals: [] };
  }

  const entries = parseAnkiInbox(readFileSync(inboxPath, 'utf-8'));
  const relevance = loadRelevanceCache(relevancePath);
  const state = loadNotified(statePath);
  const proposals = [];
  let skipped = 0;
  let irrelevant = 0;

  for (const entry of entries) {
    const verdict = relevance.entries[String(entry.cardId)];
    if (!verdict || verdict.relevant !== true) { irrelevant++; continue; }
    if (!all && !force && state.notified[String(entry.cardId)]) { skipped++; continue; }
    proposals.push({
      cardId: entry.cardId,
      deck: entry.deck,
      cardText: entry.text,
      target: suggestedTarget(entry, verdict),
      reason: String(verdict.reason ?? ''),
      archetype: String(verdict.archetype ?? ''),
      classifiedAt: String(verdict.classifiedAt ?? ''),
    });
    if (proposals.length >= limit) break;
  }

  if (proposals.length === 0) {
    out(`notify-anki: sin propuestas nuevas (${entries.length} entrada(s), ${irrelevant} no relevantes, ${skipped} ya notificadas).`);
    return { status: 'noop', reason: 'nothing-new', proposals: [], skipped, irrelevant };
  }

  const text = buildAnkiMessage(proposals, { skipped, irrelevant });
  const keyboard = buildAnkiKeyboard(proposals);
  const notified = {};

  if (dryRun) {
    out('[dry-run] notify-anki — mensaje:');
    out(text);
    out(`[dry-run] reply_markup: ${JSON.stringify(keyboard)}`);
  } else {
    const send = opts.sender ?? telegramSendMessage;
    let res;
    try {
      res = await send({ chatId: opts.chatId ?? process.env.TELEGRAM_CHAT_ID, text, replyMarkup: keyboard });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res?.ok) {
      out(`✗ notify-anki: falló el envío (${res?.error ?? 'error desconocido'}); estado sin cambios.`);
      return { status: 'error', proposals, text, keyboard, error: res?.error };
    }
  }

  for (const p of proposals) {
    const record = { at: now.toISOString(), deck: p.deck, target: p.target };
    state.notified[String(p.cardId)] = record;
    notified[String(p.cardId)] = record;
  }
  if (!dryRun) saveNotified(statePath, state);

  out(`✅ notify-anki: ${proposals.length} propuesta(s) en un mensaje, ${skipped} ya notificadas, ${irrelevant} no relevantes.`);
  return { status: dryRun ? 'dry-run' : 'sent', proposals, text, keyboard, notified, skipped, irrelevant };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
  } else {
    const root = process.env.CAREER_OPS_ROOT || process.cwd();
    loadTelegramEnv(root);
    const limitArg = argv.indexOf('--limit');
    let limit;
    if (limitArg >= 0) {
      limit = Number(argv[limitArg + 1]);
      if (!Number.isInteger(limit) || limit <= 0) {
        console.error('--limit expects a positive whole number');
        process.exit(2);
      }
    }
    const result = await runNotifyAnki({
      root,
      dryRun: argv.includes('--dry-run'),
      all: argv.includes('--all'),
      force: argv.includes('--force'),
      limit,
    });
    if (result.status === 'error') process.exitCode = 1;
  }
}
