// tests/anki-profile-feed.mjs — anki-profile-feed.mjs reads decks from
// AnkiConnect and appends one confirm entry per new card to
// data/agent-inbox.md; data/anki-seen.json dedupes; nothing auto-submits.
//
// Run:  node --test tests/anki-profile-feed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCards, entryText, readAnkiCards, readSeen, runFeed } from '../anki-profile-feed.mjs';

/** Fake AnkiConnect v1: decks.list, cards.search, cards.getMany, notes.getMany. */
async function fakeAnkiServer(cards, queries = []) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { method, params } = JSON.parse(body);
        let result;
        if (method === 'decks.list') {
          result = [
            { id: '1', name: 'Anki Escuela' },
            { id: '2', name: 'AutomatedFilteringConfigDeck' },
            { id: '3', name: 'Filtered Deck 11:18' },
          ];
        } else if (method === 'cards.search') {
          queries.push(params ?? {});
          result = { ids: cards.map((c) => String(c.cardId)), nextCursor: null };
        } else if (method === 'cards.getMany') {
          const ids = new Set((params?.ids ?? []).map(String));
          result = {
            items: cards
              .filter((c) => ids.has(String(c.cardId)))
              .map((c, index) => ({
                index,
                result: {
                  id: String(c.cardId),
                  noteId: String(c.cardId),
                  deck: { name: c.deckName ?? 'Anki Escuela' },
                  scheduling: c.scheduling ?? null,
                },
              })),
          };
        } else if (method === 'notes.getMany') {
          const ids = new Set((params?.ids ?? []).map(String));
          result = {
            items: cards
              .filter((c) => ids.has(String(c.cardId)))
              .map((c, index) => ({ index, result: { id: String(c.cardId), fields: c.fields } })),
          };
        } else {
          result = null;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const NOW = new Date('2026-11-22T09:15:00');

test('readAnkiCards skips internal/generated decks', async () => {
  const { isInternalDeck } = await import('../anki-profile-feed.mjs');
  assert.ok(isInternalDeck('AutomatedFilteringConfigDeck'));
  assert.ok(isInternalDeck('Filtered Deck 11:18'));
  assert.ok(isInternalDeck('recovered1792343995669'));
  assert.equal(isInternalDeck('Current::Git'), false);
  const server = await fakeAnkiServer([{ cardId: 7, fields: { Front: 'real card' } }]);
  try {
    const read = await (await import('../anki-profile-feed.mjs')).readAnkiCards({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.decks.map((d) => d.name), ['Anki Escuela'], 'only the study deck is read');
  } finally {
    server.close();
  }
});

test('newCards dedupes seen ids across decks and runs', () => {
  const decks = [
    { name: 'D1', cards: [{ cardId: 7, fields: { Front: 'a' } }, { cardId: 8, fields: { Front: 'b' } }] },
    { name: 'D2', cards: [{ cardId: 7, fields: { Front: 'a' } }, { cardId: 9, fields: { Front: 'c' } }] },
  ];
  const fresh = newCards(decks, [7]);
  assert.deepEqual(fresh.map((c) => c.cardId), [8, 9], 'duplicates (seen or cross-deck) are dropped');
  assert.equal(fresh[0].deck, 'D1');
});

test('entryText builds an agent-inbox confirm question naming deck and card', () => {
  const line = entryText({ date: '2026-11-22 09:15', deck: 'Anki Escuela', cardId: 42, fields: { Front: 'Tarjeta uno', Back: 'Reverso' } });
  assert.ok(line.startsWith('- [ ] 2026-11-22 09:15 — ANKI (fuente del perfil)'), line);
  assert.ok(line.includes('Tarjeta uno') && line.includes('Reverso'), line);
  assert.ok(line.includes('Anki Escuela') && line.includes('42'), line);
  assert.match(line, /¿Incorporarla al perfil\?/, line);
  assert.match(line, /añadir a cv\.md/, line);
});

test('runFeed appends one entry per new card and dedupes on the next run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-feed-'));
  const cards = [
    { cardId: 7, fields: { Front: 'Tarjeta uno', Back: 'Reverso uno' } },
    { cardId: 8, fields: { Front: 'Tarjeta dos' } },
  ];
  const server = await fakeAnkiServer(cards);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const printed = await runFeed({ root, baseUrl: base, print: true, now: NOW });
    assert.equal(printed.status, 'ok');
    assert.equal(printed.newCards, 2);
    assert.equal(existsSync(join(root, 'data/agent-inbox.md')), false, '--print must not append');

    const r1 = await runFeed({ root, baseUrl: base, now: NOW });
    assert.equal(r1.status, 'ok');
    assert.equal(r1.newCards, 2);
    assert.equal(r1.appended, 2);
    const inbox = readFileSync(join(root, 'data/agent-inbox.md'), 'utf8');
    assert.ok(inbox.includes('Tarjeta uno'));
    assert.ok(inbox.includes('Tarjeta dos'));
    assert.deepEqual(readSeen(join(root, 'data/anki-seen.json')).sort(), [7, 8]);

    const r2 = await runFeed({ root, baseUrl: base, now: NOW });
    assert.equal(r2.newCards, 0, 'a card is offered once');
    assert.equal(readFileSync(join(root, 'data/agent-inbox.md'), 'utf8').trim(), inbox.trim());
  } finally {
    server.close();
  }
});

test('runFeed offers at most --limit cards and defers the rest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-limit-'));
  const cards = [
    { cardId: 7, fields: { Front: 'uno' } },
    { cardId: 8, fields: { Front: 'dos' } },
    { cardId: 9, fields: { Front: 'tres' } },
  ];
  const server = await fakeAnkiServer(cards);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await runFeed({ root, baseUrl: base, limit: 2, now: NOW });
    assert.equal(first.newCards, 3);
    assert.equal(first.offered, 2);
    assert.equal(first.deferred, 1);
    assert.deepEqual(readSeen(join(root, 'data/anki-seen.json')).sort(), [7, 8]);
    const second = await runFeed({ root, baseUrl: base, limit: 2, now: NOW });
    assert.equal(second.offered, 1, 'the deferred card is offered next run');
    assert.equal(second.deferred, 0);
  } finally {
    server.close();
  }
});

test('runFeed is offline when AnkiConnect is not running (nothing written)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-off-'));
  const result = await runFeed({ root, baseUrl: 'http://127.0.0.1:9', now: NOW });
  assert.equal(result.status, 'offline');
  assert.equal(result.newCards, 0);
  assert.equal(existsSync(join(root, 'data/agent-inbox.md')), false);
  assert.equal(readSeen(join(root, 'data/anki-seen.json')).length, 0);
});

test('readAnkiCards reviewOnly queries prop:due>0 and marks cards consolidated', async () => {
  const queries = [];
  const server = await fakeAnkiServer([
    { cardId: 11, fields: { Front: 'review card' }, scheduling: { type: 'review', due: { kind: 'day', day: 1900 }, repetitions: 3 } },
  ], queries);
  try {
    const read = await readAnkiCards({ baseUrl: `http://127.0.0.1:${server.address().port}`, reviewOnly: true });
    assert.ok(queries.some((q) => q.query === 'prop:due>0'), 'the consolidated-knowledge query is used');
    assert.equal(read.decks.length, 1);
    assert.equal(read.decks[0].cards[0].consolidated, true);
  } finally {
    server.close();
  }
});

test('llm feed classifies consolidated cards once, caches expiry and offers only relevant ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-llm-'));
  const cards = [
    { cardId: 11, fields: { Front: 'RAG with Supabase' }, scheduling: { type: 'review', due: { kind: 'day', day: 1900 }, repetitions: 3 } },
    { cardId: 12, fields: { Front: 'music theory' }, scheduling: { type: 'review', due: { kind: 'day', day: 1901 }, repetitions: 2 } },
  ];
  const server = await fakeAnkiServer(cards);
  let calls = 0;
  const classifier = async (batch) => {
    calls++;
    return new Map(batch.map((c) => [String(c.cardId), {
      relevant: String(c.fields.Front).includes('RAG'),
      reason: 'test verdict',
      archetype: 'AI Engineer',
    }]));
  };
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const opts = { root, baseUrl: base, llm: true, classifier, now: NOW };
    const first = await runFeed(opts);
    assert.equal(first.classified, 2);
    assert.equal(first.offered, 1, 'only the relevant card is offered');
    assert.ok(first.entries[0].includes('RAG'));
    assert.ok(first.entries[0].includes('conocimiento consolidado'));
    const cachePath = join(root, 'data/anki-relevance.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.entries['11'].relevant, true);
    assert.equal(cache.entries['11'].expiresAt, '2026-12-22');
    assert.equal(cache.entries['12'].relevant, false);
    assert.deepEqual(readSeen(join(root, 'data/anki-seen.json')).sort(), [11, 12]);

    const second = await runFeed(opts);
    assert.equal(calls, 1, 'a fresh cache entry is not reclassified');
    assert.equal(second.offered, 0, 'already offered cards are not repeated');

    cache.entries['11'].expiresAt = '2026-11-21';
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    const third = await runFeed(opts);
    assert.equal(calls, 2, 'an expired entry is rechecked');
    assert.equal(third.rechecked, 1);
    assert.equal(third.classified, 1);
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).entries['11'].expiresAt, '2026-12-22');

    cards[1].scheduling.due.day = 1999;
    const fourth = await runFeed(opts);
    assert.equal(calls, 3, 'a changed Anki due date triggers a recheck');
    assert.equal(fourth.classified, 1);
  } finally {
    server.close();
  }
});

test('classifyLimit bounds a preview to N cards without writing the cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-anki-classify-limit-'));
  const cards = [
    { cardId: 21, fields: { Front: 'RAG with Supabase' }, scheduling: { type: 'review', due: { kind: 'day', day: 1900 }, repetitions: 3 } },
    { cardId: 22, fields: { Front: 'music theory' }, scheduling: { type: 'review', due: { kind: 'day', day: 1901 }, repetitions: 2 } },
    { cardId: 23, fields: { Front: 'Kubernetes operators' }, scheduling: { type: 'review', due: { kind: 'day', day: 1902 }, repetitions: 1 } },
  ];
  const server = await fakeAnkiServer(cards);
  let seenIds = [];
  const classifier = async (batch) => {
    seenIds = batch.map((c) => c.cardId);
    return new Map(batch.map((c) => [String(c.cardId), {
      relevant: String(c.fields.Front).includes('RAG'),
      reason: 'test verdict',
      archetype: 'AI Engineer',
    }]));
  };
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await runFeed({
      root, baseUrl: base, llm: true, classifier, now: NOW,
      print: true, limit: 3, classifyLimit: 2,
    });
    assert.deepEqual(seenIds, [21, 22]);
    assert.equal(result.pendingClassify, 2);
    assert.equal(result.classified, 2);
    assert.equal(result.offered, 1);
    assert.match(result.entries[0], /RAG/);
    assert.equal(existsSync(join(root, 'data/anki-relevance.json')), false);
  } finally {
    server.close();
  }
});
