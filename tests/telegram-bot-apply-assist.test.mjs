import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

test('telegram bot exposes assist command and never submits', () => {
  const src = readFileSync(join(ROOT, 'scripts/telegram-bot.mjs'), 'utf8');
  assert.match(src, /\/assist N\s+Instrucciones de apply asistido/);
  assert.match(src, /assist: cmdAssist/);
  assert.match(src, /node scripts\/apply-assist\.mjs/);
  assert.match(src, /NUNCA hace submit automático/);
  assert.doesNotMatch(src, /auto-submit|click submit/i);
});
