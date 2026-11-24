#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main-module.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOSED_STATUS = /^(?:responded|respondido|sent|enviado|done|complete|completed|closed|cerrado|cancel|cancelled|cancelado|archived|archivado)\b/i;
const BULLET_RE = /^\s*-\s+(\d{4}-\d{2}-\d{2})\s+·\s+#?(\d+)\s+(.+?)(?:\s+—\s+(.*))?$/;
const PIN_RE = /^\s*-\s*next\s+#?(\d+)\s+(\d{4}-\d{2}-\d{2})/i;
const NEXT_RE = /\bnext\s+(\d{4}-\d{2}-\d{2})/i;

const USAGE = `Usage:
  node scripts/notify-followups.mjs [--all] [--force] [--dry-run]
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

export function validDate(value) {
  if (!ISO_DATE.test(String(value ?? ''))) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function norm(value) {
  return String(value ?? '').toLowerCase().replace(/[\s#_-]/g, '');
}

function nextInNote(note) {
  const m = String(note ?? '').match(NEXT_RE);
  return m && validDate(m[1]) ? m[1] : '';
}

export function parseFollowupRows(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const pins = new Map();
  for (const line of lines) {
    const m = line.match(PIN_RE);
    if (m && validDate(m[2])) pins.set(String(Number(m[1])), m[2]);
  }

  const rows = [];
  const seen = new Set();
  const addRow = (row) => {
    const key = String(row.id);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  const withId = (raw) => {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
    let candidate = rows.length + 1;
    while (seen.has(String(candidate))) candidate++;
    return candidate;
  };

  const headerLine = lines.find((line) => line.includes('\t') && /followupdate|\bdue\b/i.test(line));
  if (headerLine) {
    const headers = headerLine.split('\t').map(norm);
    const col = (name) => headers.indexOf(norm(name));
    for (const line of lines.slice(lines.indexOf(headerLine) + 1)) {
      if (!line.includes('\t')) continue;
      const cells = line.split('\t');
      if (cells.every((c) => !c.trim())) continue;
      const get = (name) => {
        const i = col(name);
        return i >= 0 ? String(cells[i] ?? '').trim() : '';
      };
      const idRaw = get('Tracker#') || get('num') || get('id');
      const id = withId(idRaw);
      const company = get('Company');
      const due = get('FollowUpDate') || get('Due') || pins.get(String(id)) || '';
      if (!company || !validDate(due)) continue;
      addRow({
        id,
        company,
        role: get('Role') || get('subject') || '',
        due,
        status: get('Status') || '',
        type: get('Type') || '',
      });
    }
  }

  const tableHeader = lines.find((line) => /^\s*\|/.test(line) && /(^|\|)\s*company\s*(\||$)/i.test(line));
  if (tableHeader) {
    const cols = tableHeader.split('|').slice(1, -1).map(norm);
    const get = (cells, name) => {
      const i = cols.indexOf(norm(name));
      return i >= 0 ? String(cells[i] ?? '').trim() : '';
    };
    for (const line of lines.slice(lines.indexOf(tableHeader) + 1)) {
      if (!/^\s*\|/.test(line)) continue;
      const cells = line.split('|').slice(1, -1);
      if (cells.every((c) => !c.trim() || /^:?-+:?$/.test(c.trim()))) continue;
      const id = withId(get(cells, 'num') || get(cells, 'appNum') || get(cells, 'id'));
      const company = get(cells, 'company');
      const due = get(cells, 'due') || get(cells, 'FollowUpDate') || pins.get(String(id)) || nextInNote(get(cells, 'notes'));
      if (!company || !validDate(due)) continue;
      addRow({
        id,
        company,
        role: get(cells, 'role') || get(cells, 'subject') || '',
        due,
        status: get(cells, 'status') || '',
      });
    }
  }

  for (const line of lines) {
    const m = line.match(BULLET_RE);
    if (!m) continue;
    const id = Number.parseInt(m[2], 10);
    const due = pins.get(String(id)) || nextInNote(m[4] || '');
    if (!due || !validDate(due)) continue;
    addRow({ id, company: m[3].trim(), role: '', due, status: '' });
  }

  return rows;
}

export function dueFollowups(rows, today) {
  return rows.filter((row) => validDate(row.due) && row.due <= today && !CLOSED_STATUS.test(String(row.status ?? '')));
}

function short(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plain(value, max = 120) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[*_`\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return short(text, max);
}

export function buildFollowupsMessage(rows, today) {
  const lines = [
    '🔔 *Recordatorios de follow-up*',
    `${rows.length} follow-up(s) pendiente(s) para hoy o vencidos.`,
    '',
  ];
  rows.forEach((row, i) => {
    lines.push(`${i + 1}. #${row.id} · ${plain(row.company, 60)} · ${plain(row.role, 60) || 'sin rol/asunto'} · 📅 ${row.due}${row.due < today ? ' (vencido)' : ''}`);
  });
  lines.push('');
  lines.push('El borrador se prepara localmente; el envío lo hace el humano.');
  return lines.join('\n');
}

export function buildFollowupsKeyboard(rows) {
  const inline_keyboard = rows.map((row) => [{
    text: `⬜ #${row.id} ${short(row.company, 30)}`,
    callback_data: `fu:${row.id}`,
  }]);
  if (rows.length > 0) {
    const first = rows[0].id;
    inline_keyboard.push([
      { text: '📝 Preparar borradores', callback_data: 'fup' },
      { text: '✅ Ya respondió', callback_data: `fur:${first}` },
      { text: '💬 Motivo', callback_data: `fuw:${first}` },
      { text: '❌ Cerrar', callback_data: 'fux' },
    ]);
  }
  return { inline_keyboard };
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

export async function runNotifyFollowups(opts = {}) {
  const root = opts.root ?? process.cwd();
  const out = opts.out ?? console.log;
  const dryRun = Boolean(opts.dryRun);
  const all = Boolean(opts.all);
  const force = Boolean(opts.force);
  const now = opts.now ?? new Date();
  const today = opts.today ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const followupsPath = join(root, 'data/follow-ups.md');
  const statePath = join(root, 'data/automation/telegram-followups-notified.json');

  if (!existsSync(followupsPath)) {
    out('notify-followups: sin data/follow-ups.md; nada que notificar.');
    return { status: 'noop', reason: 'missing-file', rows: [] };
  }

  const rows = parseFollowupRows(readFileSync(followupsPath, 'utf-8'));
  if (rows.length === 0) {
    out('notify-followups: archivo vacío o sin filas interpretables; nada que notificar.');
    return { status: 'noop', reason: 'no-rows', rows: [] };
  }

  const state = loadNotified(statePath);
  const due = dueFollowups(rows, today);
  let skipped = 0;
  const fresh = due.filter((row) => {
    if (!all && !force && state.notified[String(row.id)]) { skipped++; return false; }
    return true;
  });

  if (fresh.length === 0) {
    out(`notify-followups: sin follow-ups nuevos (${due.length} vencidos/hoy, ${skipped} ya notificados).`);
    return { status: 'noop', reason: 'nothing-new', rows: [], skipped };
  }

  const text = buildFollowupsMessage(fresh, today);
  const keyboard = buildFollowupsKeyboard(fresh);
  const notified = {};

  if (dryRun) {
    out('[dry-run] notify-followups — mensaje:');
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
      out(`✗ notify-followups: falló el envío (${res?.error ?? 'error desconocido'}); estado sin cambios.`);
      return { status: 'error', rows: fresh, text, keyboard, error: res?.error };
    }
  }

  for (const row of fresh) {
    const record = { at: now.toISOString(), company: row.company, due: row.due };
    state.notified[String(row.id)] = record;
    notified[String(row.id)] = record;
  }
  if (!dryRun) saveNotified(statePath, state);

  out(`✅ notify-followups: ${fresh.length} follow-up(s) en un mensaje, ${skipped} ya notificados.`);
  return { status: dryRun ? 'dry-run' : 'sent', rows: fresh, text, keyboard, notified, skipped };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
  } else {
    const root = process.env.CAREER_OPS_ROOT || process.cwd();
    loadTelegramEnv(root);
    const result = await runNotifyFollowups({
      root,
      dryRun: argv.includes('--dry-run'),
      all: argv.includes('--all'),
      force: argv.includes('--force'),
    });
    if (result.status === 'error') process.exitCode = 1;
  }
}
