import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyWithOpencode } from '../lib/anki-relevance.mjs';

const FAKE_BIN = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const prompt = process.argv.slice(2).find((a) => a.includes('Write ONLY')) ?? '';
const out = prompt.match(/Write ONLY (\\S+?\\.json)(?=\\.|\\s|$)/)?.[1];
const hold = Number(process.env.FAKE_HOLD_MS ?? 0);
if (hold > 0) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + hold + ')'], { stdio: 'inherit' });
  child.unref();
}
if (process.env.FAKE_FAIL === '1') {
  process.stderr.write('boom from fake classifier\\n');
  process.exit(3);
}
if (process.env.FAKE_QUOTA === '1') {
  process.stderr.write('AI_APICallError: Free usage limit reached\\n');
  setTimeout(() => {}, 30000);
} else {
  writeFileSync(out, JSON.stringify({ classifications: [{ cardId: '7', relevant: true, reason: 'fake verdict', archetype: 'AI Engineer' }] }));
}
`;

function fakeClassifier(root, env = {}) {
  const bin = join(root, 'fake-opencode.mjs');
  writeFileSync(bin, FAKE_BIN, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

test('classifyWithOpencode does not wait for descendants holding inherited stdio', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-classify-io-'));
  const bin = fakeClassifier(root);
  const previousBin = process.env.OPENCODE_BIN;
  const previousHold = process.env.FAKE_HOLD_MS;
  process.env.OPENCODE_BIN = bin;
  process.env.FAKE_HOLD_MS = '4000';
  try {
    const started = Date.now();
    const verdicts = await classifyWithOpencode([{ cardId: 7, fields: { Front: 'RAG with Supabase' } }], {
      root, batchSize: 1, timeoutMs: 1500,
    });
    const elapsed = Date.now() - started;
    assert.equal(verdicts.get('7').relevant, true);
    assert.ok(elapsed < 2000, `classifier waited ${elapsed}ms for a child holding stdio`);
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousHold === undefined) delete process.env.FAKE_HOLD_MS;
    else process.env.FAKE_HOLD_MS = previousHold;
  }
});

test('classifyWithOpencode reports the child transcript when the classifier fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-classify-fail-'));
  const bin = fakeClassifier(root);
  const previousBin = process.env.OPENCODE_BIN;
  const previousFail = process.env.FAKE_FAIL;
  process.env.OPENCODE_BIN = bin;
  process.env.FAKE_FAIL = '1';
  try {
    await assert.rejects(
      classifyWithOpencode([{ cardId: 7, fields: { Front: 'RAG' } }], { root, batchSize: 1, timeoutMs: 5000 }),
      /boom from fake classifier/,
    );
    const logs = readdirSync(join(root, 'data/automation-logs')).filter((f) => f.startsWith('anki-classify-'));
    assert.equal(logs.length, 1);
    assert.match(readFileSync(join(root, 'data/automation-logs', logs[0]), 'utf8'), /boom from fake classifier/);
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousFail === undefined) delete process.env.FAKE_FAIL;
    else process.env.FAKE_FAIL = previousFail;
  }
});

test('classifyWithOpencode stops promptly when the model reports free usage limit reached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-classify-quota-'));
  const bin = fakeClassifier(root);
  const previousBin = process.env.OPENCODE_BIN;
  const previousQuota = process.env.FAKE_QUOTA;
  process.env.OPENCODE_BIN = bin;
  process.env.FAKE_QUOTA = '1';
  try {
    const started = Date.now();
    await assert.rejects(
      classifyWithOpencode([{ cardId: 7, fields: { Front: 'RAG' } }], { root, batchSize: 1, timeoutMs: 30000 }),
      /free usage limit reached/i,
    );
    assert.ok(Date.now() - started < 10000, 'quota is detected without waiting for the batch timeout');
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousQuota === undefined) delete process.env.FAKE_QUOTA;
    else process.env.FAKE_QUOTA = previousQuota;
  }
});
