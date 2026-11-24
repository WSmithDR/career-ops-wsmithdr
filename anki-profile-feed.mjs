#!/usr/bin/env node
/**
 * anki-profile-feed.mjs — Anki decks as a feed of profile confirmations.
 *
 * Reads the user's decks through AnkiConnect's v1 API (default
 * http://127.0.0.1:8765/api/v1, overridable with ANKI_BASE_URL) and appends
 * confirm entries for new cards to data/agent-inbox.md — the durable bridge
 * (modes/agent-inbox.md): nothing auto-submits, the user confirms in the next
 * session. Nothing here writes cv.md, modes/_profile.md or article-digest.md.
 *
 * Read-only toward Anki: `decks.list`, `cards.search`, `cards.getMany` and
 * `notes.getMany` (all v1 JSON-RPC). The legacy `findCards` action returns
 * [] on current AnkiConnect, so the feed deliberately uses v1 only.
 *
 * State: data/anki-seen.json (user layer) — cards already offered. A run
 * offers at most --limit cards (default 100, or ANKI_FEED_LIMIT); the rest stay
 * for later runs, so a large collection does not flood the inbox on the first
 * day.
 *
 * Run:
 *   node anki-profile-feed.mjs                    # append up to 100 confirmations
 *   node anki-profile-feed.mjs --llm              # LLM relevance filter + cache
 *   node anki-profile-feed.mjs --llm --print --limit 3 --classify-limit 3
 *                                                 # cheap preview: classify 3 only
 *   node anki-profile-feed.mjs --limit 5 --print  # preview 5, no writes
 *   ANKI_FEED_LIMIT=250 node anki-profile-feed.mjs
 *
 * Daily automation (the user's choice):
 *   0 7 * * * cd /path/to/career-ops && node anki-profile-feed.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localToday } from './lib/local-today.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  RELEVANCE_TTL_DAYS,
  addDays,
  cardScheduling,
  classifyWithOpencode,
  classifyWithOpenRouter,
  loadClassifierEnv,
  loadRelevanceCache,
  needsRecheck,
  relevanceCachePath,
  saveRelevanceCache,
  schedulingFingerprint,
} from './lib/anki-relevance.mjs';

const DEFAULT_BASE = 'http://localhost:8765';
const V1_PATH = '/api/v1';
const ANKI_TIMEOUT_MS = 5000;
export const DEFAULT_LIMIT = 100;

/** AnkiConnect v1 JSON-RPC call; returns the `result` payload or throws. */
async function ankiV1Call(base, method, params = {}) {
  const res = await fetch(`${base}${V1_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(ANKI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(JSON.stringify(json.error));
  return json?.result;
}

/** Anki search query for a deck, quoted for names with spaces or '::'. */
function deckQuery(name) {
  return `deck:"${String(name).replace(/"/g, '\\"')}"`;
}

/** Internal/generated decks that are not study material for the profile feed. */
export function isInternalDeck(name) {
  return /^(?:AutomatedFiltering|Filtered Deck\b|recovered\d)/i.test(String(name ?? ''));
}

async function searchAll(base, query) {
  const ids = [];
  let cursor;
  do {
    const page = await ankiV1Call(base, 'cards.search', { query, limit: 1000, ...(cursor ? { cursor } : {}) });
    ids.push(...(page?.ids ?? []).map(String));
    cursor = page?.nextCursor || undefined;
  } while (cursor && ids.length < 50000);
  return ids;
}

async function fetchCards(base, ids) {
  const items = [];
  for (let i = 0; i < ids.length; i += 500) {
    const page = await ankiV1Call(base, 'cards.getMany', { ids: ids.slice(i, i + 500) });
    items.push(...(page?.items ?? []));
  }
  return items;
}

async function fieldsForNotes(base, cardItems) {
  const ids = [...new Set(cardItems.map((it) => String(it?.result?.noteId)).filter(Boolean))];
  const byNote = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const page = await ankiV1Call(base, 'notes.getMany', { ids: ids.slice(i, i + 500) });
    for (const item of page?.items ?? []) {
      const raw = item?.result?.fields ?? {};
      const fields = {};
      for (const [field, value] of Object.entries(raw)) {
        const text = value === undefined || value === null ? '' : String(value);
        if (text.trim()) fields[field] = text;
      }
      byNote.set(String(item?.result?.id), fields);
    }
  }
  return byNote;
}

function toCards(cardItems, fieldsByNote, consolidated) {
  return cardItems.map((it) => {
    const cardId = Number(it?.result?.id);
    if (!Number.isFinite(cardId)) return null;
    const scheduling = it?.result?.scheduling ?? null;
    return {
      cardId,
      deckName: String(it?.result?.deck?.name ?? ''),
      fields: fieldsByNote.get(String(it?.result?.noteId)) ?? {},
      scheduling,
      consolidated: consolidated ?? cardScheduling({ scheduling }).consolidated,
    };
  }).filter(Boolean);
}

/**
 * Read decks and their cards from AnkiConnect v1. With `reviewOnly`, select
 * `prop:due>0` (consolidated knowledge) instead of every card.
 *
 * @returns {Promise<{status: 'ok'|'offline', decks: {name: string, cards: {cardId: number, fields: Record<string, string>}[]}[]}>}
 */
export async function readAnkiCards(opts = {}) {
  const base = String(opts.baseUrl || process.env.ANKI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    if (opts.reviewOnly) {
      const ids = await searchAll(base, 'prop:due>0');
      const cardItems = ids.length ? await fetchCards(base, ids) : [];
      const byNote = cardItems.length ? await fieldsForNotes(base, cardItems) : new Map();
      const groups = new Map();
      for (const card of toCards(cardItems, byNote, true)) {
        if (!card.deckName || isInternalDeck(card.deckName)) continue;
        if (!groups.has(card.deckName)) groups.set(card.deckName, []);
        groups.get(card.deckName).push(card);
      }
      return { status: 'ok', decks: [...groups].map(([name, cards]) => ({ name, cards })) };
    }
    const decksResult = await ankiV1Call(base, 'decks.list');
    const decksIn = Array.isArray(decksResult) ? decksResult : (decksResult?.decks ?? []);
    if (!Array.isArray(decksIn)) return { status: 'offline', decks: [] };
    const decks = [];
    for (const deck of decksIn) {
      const name = typeof deck === 'string' ? deck : deck.name;
      if (!name || isInternalDeck(name)) continue;
      const ids = await searchAll(base, deckQuery(name));
      const cardItems = ids.length ? await fetchCards(base, ids) : [];
      const byNote = cardItems.length ? await fieldsForNotes(base, cardItems) : new Map();
      decks.push({ name: String(name), cards: toCards(cardItems, byNote) });
    }
    return { status: 'ok', decks };
  } catch {
    return { status: 'offline', decks: [] };
  }
}

/** Cards not yet in `seen` (deduped by cardId across decks and runs). */
export function newCards(decks, seen) {
  const seenIds = new Set(seen);
  const fresh = [];
  const emitted = new Set();
  for (const deck of decks) {
    for (const card of deck.cards) {
      if (seenIds.has(card.cardId) || emitted.has(card.cardId)) continue;
      emitted.add(card.cardId);
      fresh.push({ deck: deck.name, cardId: card.cardId, fields: card.fields });
    }
  }
  return fresh;
}

/** Build the agent-inbox confirm question for one card. */
export function entryText({ date, deck, cardId, fields, consolidated = false }) {
  const text = Object.values(fields ?? {}).map((v) => String(v).trim()).filter(Boolean).join(' | ');
  return `- [ ] ${date} — ANKI (fuente del perfil):${text ? ` "${text}"` : ''}${consolidated ? ' · conocimiento consolidado (due>0)' : ''} — baraja "${deck}" (#${cardId}). ¿Incorporarla al perfil? Opciones: añadir a cv.md / añadir a modes/_profile.md / añadir a article-digest.md / sin cambios.`;
}

/** data/anki-seen.json → [cardId, ...]; missing or malformed = nothing seen. */
export function readSeen(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && Array.isArray(parsed.seen)) return parsed.seen.filter((v) => v !== undefined && v !== null);
  } catch {
    /* missing or malformed state: nothing seen yet */
  }
  return [];
}

function writeSeen(path, ids) {
  writeFileSync(path, `${JSON.stringify({ seen: [...new Set(ids)].sort((a, b) => a - b) }, null, 2)}\n`);
}

function appendInbox(path, lines) {
  mkdirSync(dirname(path), { recursive: true });
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const body = prev.length === 0 ? '' : prev.endsWith('\n') ? prev : `${prev}\n`;
  writeFileSync(path, `${body}${lines.join('\n')}\n`);
}

/**
 * One feed run: read cards, pick up to `limit` new ones, append their confirm
 * entries to data/agent-inbox.md and mark only those in data/anki-seen.json.
 * Offline (Anki not running): no writes, status offline.
 *
 * @returns {Promise<{status, decks, cards, newCards, offered, deferred, appended, entries}>}
 */
export async function runFeed(opts = {}) {
  const root = opts.root ?? getCareerOpsRoot();
  const inboxPath = join(root, 'data/agent-inbox.md');
  const seenPath = join(root, 'data/anki-seen.json');
  const now = opts.now ?? new Date();
  const today = localToday(now);
  const when = `${today} ${now.toTimeString().slice(0, 5)}`;
  const configuredLimit = opts.limit ?? (process.env.ANKI_FEED_LIMIT === undefined ? undefined : Number(process.env.ANKI_FEED_LIMIT));
  const limit = Number.isInteger(configuredLimit) && configuredLimit >= 0 ? configuredLimit : DEFAULT_LIMIT;
  const llm = Boolean(opts.llm);
  const ttlDays = Number.isInteger(opts.ttlDays) && opts.ttlDays > 0 ? opts.ttlDays : RELEVANCE_TTL_DAYS;

  const result = await readAnkiCards({ baseUrl: opts.baseUrl, reviewOnly: llm });
  if (result.status !== 'ok') {
    return { status: 'offline', decks: 0, cards: 0, newCards: 0, offered: 0, deferred: 0, appended: 0, entries: [] };
  }
  const seen = new Set(readSeen(seenPath));
  const previouslySeen = new Set(seen);
  const fresh = newCards(result.decks, seen);
  const cards = result.decks.reduce((n, d) => n + d.cards.length, 0);
  const cachePath = relevanceCachePath(root);
  const cache = llm ? loadRelevanceCache(cachePath) : { entries: {} };
  let classification = new Map();
  let classified = 0;
  let rechecked = 0;
  let llmError = null;
  let pendingClassify = 0;

  if (llm) {
    const allById = new Map();
    for (const deck of result.decks) for (const card of deck.cards) allById.set(String(card.cardId), card);
    const classifyAll = new Map();
    for (const [id, card] of allById) {
      if (needsRecheck(cache.entries[id], schedulingFingerprint(cardScheduling(card)), today, ttlDays)) {
        classifyAll.set(id, card);
      }
    }
    const toClassify = Number.isInteger(opts.classifyLimit) && opts.classifyLimit >= 0
      ? new Map([...classifyAll].slice(0, opts.classifyLimit))
      : classifyAll;
    pendingClassify = toClassify.size;
    const hadEntry = new Set(Object.keys(cache.entries));
    const applyVerdicts = (verdicts) => {
      for (const [id, verdict] of verdicts) {
        const card = allById.get(id);
        if (!card) continue;
        const info = cardScheduling(card);
        cache.entries[id] = {
          ...verdict,
          consolidated: true,
          dueDay: info.dueDay,
          schedulingFingerprint: schedulingFingerprint(info),
          classifiedAt: today,
          expiresAt: addDays(today, ttlDays),
        };
      }
      if (!opts.print) saveRelevanceCache(cachePath, cache);
    };
    if (toClassify.size > 0) {
      try {
        const classifier = opts.classifier ?? (loadClassifierEnv() ? classifyWithOpenRouter : classifyWithOpencode);
        const results = new Map();
        const returned = await classifier([...toClassify.values()], {
          root, today,
          batchSize: opts.classifyBatchSize,
          results,
          onChunk: applyVerdicts,
        });
        classification = returned instanceof Map ? returned : (results.size ? results : new Map(Object.entries(returned ?? {})));
        classified = classification.size;
        rechecked = [...toClassify.keys()].filter((id) => hadEntry.has(id)).length;
      } catch (err) {
        llmError = err?.message ?? String(err);
      }
    }
    applyVerdicts(classification);
  }

  const relevantCards = llm
    ? [...new Map(result.decks.flatMap((d) => d.cards).map((c) => [String(c.cardId), c])).values()]
      .filter((c) => !previouslySeen.has(c.cardId) && cache.entries[String(c.cardId)]?.relevant === true)
    : fresh;
  const selected = llm && opts.limit === undefined ? relevantCards : relevantCards.slice(0, limit);
  const entries = selected.map((c) => entryText({ ...c, date: when }));
  if (selected.length > 0 && !opts.print) {
    appendInbox(inboxPath, entries);
    const handled = llm
      ? result.decks.flatMap((d) => d.cards).filter((c) => Boolean(cache.entries[String(c.cardId)])).map((c) => c.cardId)
      : selected.map((c) => c.cardId);
    writeSeen(seenPath, [...seen, ...handled, ...selected.map((c) => c.cardId)]);
  }
  return {
    status: 'ok', decks: result.decks.length, cards,
    newCards: fresh.length, offered: selected.length,
    deferred: llm ? 0 : fresh.length - selected.length,
    appended: selected.length, entries,
    llm, classified, rechecked, pendingClassify, relevant: relevantCards.length, llmError,
  };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const print = argv.includes('--print');
  const llm = argv.includes('--llm');
  const at = argv.indexOf('--limit');
  const limit = at >= 0 ? Number(argv[at + 1]) : undefined;
  if (at >= 0 && (!Number.isInteger(limit) || limit < 0)) {
    console.error('--limit expects a non-negative whole number');
    process.exit(2);
  }
  const ttlArg = argv.indexOf('--ttl');
  const ttlDays = ttlArg >= 0 ? Number(argv[ttlArg + 1]) : undefined;
  if (ttlArg >= 0 && (!Number.isInteger(ttlDays) || ttlDays <= 0)) {
    console.error('--ttl expects a positive whole number of days');
    process.exit(2);
  }
  const classifyArg = argv.indexOf('--classify-limit');
  const classifyLimit = classifyArg >= 0 ? Number(argv[classifyArg + 1]) : undefined;
  if (classifyArg >= 0 && (!Number.isInteger(classifyLimit) || classifyLimit < 0)) {
    console.error('--classify-limit expects a non-negative whole number');
    process.exit(2);
  }
  const result = await runFeed({ print, llm, limit, ttlDays, classifyLimit });
  console.log(JSON.stringify(result, null, 2));
}
