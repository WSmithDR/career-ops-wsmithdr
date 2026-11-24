import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNotifyAnki, buildAnkiKeyboard } from '../scripts/notify-anki.mjs';

const NOW = new Date('2026-11-23T12:00:00Z');
const STATE = 'data/automation/telegram-anki-notified.json';

function inboxLine(cardId, text, deck = 'Current::Git') {
  return `- [ ] 2026-11-23 07:05 — ANKI (fuente del perfil): "${text}" · conocimiento consolidado (due>0) — baraja "${deck}" (#${cardId}). ¿Incorporarla al perfil? Opciones: añadir a cv.md / añadir a modes/_profile.md / añadir a article-digest.md / sin cambios.`;
}

function verdict(reason, extra = {}) {
  return { relevant: true, reason, archetype: 'AI Engineer', classifiedAt: '2026-11-22', ...extra };
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'co-notify-anki-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/agent-inbox.md'), [
    '# Agent Inbox',
    inboxLine(42, 'RAG with Supabase and pgvector'),
    inboxLine(77, 'Built an n8n pipeline with a deterministic fallback', 'Projects::AI'),
    inboxLine(99, 'Music theory: modal scales'),
    '- [ ] 2026-11-23 07:06 — unrelated inbox item without a card id.',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'data/anki-relevance.json'), JSON.stringify({
    version: 1,
    entries: {
      '42': verdict('Direct evidence for the AI Engineer target role'),
      '77': verdict('Project achievement with a measurable metric', { archetype: 'AI Automation Engineer' }),
      '99': { relevant: false, reason: 'off-target music theory', archetype: '' },
    },
  }, null, 2));
  return root;
}

function capture() {
  const lines = [];
  return { out: (line) => lines.push(String(line)), text: () => lines.join('\n') };
}

function explodingSender(calls) {
  return () => { calls.push('network'); throw new Error('network must not be called'); };
}

test('dry-run prints one source-annotated summary with the exact callback contract and writes nothing', async () => {
  const root = makeRoot();
  const log = capture();
  const calls = [];
  const result = await runNotifyAnki({ root, now: NOW, dryRun: true, out: log.out, sender: explodingSender(calls) });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.proposals.length, 2);
  assert.equal((log.text().match(/🧠 \*Propuestas Anki → perfil\*/g) || []).length, 1);
  assert.ok(log.text().includes('**Source:** tarjeta Anki, baraja "Current::Git", #42'));
  assert.ok(log.text().includes('Direct evidence for the AI Engineer target role'));
  assert.ok(log.text().includes('Nada se escribe hasta que toques Aprobar'));
  assert.ok(log.text().includes('nunca se envía ninguna postulación'));
  assert.equal(log.text().includes('modal scales'), false);
  assert.equal(log.text().includes('Music theory'), false);
  assert.deepEqual(result.proposals.map((p) => p.target), ['cv.md', 'article-digest.md']);
  assert.deepEqual(
    result.keyboard.inline_keyboard.map((row) => row.map((b) => b.callback_data)),
    [['ak:42'], ['ak:77'], ['aka', 'akw:42', 'akx']],
  );
  assert.ok(result.keyboard.inline_keyboard[0][0].text.startsWith('⬜ #42'));
  assert.equal(existsSync(join(root, STATE)), false);
  assert.equal(existsSync(join(root, `${STATE}.tmp`)), false);
  assert.deepEqual(calls, []);
});

test('delta skips notified cards, --all includes them, and irrelevant cards never appear', async () => {
  const root = makeRoot();
  const log = capture();
  const sent = [];
  const sender = async (msg) => { sent.push(msg); return { ok: true }; };
  const first = await runNotifyAnki({ root, now: NOW, out: log.out, sender });
  assert.equal(first.status, 'sent');
  assert.equal(sent.length, 1);
  const state = JSON.parse(readFileSync(join(root, STATE), 'utf-8'));
  assert.deepEqual(state, {
    version: 1,
    notified: {
      '42': { at: NOW.toISOString(), deck: 'Current::Git', target: 'cv.md' },
      '77': { at: NOW.toISOString(), deck: 'Projects::AI', target: 'article-digest.md' },
    },
  });

  const second = await runNotifyAnki({ root, now: NOW, out: log.out, sender });
  assert.equal(second.status, 'noop');
  assert.equal(sent.length, 1);

  const all = await runNotifyAnki({ root, now: NOW, all: true, out: log.out, sender });
  assert.equal(all.status, 'sent');
  assert.equal(all.proposals.length, 2);
  assert.equal(sent.length, 2);
  assert.equal(all.text.includes('99'), false);
  assert.deepEqual(buildAnkiKeyboard(all.proposals).inline_keyboard.at(-1).map((b) => b.callback_data), ['aka', 'akw:42', 'akx']);
});

test('--force re-notifies and --limit caps one summary', async () => {
  const root = makeRoot();
  const log = capture();
  let sends = 0;
  const sender = async () => { sends++; return { ok: true }; };
  await runNotifyAnki({ root, now: NOW, out: log.out, sender });
  const forced = await runNotifyAnki({ root, now: NOW, force: true, limit: 1, out: log.out, sender });
  assert.equal(forced.status, 'sent');
  assert.equal(forced.proposals.length, 1);
  assert.equal(sends, 2);
  assert.deepEqual(forced.keyboard.inline_keyboard.map((row) => row[0].callback_data), ['ak:42', 'aka']);
  assert.equal(forced.keyboard.inline_keyboard.length, 2);
  assert.equal(Object.keys(forced.notified).length, 1);
});

test('failed send leaves the delta state untouched', async () => {
  const root = makeRoot();
  const log = capture();
  const result = await runNotifyAnki({ root, now: NOW, out: log.out, sender: async () => ({ ok: false, error: 'boom' }) });
  assert.equal(result.status, 'error');
  assert.equal(existsSync(join(root, STATE)), false);
});
