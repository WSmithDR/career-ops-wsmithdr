import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const src = readFileSync(join(ROOT, 'scripts/telegram-bot.mjs'), 'utf8');

test('telegram bot exposes assist command and never submits', () => {
  assert.match(src, /\/assist N\s+Instrucciones de apply asistido/);
  assert.match(src, /assist: cmdAssist/);
  assert.match(src, /node scripts\/apply-assist\.mjs/);
  assert.match(src, /NUNCA hace submit automático/);
  assert.doesNotMatch(src, /auto-submit|click submit/i);
});

test('telegram bot subscribes to callback_query and authorizes callbacks', () => {
  assert.match(src, /allowed_updates:\s*JSON\.stringify\(\[[^\]]*'callback_query'[^\]]*\]\)/);
  assert.match(src, /if \(update\?\.callback_query\) return handleCallback/);
  assert.match(src, /String\(cb\?\.from\?\.id\) !== String\(ctx\.chatId\)/);
  assert.match(src, /answerCallbackQuery/);
});

test('telegram bot adds no slash commands beyond the supported set', () => {
  const supported = ['apply', 'assist', 'cv', 'help', 'list', 'notsent', 'sent', 'skip', 'start', 'status'];
  const block = src.match(/const COMMANDS = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(block, 'COMMANDS registry not found');
  const commands = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(commands, supported);
  const usage = src.match(/const USAGE = `([\s\S]*?)`;/)?.[1] || '';
  const documented = [...usage.matchAll(/^\s*\/(\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(documented)], supported);
});
