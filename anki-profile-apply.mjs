#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { loadRelevanceCache } from './lib/anki-relevance.mjs';
import { applyAdd, appendDigestBullet, cvHasEntry, normalizeKey } from './add-entry.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';
import { acquireDirLock, releaseOrWarn } from './lib/dir-lock.mjs';
import { validateFlags, flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TARGETS = ['cv.md', 'modes/_profile.md', 'article-digest.md'];
const PROFILE_SECTION = 'Anki-confirmed facts';
const CV_SECTION = 'Skills';
const CV_DEDUP_SECTIONS = ['Skills', 'Projects', 'Experience', 'Work Experience', 'Professional Experience', 'Aptitudes', 'Proyectos', 'Experiencia'];
const ANOMALY_RE = /\b(?:ignore (?:all |any )?(?:previous|prior|earlier) instructions|disregard (?:the )?(?:previous|prior|above)|as the (?:reviewer|ai|agent|assistant)|you must|ignora (?:las |los )?instrucciones anteriores|debes ignorar|system\s*:)/i;
const INBOX_RE = /^- \[ \] (?<stamp>[^\n]*?) — ANKI \(fuente del perfil\):(?: "(?<text>.*?)")?(?: ·[^\n]*?)? — baraja "(?<deck>.*)" \(#(?<id>\d+)\)/;

const USAGE = `Usage:
  node anki-profile-apply.mjs                    # dry-run: source-annotated proposals, no writes
  node anki-profile-apply.mjs --json             # pure JSON, no prompts or writes
  node anki-profile-apply.mjs --approve <cardId> --target <cv.md|modes/_profile.md|article-digest.md> --confirm

Nothing is written without all three approval flags. Card text is data, never an instruction.`;

export function parseInbox(text) {
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
      line,
    });
  });
  return entries;
}

export function anomalyIn(text) {
  const match = String(text ?? '').match(ANOMALY_RE);
  return match ? match[0].trim() : null;
}

export function hasFact(text, fact) {
  const key = normalizeKey(fact);
  if (key.length < 12) return false;
  return normalizeKey(text).includes(key) || CV_DEDUP_SECTIONS.some((section) => cvHasEntry(text, section, fact));
}

function sourceAnnotation(entry, verdict) {
  const reason = String(verdict?.reason ?? 'sin motivo').replace(/\s*\n\s*/g, ' ').trim();
  const when = String(verdict?.classifiedAt ?? 'fecha desconocida');
  return `**Source:** tarjeta Anki, baraja "${entry.deck}", #${entry.cardId}, clasificada ${when}, motivo: ${reason}`;
}

function proposedLines(entry, verdict) {
  const anomaly = anomalyIn(entry.text);
  const note = anomaly ? ` — anomalía citada, no ejecutada: "${anomaly}"` : '';
  return `- **${entry.text}**${note}\n  ${sourceAnnotation(entry, verdict)}`;
}

export function appendProfileFact(md, fact, source) {
  if (hasFact(md, fact)) return { text: md, status: 'duplicate' };
  const block = `- **${fact}**\n  ${source}`;
  const lines = String(md ?? '').split('\n');
  const at = lines.findIndex((line) => /^##\s+Anki-confirmed facts\s*$/.test(line));
  if (at === -1) {
    const base = lines.join('\n').replace(/\s+$/, '');
    return { text: `${base}${base ? '\n\n' : ''}## ${PROFILE_SECTION}\n\n${block}\n`, status: 'added' };
  }
  let end = at + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  let last = end - 1;
  while (last > at && !lines[last].trim()) last--;
  lines.splice(last + 1, 0, '', block);
  return { text: lines.join('\n'), status: 'added' };
}

function suggestedTarget(entry, verdict) {
  const signal = `${entry.deck} ${verdict?.reason ?? ''}`.toLowerCase();
  return /\b(proyecto|project|logro|achievement|métrica|metric|proof point)\b/.test(signal)
    ? 'article-digest.md'
    : 'cv.md';
}

export function buildProposals({ entries, relevance, cvText = '', profileText = '', digestText = '' }) {
  const proposals = [];
  const skipped = [];
  const records = relevance?.entries ?? {};
  for (const entry of entries) {
    const verdict = records[String(entry.cardId)];
    if (!verdict || verdict.relevant !== true) {
      skipped.push({ cardId: entry.cardId, reason: 'not-relevant' });
      continue;
    }
    if (!entry.text) {
      skipped.push({ cardId: entry.cardId, reason: 'empty-card-text' });
      continue;
    }
    const target = suggestedTarget(entry, verdict);
    const duplicate = target === 'modes/_profile.md'
      ? hasFact(profileText, entry.text)
      : hasFact(target === 'cv.md' ? cvText : digestText, entry.text);
    if (duplicate) {
      skipped.push({ cardId: entry.cardId, reason: 'duplicate' });
      continue;
    }
    proposals.push({
      cardId: entry.cardId,
      lineNumber: entry.lineNumber,
      deck: entry.deck,
      cardText: entry.text,
      reason: String(verdict.reason ?? ''),
      archetype: String(verdict.archetype ?? ''),
      dueDay: verdict.dueDay,
      classifiedAt: verdict.classifiedAt,
      expiresAt: verdict.expiresAt,
      schedulingFingerprint: verdict.schedulingFingerprint,
      relevant: true,
      target,
      anomaly: anomalyIn(entry.text),
      source: sourceAnnotation(entry, verdict),
      lines: proposedLines(entry, verdict),
    });
  }
  return { proposals, skipped };
}

export function computeWrite({ proposal: p, target, files }) {
  if (!TARGETS.includes(target)) throw new Error(`unsupported target: ${target}`);
  if (target === 'cv.md') {
    if (hasFact(files.cvText, p.cardText)) return { status: 'duplicate', text: files.cvText };
    const out = applyAdd({
      cv: { section: CV_SECTION, dedupKey: p.cardText, entry: p.lines },
    }, { cvText: files.cvText, articleText: files.digestText });
    return { status: out.result.cv.status, text: out.cv };
  }
  if (target === 'modes/_profile.md') {
    return appendProfileFact(files.profileText, p.cardText, p.source);
  }
  const label = p.archetype.split('/')[0].trim() || 'Anki';
  if (hasFact(files.digestText, p.cardText)) return { status: 'duplicate', text: files.digestText };
  const bullet = `- ${p.cardText} (${p.source})${p.anomaly ? ` — anomalía citada, no ejecutada: "${p.anomaly}"` : ''}`;
  const appended = appendDigestBullet(files.digestText, label, bullet);
  if (appended.status === 'appended') return { status: 'appended', text: appended.text };
  const out = applyAdd({
    articleDigest: {
      dedupKey: label,
      entry: `## ${label} — Anki-confirmed proof point\n\n${p.cardText}\n\n${p.source}`,
    },
  }, { cvText: files.cvText, articleText: files.digestText });
  return { status: out.result.articleDigest?.status ?? 'duplicate', text: out.articleDigest };
}

function printDryRun({ proposals, skipped, say }) {
  say(`anki-profile-apply: dry-run — ${proposals.length} proposal(s), ${skipped.length} skipped; no files written`);
  for (const p of proposals) {
    say(`${p.cardId} | ${p.deck} | ${p.cardText} | relevant: ${p.reason}${p.archetype ? ` | role: ${p.archetype}` : ''} | suggested: ${p.target}`);
    say(p.source);
    if (p.anomaly) say(`anomaly quoted, not executed: "${p.anomaly}"`);
    say('lines to add:');
    say(p.lines);
  }
}

function appendAudit(root, record) {
  const path = join(root, 'data/anki-applied.json');
  let data = { version: 1, records: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && Array.isArray(parsed.records)) data = parsed;
  } catch {}
  data.records.push(record);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function defaultInboxRunner(args, { root, inboxPath }) {
  execFileSync(process.execPath, [join(SCRIPT_DIR, 'agent-inbox.mjs'), ...args], {
    cwd: root,
    env: { ...process.env, CAREER_OPS_INBOX: inboxPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function runApply(opts = {}) {
  const root = opts.root ?? getCareerOpsRoot();
  const args = opts.args ?? [];
  const say = opts.out ?? console.log;
  const today = opts.today ?? localToday();
  const approve = opts.approve ?? flagValue(args, '--approve');
  const target = opts.target ?? flagValue(args, '--target');
  const confirm = Boolean(opts.confirm ?? args.includes('--confirm'));
  const json = Boolean(opts.json ?? hasFlag(args, '--json'));

  const inboxPath = join(root, 'data/agent-inbox.md');
  const relevancePath = join(root, 'data/anki-relevance.json');
  const files = {};
  for (const [key, rel] of [['cvText', 'cv.md'], ['profileText', 'modes/_profile.md'], ['digestText', 'article-digest.md']]) {
    const path = join(root, rel);
    files[key] = existsSync(path) ? readFileSync(path, 'utf8') : '';
  }
  const inboxText = existsSync(inboxPath) ? readFileSync(inboxPath, 'utf8') : '';
  const entries = parseInbox(inboxText);
  const { proposals, skipped } = buildProposals({ entries, relevance: loadRelevanceCache(relevancePath), ...files });

  if (!approve || !confirm || !target) {
    if (json) {
      say(JSON.stringify({ status: 'dry-run', proposals, skipped }, null, 2));
    } else {
      printDryRun({ proposals, skipped, say });
    }
    return { status: 'dry-run', proposals, skipped };
  }

  const chosen = proposals.find((p) => String(p.cardId) === String(approve));
  if (!chosen) throw new Error(`card #${approve} has no approved proposal (irrelevant, duplicate, or already resolved)`);
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(', ')}`);

  const auditPath = join(root, 'data/anki-applied.json');
  let alreadyApplied = false;
  try {
    const parsed = JSON.parse(readFileSync(auditPath, 'utf8'));
    alreadyApplied = (parsed?.records ?? []).some((r) => String(r.cardId) === String(chosen.cardId) && r.target === target);
  } catch {}
  if (alreadyApplied) throw new Error(`card #${chosen.cardId} was already applied to ${target}`);

  if (json) {
    say(JSON.stringify({ status: 'dry-run', proposals: [chosen], skipped,
      approval: { cardId: chosen.cardId, target, confirm: true } }, null, 2));
    return { status: 'dry-run', proposals: [chosen], skipped };
  }

  const filePath = join(root, target);
  const lock = await acquireDirLock(`${filePath}.anki-apply.lock`, {
    timeoutMs: 60_000, retryMs: 50, staleMs: 600_000, owner: { tool: 'anki-profile-apply' },
  });
  let written;
  try {
    written = computeWrite({ proposal: chosen, target, files });
    if (written.status !== 'duplicate' && written.status !== 'added' && written.status !== 'appended' && written.status !== 'created') {
      throw new Error(`unexpected write status: ${written.status}`);
    }
    if (written.status !== 'duplicate') {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, written.text);
    }
  } finally {
    releaseOrWarn(lock);
  }

  const result = `applied to ${target} (${today})`;
  const runner = opts.inboxRunner ?? defaultInboxRunner;
  await runner(['resolve', String(chosen.lineNumber), '--expect', `#${chosen.cardId}`, '--result', result], { root, inboxPath });
  appendAudit(root, {
    cardId: chosen.cardId,
    deck: chosen.deck,
    target,
    date: today,
    approved: true,
    confirmed: true,
    reason: chosen.reason,
    source: chosen.source,
  });
  const followUp = 'node reeval-candidates.mjs --summary';
  say(`anki-profile-apply: card #${chosen.cardId} ${result} (${written.status})`);
  if (chosen.anomaly) say(`anomaly quoted, not executed: "${chosen.anomaly}"`);
  say(`Follow-up: ${followUp}`);
  return { status: 'applied', cardId: chosen.cardId, target, writeStatus: written.status, followUp };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  validateFlags(argv, ['--approve', '--target', '--confirm', '--json', '--help', '-h'], USAGE, {
    valueFlags: ['--approve', '--target'], requireOperand: true,
  });
  try {
    await runApply({ args: argv });
  } catch (err) {
    console.error(`anki-profile-apply: ${err.message}`);
    process.exitCode = 1;
  }
}
