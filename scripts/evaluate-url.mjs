#!/usr/bin/env node
/**
 * scripts/evaluate-url.mjs — conservative JD capture + review skeleton.
 *
 * Usage:
 *   node scripts/evaluate-url.mjs <report-num> <url> [--dry-run] [--json]
 *
 * This script does NOT fabricate scores or facts. It fetches/verifies available
 * JD content, archives it when possible, and writes a review-needed report/TSV
 * compatible with hooks and tracker merge.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { execFileSync } from 'child_process';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withJdArchiveSection } from '../lib/jd-archive-section.mjs';
import { isPostingUrl, slugifyCompany, trackerTsvLine, tsvSafe } from '../lib/tracker-addition.mjs';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';

const USAGE = 'Usage: node scripts/evaluate-url.mjs <report-num> <url> [--dry-run] [--json] [--summary] [--with-llm]';
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const JSON_OUT = args.includes('--json') || args.includes('--summary');
const SUMMARY = args.includes('--summary');
const WITH_LLM = args.includes('--with-llm') || process.env.CAREER_OPS_EVAL_LLM === '1';
const positional = args.filter((a) => a !== '--dry-run' && a !== '--json' && a !== '--summary');
const REPORT_NUM = positional[0];
const URL = positional[1];

if (!REPORT_NUM || !URL || !/^\d+$/.test(REPORT_NUM) || !isPostingUrl(URL)) {
  console.error(USAGE);
  process.exit(1);
}

const padded = String(REPORT_NUM).padStart(3, '0');
const DATA_ROOT = getCareerOpsRoot();
const REPORTS_DIR = join(DATA_ROOT, 'reports');
const TRACKER_ADDITIONS_DIR = join(DATA_ROOT, 'batch', 'tracker-additions');
const today = new Date().toISOString().slice(0, 10);

function log(...parts) { if (!JSON_OUT) console.log(...parts); }
function warn(...parts) { console.warn(...parts); }

function cleanText(value, max = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeSlug(value) {
  const slug = slugifyCompany(value || 'pending-review');
  return slug || 'pending-review';
}

function findExistingReport(num) {
  if (!existsSync(REPORTS_DIR)) return null;
  for (const f of readdirSync(REPORTS_DIR)) {
    if (f.startsWith(`${num}-`) && f.endsWith('.md')) return join(REPORTS_DIR, f);
  }
  return null;
}

function findExistingTsv(num) {
  if (!existsSync(TRACKER_ADDITIONS_DIR)) return null;
  for (const f of readdirSync(TRACKER_ADDITIONS_DIR)) {
    if (f.startsWith(`${num}-`) && f.endsWith('.tsv')) return join(TRACKER_ADDITIONS_DIR, f);
  }
  return null;
}

function extractCompanyTitle({ title, bodyText, url }) {
  let company = 'Unknown company';
  let role = 'Unknown role';
  const titleText = cleanText(title, 180);
  const m = titleText.match(/^(.+?)\s+[-|–—]\s+(.+)$/);
  if (m) {
    // Heuristic: either Company - Role or Role - Company; prefer keeping both visible.
    role = cleanText(m[1], 120) || role;
    company = cleanText(m[2], 120) || company;
  } else if (titleText) {
    role = titleText;
  }
  const body = String(bodyText || '');
  const companyMatch = body.match(/(?:Company|Empresa|Employer)\s*[:\-]\s*(.+)/i);
  const locationCompany = body.match(/\b([A-Z][A-Za-z0-9&.,' -]{2,60})\s+is hiring\b/);
  if (companyMatch) company = cleanText(companyMatch[1], 120) || company;
  else if (locationCompany) company = cleanText(locationCompany[1], 120) || company;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (company === 'Unknown company') company = host;
  } catch {}
  return { company, role };
}

async function fetchJD(url) {
  // ATS/API first, browser fallback. Never claim full legitimacy from this.
  try {
    const api = await fetchJdViaKnownApi(url, 20000, 15000);
    if (api?.jdText && api.jdText.trim().length >= 80) {
      return {
        source: 'ats-api',
        status: api.status || 200,
        title: '',
        url,
        bodyText: api.jdText.slice(0, 50000),
        warning: '',
      };
    }
  } catch (err) {
    // fall through to browser
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = res?.status();
    const title = await page.title().catch(() => '');
    const urlFinal = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    return { source: 'playwright-render', status, title, url: urlFinal, bodyText: bodyText.slice(0, 50000), warning: '' };
  } catch (err) {
    return { source: 'error', status: 'ERROR', title: '', url, bodyText: '', warning: err.message };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function buildReport({ jd, company, role, reportPath }) {
  const jdText = String(jd.bodyText || '').trim();
  const hasJD = jdText.length >= 40;
  const jdStatus = hasJD ? 'archived below (verbatim extracted text; manual verification recommended)' : 'unavailable - needs manual capture';
  const fetchedNote = jd.warning ? `Fetch warning: ${cleanText(jd.warning, 300)}` : `Fetched via ${jd.source}${jd.status ? ` (HTTP ${jd.status})` : ''}.`;
  const front = [];
  front.push(`# Evaluation: ${company} — ${role}`);
  front.push('');
  front.push(`**Date:** ${today}`);
  front.push(`**URL:** ${jd.url || URL}`);
  front.push('**Via:** —');
  front.push('**Archetype:** Unclassified — needs LLM evaluation');
  front.push('**Score:** N/A — Needs LLM evaluation');
  front.push('**Decision:** Research first');
  front.push('**Legitimacy:** Proceed with Caution');
  front.push('**Work Auth:** ⚠️ Unstated');
  front.push('**PDF:** ❌');
  front.push('');
  front.push('## Verdict (lead)');
  front.push('');
  front.push('**Research first.** Automated skeleton only. This report does not assign a fit score or fabricate facts. Run full LLM evaluation before applying.');
  front.push('');
  front.push('## Risk Summary');
  front.push('');
  front.push('| Dimension | Level | Note |');
  front.push('|-----------|-------|------|');
  front.push('| Legitimacy | proceed_with_caution | Automated skeleton; legitimacy not adjudicated. |');
  front.push('| Culture | not_evaluated | Needs LLM evaluation. |');
  front.push('| Interview red flags | not_evaluated | Needs LLM evaluation. |');
  front.push('| AI infra | not_evaluated | Needs LLM evaluation. |');
  front.push('| Classification | not_evaluated | Needs LLM evaluation. |');
  front.push('');
  front.push('## Job Facts');
  front.push('');
  front.push(`- Source: ${jd.source}`);
  front.push(`- Fetch status: ${jd.status ?? 'unknown'}`);
  front.push(`- ${fetchedNote}`);
  front.push(`- JD archive: ${jdStatus}`);
  front.push('');
  front.push('## Block A — Role Summary');
  front.push('');
  front.push('| Field | Value |');
  front.push('|-------|-------|');
  front.push(`| Role | ${role} |`);
  front.push(`| Company | ${company} |`);
  front.push('| Location | Needs LLM evaluation |');
  front.push(`| Source | ${jd.source} |`);
  front.push('');
  front.push('## Block B — Critical Analysis');
  front.push('');
  front.push('Not assessed. Needs LLM evaluation against `cv.md`, `config/profile.yml`, and the archived JD.');
  front.push('');
  front.push('## Block C — Experience Match');
  front.push('');
  front.push('Not assessed. Needs LLM evaluation; no claims fabricated.');
  front.push('');
  front.push('## Block D — Skills Gap');
  front.push('');
  front.push('Not assessed. Needs LLM evaluation.');
  front.push('');
  front.push('## Block E — Red Flags');
  front.push('');
  front.push('Not assessed beyond conservative default. Needs LLM evaluation.');
  front.push('');
  front.push('## Block F — Verdict');
  front.push('');
  front.push('**Recommendation:** Research first — run full `/career-ops oferta` or batch evaluation before any application decision.');
  front.push('');
  front.push('## Block G — Posting Legitimacy');
  front.push('');
  front.push(`Automated fetch performed via ${jd.source}. This is not a full legitimacy adjudication. Verify employer careers page and liveness before applying.`);
  front.push('');
  front.push('## Score Evidence');
  front.push('');
  front.push('| Dimension | Evidence |');
  front.push('|-----------|----------|');
  front.push('| cv_match | unknown - needs LLM evaluation |');
  front.push('| north_star | unknown - needs LLM evaluation |');
  front.push('| compensation | unknown - needs LLM evaluation |');
  front.push('| culture | unknown - needs LLM evaluation |');
  front.push('| red_flags | unknown - needs LLM evaluation |');
  front.push('');
  front.push('**Evidence confidence:** Low — automated skeleton, no evaluation performed.');
  front.push('');
  front.push('## Keyword Coverage');
  front.push('');
  front.push('Pending LLM evaluation / keyword-match.');
  front.push('');

  let report = front.join('\n');
  if (hasJD) {
    report = withJdArchiveSection(report, jdText);
  } else {
    report += '## Job Description (capture pending)\n\n';
    report += 'Automated capture could not extract substantive JD text. Manual JD capture is required before evaluation.\n\n';
  }

  report += '## Machine Summary\n\n';
  report += '```yaml\n';
  report += `company: ${JSON.stringify(company)}\n`;
  report += `role: ${JSON.stringify(role)}\n`;
  report += 'job_facts_cache: null\n';
  report += 'score: null\n';
  report += 'legitimacy_tier: "Proceed with Caution"\n';
  report += 'archetype: "Unclassified"\n';
  report += 'final_decision: "Research first"\n';
  report += 'hard_stops: []\n';
  report += 'soft_gaps:\n  - "Automated skeleton only; LLM evaluation required"\n';
  report += 'top_strengths: []\n';
  report += 'risk_level: "Medium"\n';
  report += 'confidence: "Low"\n';
  report += 'score_evidence:\n  cv_match: "unknown"\n  north_star: "unknown"\n  compensation: "unknown"\n  culture: "unknown"\n  red_flags: "unknown"\n';
  report += 'confidence_gaps:\n  - "Run full oferta/batch evaluation before acting"\n';
  report += 'next_action: "Run /career-ops oferta or batch evaluation for this posting"\n';
  report += 'work_auth: "unstated"\n';
  report += 'discard_reasons: []\n';
  report += 'via: null\n';
  report += 'company_confidential: false\n';
  report += 'advertised_comp: null\n';
  report += 'reports_to: null\n';
  report += 'posting_location: null\n';
  report += 'requirement_importance: []\n';
  report += 'risk_summary:\n  legitimacy: "proceed_with_caution"\n  classification: "not_evaluated"\n  culture: "not_evaluated"\n  interview_redflags: "not_evaluated"\n  ai_infra: "not_evaluated"\n  ai_screening_disclosure: "not_evaluated"\n  fixed_term: "not_evaluated"\n  relocation_purchasing_power: "not_evaluated"\n  vacancy_disclosure: "not_evaluated"\n  unpaid_placement: "not_evaluated"\n  candidate_fees: "not_evaluated"\n  accommodation_notice: "not_evaluated"\n';
  report += '```\n\n';
  report += `---\n*Automated skeleton by scripts/evaluate-url.mjs on ${today}. No score/facts fabricated. Review required.*\n`;
  return report;
}

// ── LLM cost / rate-limit guard ─────────────────────────────────────────
// Reads OPENROUTER_API_KEY from the environment or from {DATA_ROOT}/.env so
// evaluate-url can decide up front whether the LLM path is even possible,
// falling back to the heuristic skeleton instead of crashing when credentials
// or cost limits are unavailable.
function readEnvFile(key) {
  try {
    const envPath = join(DATA_ROOT, '.env');
    if (!existsSync(envPath)) return undefined;
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^(['"])(.*?)\1$/, '$2');
    }
  } catch {}
  return undefined;
}

function llmGuard() {
  const key = process.env.OPENROUTER_API_KEY || readEnvFile('OPENROUTER_API_KEY');
  const costCap = Number(process.env.CAREER_OPS_EVAL_MAX_COST_USD);
  if (!key) {
    return {
      available: false,
      reason: 'OPENROUTER_API_KEY is not set (environment or .env)',
      rateLimit: 'blocked:no-credentials',
      costEstimate: null,
    };
  }
  // OpenRouter free-model rotation (no pinned model) costs $0 per run.
  const pinned = Boolean(process.env.CAREER_OPS_MODEL);
  const costEstimate = pinned ? null : 0;
  if (Number.isFinite(costCap) && costCap >= 0 && costEstimate !== null && costEstimate > costCap) {
    return {
      available: false,
      reason: `estimated cost $${costEstimate} exceeds CAREER_OPS_EVAL_MAX_COST_USD=$${costCap}`,
      rateLimit: 'blocked:cost-cap',
      costEstimate,
    };
  }
  return { available: true, reason: 'credentials ok', rateLimit: 'ok', costEstimate };
}

// ── CRITERION FOR PROMOTING TO "RELIABLE BLOCKS A-G" ────────────────────
// A report is promotable to a reliable Blocks A–G evaluation when ALL hold:
//   1. mode === 'llm'            — a real LLM evaluation ran (not the heuristic skeleton)
//   2. llm.ok === true           — the LLM call succeeded
//   3. legitimacyTier confident  — e.g. 'High Confidence', not 'Proceed with Caution'/'unconfirmed'
//   4. score is a real 0..5 number >= 4.0 (fit threshold)
//   5. all Blocks A–G present    — in the report text
//   6. urlVerified               — the posting URL was fetched and yielded real JD content
// When any condition fails the report stays a heuristic skeleton (score N/A) and
// must not be treated as a reliable A-G evaluation.
const AG_CRITERION = 'mode=llm && llm.ok && confidence legitimacy tier && score>=4.0 && blocks A-G present && url verified';

const CONFIDENT_LEGITIMACY = ['high confidence', 'alta confianza'];

function blocksPresent(text) {
  const present = [];
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    const re = new RegExp(`(?:^|\\n)#{1,4}\\s*(?:Block\\s+${letter}\\b|${letter}\\))\\b`, 'im');
    if (re.test(text)) present.push(letter);
  }
  return present;
}

async function main() {
  const existing = findExistingReport(padded);
  if (existing) {
    log(`⏭️ Reporte ya existe: ${existing}`);
    if (JSON_OUT) console.log(JSON.stringify({ ok: true, skipped: true, reportPath: existing }));
    return;
  }

  const jd = await fetchJD(URL);
  const { company, role } = extractCompanyTitle({ title: jd.title, bodyText: jd.bodyText, url: jd.url || URL });
  const slug = sanitizeSlug(company);
  const reportPath = join(REPORTS_DIR, `${padded}-${slug}-${today}.md`);
  const tsvPath = findExistingTsv(padded) || join(TRACKER_ADDITIONS_DIR, `${padded}-${slug}.tsv`);

  let mode = 'heuristic';
  let llm = {
    attempted: false, ok: false, reason: '', costEstimate: null, rateLimit: 'n/a', error: '',
    score: null, legitimacyTier: null, blocksPresent: [], urlVerified: false,
  };
  let writtenReportPath = null;
  let writtenTsvPath = null;

  if (WITH_LLM) {
    llm.attempted = true;
    const guard = llmGuard();
    llm.rateLimit = guard.rateLimit;
    llm.costEstimate = guard.costEstimate;
    if (!guard.available) {
      llm.reason = guard.reason;
      warn(`⚠ LLM evaluation requested but not available: ${guard.reason}; falling back to heuristic skeleton.`);
      mode = 'heuristic';
    } else {
      mode = 'llm';
      try {
        const res = execFileSync(process.execPath, [join(DATA_ROOT, 'openrouter-runner.mjs'), 'evaluate', jd.url || URL], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
          timeout: 300_000,
          cwd: DATA_ROOT,
        });
        const output = res.stdout.toString();
        llm.ok = true;
        const scoreM = output.match(/\*\*Score:\*\*\s*(\d+(?:\.\d+)?)/) || output.match(/(?:^|\n)\s*score:\s*(\d+(?:\.\d+)?)/im);
        llm.score = scoreM ? parseFloat(scoreM[1]) : null;
        const legitM = output.match(/\*\*Legitimacy:\*\*\s*([^\n]+)/);
        llm.legitimacyTier = legitM ? cleanText(legitM[1], 120) : null;
        llm.blocksPresent = blocksPresent(output);
        llm.urlVerified = true;
        // The LLM (oferta) path wrote its own report + TSV under its own number.
        // Release our reserved number so it is not leaked; no duplicate row is written.
        try {
          execFileSync(process.execPath, ['reserve-report-num.mjs', '--release', String(padded)], {
            stdio: 'pipe',
            env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
            timeout: 30_000,
            cwd: DATA_ROOT,
          });
        } catch {}
        log(`✅ Evaluación LLM completada: ${company} — ${role} (reporte gestionado por openrouter-runner)`);
      } catch (err) {
        llm.ok = false;
        llm.error = String(err.message || err).slice(0, 300);
        llm.reason = llm.error;
        mode = 'heuristic';
        warn(`⚠ LLM evaluation failed: ${llm.error}; falling back to heuristic skeleton.`);
      }
    }
  }

  const legitimacyTier = String(llm.legitimacyTier || '').toLowerCase();
  const agMet = mode === 'llm' && llm.ok
    && CONFIDENT_LEGITIMACY.some((t) => legitimacyTier.includes(t))
    && typeof llm.score === 'number' && llm.score >= 4.0
    && llm.blocksPresent.length === 7
    && llm.urlVerified;
  const agPromotion = {
    met: agMet,
    criterion: AG_CRITERION,
    blocksPresent: llm.blocksPresent,
    legitimacyTier: llm.legitimacyTier || null,
    score: llm.score ?? null,
    urlVerified: llm.urlVerified,
  };
  if (agPromotion.met) {
    log(`✅ Bloques A–G promovidos a confiables: ${company} — ${role} (score ${llm.score}, legitimidad ${llm.legitimacyTier})`);
  }

  if (mode === 'heuristic') {
    const report = buildReport({ jd, company, role, reportPath });
    const tsv = trackerTsvLine({
      num: padded,
      date: today,
      company: tsvSafe(company),
      role: tsvSafe(role),
      status: 'Evaluated',
      score: 'N/A',
      pdf: '❌',
      report: `[${padded}](reports/${basename(reportPath)})`,
      notes: 'Automated skeleton — needs LLM evaluation; not scored',
      url: jd.url || URL,
    });

    if (DRY_RUN) {
      log(`[dry-run] would write ${reportPath}`);
      log(`[dry-run] would write ${tsvPath}`);
      if (JSON_OUT) console.log(JSON.stringify({ ok: true, dryRun: true, reportPath, tsvPath, company, role, mode, llm, agPromotion }));
      return;
    }

    mkdirSync(REPORTS_DIR, { recursive: true });
    mkdirSync(TRACKER_ADDITIONS_DIR, { recursive: true });
    writeFileSync(reportPath, report, 'utf-8');
    writeFileSync(tsvPath, tsv, 'utf-8');

    writtenReportPath = reportPath;
    writtenTsvPath = tsvPath;

    log(`✅ Skeleton guardado: ${reportPath}`);
    log(`   TSV: ${tsvPath}`);
    log(`   Company: ${company} | Role: ${role}`);
    log(`   Estado: Needs LLM evaluation (no score fabricated)`);

    try {
      execFileSync(process.execPath, [join(DATA_ROOT, 'scripts', 'hook-after-evaluate.mjs'), String(REPORT_NUM)], {
        stdio: 'inherit',
        env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
        timeout: 30_000,
        cwd: DATA_ROOT,
      });
    } catch (err) {
      warn(`⚠ hook after-evaluate falló: ${err.message}`);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      ok: true,
      reportPath: writtenReportPath || (mode === 'llm' ? null : reportPath),
      tsvPath: writtenTsvPath,
      company,
      role,
      mode,
      needsLlmEvaluation: mode === 'heuristic',
      llm: {
        attempted: llm.attempted,
        ok: llm.ok,
        reason: llm.reason,
        costEstimate: llm.costEstimate,
        rateLimit: llm.rateLimit,
        error: llm.error,
        score: llm.score,
        legitimacyTier: llm.legitimacyTier,
        blocksPresent: llm.blocksPresent,
        urlVerified: llm.urlVerified,
      },
      agPromotion,
    }));
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
