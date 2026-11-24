import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNotifyFollowups, parseFollowupRows, buildFollowupsKeyboard } from '../scripts/notify-followups.mjs';

const NOW = new Date('2026-11-23T12:00:00Z');
const TODAY = '2026-11-23';
const STATE = 'data/automation/telegram-followups-notified.json';
const HEADER = 'Date\tTracker#\tCompany\tRole\tFollowUpDate\tType\tStatus';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'co-notify-followups-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/follow-ups.md'), [
    HEADER,
    `2026-11-06\t2\t2026-09-26\tNiuro\t2026-11-13\tfirst-follow-up\tpendiente`,
    `2026-11-06\t43\t2026-11-06\tchainguard\t${TODAY}\tfirst-follow-up\tpendiente`,
    `2026-11-06\t46\t2026-11-06\tCustomer.io\t2026-12-01\tfirst-follow-up\tpendiente`,
    `2026-11-06\t47\t2026-11-06\tExample SA\t2026-11-20\tfirst-follow-up\trespondido`,
    '',
  ].join('\n'));
  return root;
}

function capture() {
  const lines = [];
  return { out: (line) => lines.push(String(line)), text: () => lines.join('\n') };
}

test('due detection uses only the dated rows that are pending', () => {
  const root = makeRoot();
  const rows = parseFollowupRows(readFileSync(join(root, 'data/follow-ups.md'), 'utf-8'));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.id), [2, 43, 46, 47]);
  assert.equal(rows[0].company, '2026-09-26');
  assert.equal(rows[0].role, 'Niuro');
});

test('dry-run prints the message and keyboard JSON with no network and no state write', async () => {
  const root = makeRoot();
  const log = capture();
  const calls = [];
  const result = await runNotifyFollowups({
    root, now: NOW, dryRun: true, out: log.out,
    sender: () => { calls.push('network'); throw new Error('network must not be called'); },
  });
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(result.rows.map((r) => r.id), [2, 43]);
  assert.equal((log.text().match(/🔔 \*Recordatorios de follow-up\*/g) || []).length, 1);
  assert.ok(log.text().includes('Niuro'));
  assert.ok(log.text().includes('chainguard'));
  assert.ok(log.text().includes('📅 2026-11-13 (vencido)'));
  assert.ok(log.text().includes('📅 2026-11-23'));
  assert.ok(log.text().includes('el envío lo hace el humano'));
  assert.equal(log.text().includes('Customer.io'), false);
  assert.equal(log.text().includes('Example SA'), false);
  assert.ok(log.text().includes('"callback_data":"fu:2"'));
  assert.deepEqual(
    result.keyboard.inline_keyboard.map((row) => row.map((b) => b.callback_data)),
    [['fu:2'], ['fu:43'], ['fup', 'fur:2', 'fuw:2', 'fux'], ['ca']],
  );
  assert.equal(existsSync(join(root, STATE)), false);
  assert.equal(existsSync(join(root, `${STATE}.tmp`)), false);
  assert.deepEqual(calls, []);
});

test('delta skips already-notified rows, --all and --force re-notify', async () => {
  const root = makeRoot();
  const log = capture();
  const sends = [];
  const sender = async (msg) => { sends.push(msg); return { ok: true }; };
  const first = await runNotifyFollowups({ root, now: NOW, out: log.out, sender });
  assert.equal(first.status, 'sent');
  assert.equal(sends.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(root, STATE), 'utf-8')), {
    version: 1,
    notified: {
      '2': { at: NOW.toISOString(), company: '2026-09-26', due: '2026-11-13' },
      '43': { at: NOW.toISOString(), company: '2026-11-06', due: TODAY },
    },
  });

  const second = await runNotifyFollowups({ root, now: NOW, out: log.out, sender });
  assert.equal(second.status, 'noop');
  assert.equal(sends.length, 1);

  const all = await runNotifyFollowups({ root, now: NOW, all: true, out: log.out, sender });
  assert.equal(all.status, 'sent');
  assert.deepEqual(all.rows.map((r) => r.id), [2, 43]);
  assert.equal(sends.length, 2);

  const forced = await runNotifyFollowups({ root, now: NOW, force: true, out: log.out, sender });
  assert.equal(forced.status, 'sent');
  assert.equal(sends.length, 3);
  assert.deepEqual(buildFollowupsKeyboard(forced.rows).inline_keyboard.at(-2).map((b) => b.callback_data), ['fup', 'fur:2', 'fuw:2', 'fux']);
  assert.deepEqual(buildFollowupsKeyboard(forced.rows).inline_keyboard.at(-1).map((b) => b.callback_data), ['ca']);
});

test('missing or empty follow-ups file is a zero-send no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-notify-followups-empty-'));
  mkdirSync(join(root, 'data'));
  const log = capture();
  const missing = await runNotifyFollowups({ root, now: NOW, out: log.out, sender: async () => ({ ok: false }) });
  assert.equal(missing.status, 'noop');
  writeFileSync(join(root, 'data/follow-ups.md'), '');
  const empty = await runNotifyFollowups({ root, now: NOW, out: log.out, sender: async () => ({ ok: false }) });
  assert.equal(empty.status, 'noop');
  assert.equal(existsSync(join(root, STATE)), false);
  assert.ok(log.text().includes('nada que notificar'));
});

test('markdown pins and bullets are parsed without inventing a company', () => {
  const rows = parseFollowupRows([
    '# Follow-ups',
    '',
    '| num | appNum | date | company | role | channel | contact | notes |',
    '|---|---|---|---|---|---|---|---|',
    '| 1 | 7 | 2026-11-01 | Acme | Engineer | email | a@b.c | next 2026-11-20 |',
    '- 2026-11-02 · #9 Globex — pendiente',
    '- next #9 2026-11-21',
    '- next #4242 2026-11-05',
    '',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => r.id), [1, 9]);
  assert.equal(rows[0].due, '2026-11-20');
  assert.equal(rows[1].due, '2026-11-21');
  assert.equal(rows[1].company, 'Globex');
});
