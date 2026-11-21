#!/usr/bin/env node
/**
 * scripts/notify-new-shortlist.mjs — Envía ofertas del shortlist por Telegram.
 *
 * Lee `data/shortlist.md`, numera las ofertas y envía por Telegram las ofertas
 * con empresa, rol, contexto, URL y comandos sugeridos (/apply N, /cv N, /skip N).
 *
 * Por defecto envía solo la sección "Worth a look" y solo ofertas no notificadas
 * antes (delta). El estado se guarda en data/automation/telegram-notified.json.
 *
 * Variables de entorno:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Uso:
 *   node scripts/notify-new-shortlist.mjs                 # delta, Worth a look
 *   node scripts/notify-new-shortlist.mjs --all           # todas las secciones
 *   node scripts/notify-new-shortlist.mjs --section worth # sección concreta
 *   node scripts/notify-new-shortlist.mjs --force         # reenvía aunque ya notificadas
 *   node scripts/notify-new-shortlist.mjs --dry-run       # preview, no envía
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const SHORTLIST = join(DATA_ROOT, 'data', 'shortlist.md');
const STATE_FILE = join(DATA_ROOT, 'data', 'automation', 'telegram-notified.json');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN = process.argv.includes('--dry-run');
const SEND_ALL = process.argv.includes('--all');
const FORCE = process.argv.includes('--force');
const ONLY_SECTION_ARG = process.argv.find((a) => a === '--section' || a.startsWith('--section='));
const SECTION = ONLY_SECTION_ARG
  ? ONLY_SECTION_ARG.split('=')[1] || process.argv[process.argv.indexOf(ONLY_SECTION_ARG) + 1] || ''
  : '';

const USAGE = `Usage:
  node scripts/notify-new-shortlist.mjs [--all] [--section <name>] [--force] [--dry-run]
`;

function log(...args) { console.log(...args); }
function err(...args) { console.error(...args); }

function loadState() {
  if (!existsSync(STATE_FILE)) return { version: 1, notified: {} };
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (!data || typeof data !== 'object') return { version: 1, notified: {} };
    if (!data.notified || typeof data.notified !== 'object') data.notified = {};
    data.version = 1;
    return data;
  } catch {
    return { version: 1, notified: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  writeFileSync(STATE_FILE, readFileSync(tmp, 'utf-8'), 'utf-8');
}

function offerKey(offer) {
  return offer.url || `${offer.company}||${offer.role}`.toLowerCase();
}

function parseShortlist(text) {
  const sections = {};
  let current = null;
  let counter = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const mSec = line.match(/^##\s+(.+)$/);
    if (mSec) {
      current = mSec[1].trim().toLowerCase();
      sections[current] = sections[current] || [];
      continue;
    }

    const mOffer = line.match(/^-\s+(.+)$/);
    if (mOffer && current) {
      const body = mOffer[1];
      const urlMatch = body.match(/\s(https?:\/\/\S+)$/);
      const url = urlMatch ? urlMatch[1].trim() : '';
      const withoutUrl = url ? body.replace(urlMatch[0], '').trim() : body;
      const parts = withoutUrl.split(/—/).map((p) => p.trim());
      const company = parts[0] || '';
      const role = parts.slice(1, -1).join(' — ').trim() || parts[1] || '';
      const context = parts[parts.length - 1] || '';

      counter++;
      sections[current].push({ id: counter, company, role, context, url });
    }
  }

  return { sections, total: counter };
}

function telegramSendMessage(chatId, text) {
  if (DRY_RUN) {
    log('[dry-run] Telegram:', text.slice(0, 140).replace(/\n/g, ' | '));
    return { ok: true };
  }
  if (!TOKEN || !CHAT_ID) throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID');

  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: false,
  });

  const script = `
    import { request } from 'node:https';
    const data = ${JSON.stringify(payload)};
    const opts = {
      hostname: 'api.telegram.org', port: 443,
      path: '/bot${TOKEN}/sendMessage', method: 'POST',
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
    err('✗ Error enviando a Telegram:', e.message);
    return { ok: false, error: e.message };
  }
}

function buildOfferMessage(offer) {
  return [
    `💼 *${offer.company} — ${offer.role}*`,
    `📍 ${offer.context || 'Ubicación no especificada'}`,
    `🔗 ${offer.url}`,
    '',
    `Comandos: /apply ${offer.id}  |  /cv ${offer.id}  |  /skip ${offer.id}`,
  ].join('\n');
}

function buildSummary(count, sectionLabel, skipped) {
  const delta = skipped > 0 ? ` (${skipped} ya notificadas)` : '';
  return `📋 *Shortlist — ${sectionLabel}*\n${count} oferta(s) nueva(s)${delta}. Usa /apply N, /cv N o /skip N.`;
}

async function main() {
  if (!existsSync(SHORTLIST)) {
    err(`✗ No existe ${SHORTLIST}`);
    process.exit(1);
  }

  const text = readFileSync(SHORTLIST, 'utf-8');
  const { sections } = parseShortlist(text);
  const state = loadState();

  const targetSections = SEND_ALL
    ? Object.keys(sections)
    : SECTION
      ? [SECTION.toLowerCase()]
      : ['worth a look'];

  let sent = 0;
  let skipped = 0;

  for (const section of targetSections) {
    const offers = sections[section];
    if (!offers || offers.length === 0) continue;

    const label = section === 'worth a look' ? 'Worth a look' : section.charAt(0).toUpperCase() + section.slice(1);
    const fresh = [];
    for (const offer of offers) {
      const key = offerKey(offer);
      if (!FORCE && state.notified[key]) { skipped++; continue; }
      fresh.push(offer);
    }

    if (fresh.length === 0) {
      log(`Sin ofertas nuevas en "${label}" (${offers.length} ya notificadas).`);
      continue;
    }

    await telegramSendMessage(CHAT_ID, buildSummary(fresh.length, label, skipped));

    for (const offer of fresh) {
      const res = await telegramSendMessage(CHAT_ID, buildOfferMessage(offer));
      if (res.ok) {
        sent++;
        state.notified[offerKey(offer)] = { at: new Date().toISOString(), section, company: offer.company, role: offer.role };
        if (!DRY_RUN) saveState(state);
      }
      if (!DRY_RUN) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  if (!DRY_RUN) saveState(state);
  log(`✅ Telegram: ${sent} enviada(s), ${skipped} ya notificada(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}
