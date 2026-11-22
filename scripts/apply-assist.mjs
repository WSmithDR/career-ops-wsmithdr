#!/usr/bin/env node
/**
 * scripts/apply-assist.mjs — assisted, human-confirmed application flow.
 *
 * Opens the posting in a project-launched Playwright browser, prepares local
 * draft artifacts, pre-fills conservative profile fields, and prints a summary.
 * It NEVER auto-submits. A submit click happens only after the human types the
 * exact confirmation word shown by the CLI, and only when safety checks pass
 * (no required-unfilled blocking fields, no multi-step ambiguity).
 *
 * Usage:
 *   node scripts/apply-assist.mjs <report#|url> [--no-generate] [--no-open-draft] [--json] [--mark-applied]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { loadYaml } from '../lib/yaml-document.mjs';
import { getCareerOpsRoot, getProfilePath } from '../path-resolver.mjs';
import { HEADED_APPLY_LAUNCH, BUNDLED_HEADED_LAUNCH } from '../apply-scope.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { isSubmitControl, snapshotLabel } from '../web/src/lib/apply/submit-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const DATA_ROOT = getCareerOpsRoot();
const OUT_ROOT = join(DATA_ROOT, 'output', 'applications');
const CONFIRM_WORD = 'SUBMIT';

const USAGE = `Usage:
  node scripts/apply-assist.mjs <report#|url> [--no-generate] [--no-open-draft] [--json] [--mark-applied]
  node scripts/apply-assist.mjs --help

Opens a project-launched Playwright browser, prepares local draft artifacts,
prefills conservative fields, and asks for explicit human confirmation before
any submit click. Never auto-submits.

--mark-applied: after explicit SUBMIT confirmation and submit click, update tracker to Applied via set-status.mjs.`;

function hasFlag(args, flag) { return args.includes(flag); }
function nowIso() { return new Date().toISOString(); }
function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function cssEscapeAttr(v) { return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function resolveReportNumber(arg) {
  if (/^\d+$/.test(String(arg).trim())) return String(Number(arg)).padStart(3, '0');
  try {
    const out = execFileSync(process.execPath, ['find.mjs', arg], { cwd: REPO, encoding: 'utf8', timeout: 30000 }).trim();
    const m = out.match(/^(\d{3})\s*->\s*/m) || out.match(/\b(\d{3})\b/);
    if (m) return m[1];
  } catch {}
  // fallback: scan reports for URL
  const reportsDir = join(DATA_ROOT, 'reports');
  if (existsSync(reportsDir)) {
    for (const f of readdirSync(reportsDir).filter((x) => x.endsWith('.md'))) {
      try {
        const content = readFileSync(join(reportsDir, f), 'utf8');
        if (content.includes(arg)) {
          const n = f.match(/^(\d{3})-/);
          if (n) return n[1];
        }
      } catch {}
    }
  }
  throw new Error(`Could not resolve report number for: ${arg}`);
}

function findReportFile(num) {
  const reportsDir = join(DATA_ROOT, 'reports');
  if (!existsSync(reportsDir)) return null;
  const files = readdirSync(reportsDir).filter((f) => f.startsWith(`${num}-`) && f.endsWith('.md'));
  return files.length ? join(reportsDir, files[0]) : null;
}

function parseReport(content) {
  const g = (re) => { const m = content.match(re); return m ? m[1].trim() : ''; };
  const headerMatch = content.match(/^#\s*\d{3}\s*—\s*([^—]+)\s*—\s*(.+)/m);
  return {
    company: headerMatch ? headerMatch[1].trim() : '',
    role: headerMatch ? headerMatch[2].trim() : '',
    score: g(/\*\*Score:\*\*\s*([^\n]+)/im),
    url: g(/\*\*URL:\*\*\s*(\S+)/im),
    legitimacy: g(/\*\*Legitimacy:\*\*\s*([^\n]+)/im),
    date: g(/\*\*Date:\*\*\s*([^\n]+)/im),
  };
}

function readProfile() {
  try {
    const p = getProfilePath();
    if (!existsSync(p)) return {};
    const raw = loadYaml(readFileSync(p, 'utf-8')) || {};
    const c = raw.candidate && typeof raw.candidate === 'object' ? raw.candidate : {};
    const pick = (k) => String(c[k] ?? raw[k] ?? '').trim();
    return {
      fullName: pick('full_name'),
      email: pick('email'),
      phone: pick('phone'),
      linkedin: pick('linkedin'),
      github: pick('github') || pick('portfolio_url'),
      location: pick('location'),
    };
  } catch { return {}; }
}

function findLatestCvPdf(reportNum, company) {
  const outDir = join(DATA_ROOT, 'output');
  if (!existsSync(outDir)) return null;
  const n = String(reportNum).padStart(3, '0');
  const companySlug = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const files = readdirSync(outDir).filter((f) => /\.pdf$/i.test(f));
  const scored = files.map((f) => {
    const lower = f.toLowerCase();
    let score = 0;
    if (lower.includes(`-${n}-`) || lower.startsWith(`${n}-`) || lower.includes(`report-${n}`)) score += 100;
    if (companySlug && lower.includes(companySlug)) score += 20;
    if (lower.startsWith('cv-')) score += 10;
    return { f, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.f.localeCompare(a.f));
  return scored[0] ? join(outDir, scored[0].f) : null;
}

function writeManifest(manifestPath, patch) {
  let current = {};
  if (existsSync(manifestPath)) {
    try { current = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch {}
  }
  const next = {
    ...current,
    ...patch,
    humanConfirmation: { ...(current.humanConfirmation || {}), ...(patch.humanConfirmation || {}) },
    timeline: [...(Array.isArray(current.timeline) ? current.timeline : []), ...(Array.isArray(patch.timeline) ? patch.timeline : [])],
    updatedAt: nowIso(),
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

async function ask(question) {
  const rl = createInterface({ input, output });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
}

async function launchBrowser() {
  const attempts = [HEADED_APPLY_LAUNCH, BUNDLED_HEADED_LAUNCH, { headless: true }];
  let lastErr;
  for (const opts of attempts) {
    try { return await chromium.launch(opts); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function runPrepare(reportNum, { noGenerate, noOpenDraft }) {
  const args = ['automation/prepare-application.mjs', reportNum, '--json'];
  if (noGenerate) args.push('--no-generate');
  if (noOpenDraft) args.push('--no-open');
  try {
    const out = execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
    const m = out.match(/\{[\s\S]*\}\s*$/);
    return { ok: true, data: JSON.parse(m ? m[0] : out.trim()) };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message || e).slice(0, 300) };
  }
}

async function detectFields(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const els = Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"], [role="combobox"], [contenteditable="true"]'));
    return els.map((el, idx) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || (el.getAttribute('contenteditable') === 'true' ? 'contenteditable' : tag)).toLowerCase();
      const id = el.id || '';
      const name = el.getAttribute('name') || '';
      const aria = el.getAttribute('aria-label') || '';
      let label = '';
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l) label = l.textContent || '';
      }
      if (!label) {
        const pl = el.closest('label');
        if (pl) label = pl.textContent || '';
      }
      if (!label) {
        const labelledby = el.getAttribute('aria-labelledby');
        if (labelledby) {
          label = labelledby.split(/\s+/).map((x) => document.getElementById(x)?.textContent || '').join(' ');
        }
      }
      if (!label && (tag === 'button' || el.getAttribute('role') === 'button')) label = el.textContent || '';
      const form = el.closest('form');
      const inForm = !!form;
      const section = el.closest('section,fieldset,[role="group"]');
      return {
        idx, tag, type, id, name, aria,
        label: clean(label),
        required: !!el.required || el.getAttribute('aria-required') === 'true',
        value: clean(el.value || el.textContent || ''),
        visible: isVisible(el),
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        inForm,
        formAction: form ? clean(form.getAttribute('action') || '') : '',
        section: section ? clean(section.getAttribute('aria-label') || section.id || section.className || '') : '',
      };
    }).filter((f) => !['hidden', 'password'].includes(f.type)).slice(0, 220);
  });
}

function pickField(fields, patterns, allowedTags = ['input', 'textarea', 'select']) {
  return fields.find((f) => {
    if (!allowedTags.includes(f.tag)) return false;
    if (!f.visible || f.disabled) return false;
    if (['submit', 'button', 'image', 'reset', 'file', 'checkbox', 'radio'].includes(f.type)) return false;
    const hay = normalizeText([f.label, f.name, f.id, f.aria, f.type].join(' '));
    return patterns.some((p) => hay.includes(p));
  }) || null;
}

function findSubmit(fields) {
  const candidates = fields.filter((f) => f.visible && !f.disabled);
  const matches = candidates.filter((f) => {
    const facts = {
      tag: f.tag,
      type: f.type,
      role: f.tag === 'a' ? 'link' : f.tag,
      inForm: !!f.inForm,
      aria: f.aria || '',
      placeholder: '',
      text: f.label || '',
      value: f.value || '',
      name: f.name || '',
    };
    return isSubmitControl(facts);
  });
  if (matches.length === 0) return null;
  const primary = matches.find((f) => f.inForm) || matches[0];
  const ambiguous = matches.length > 1;
  return { ...primary, ambiguous, matches: matches.map((m) => ({ id: m.id, name: m.name, label: snapshotLabel(m), inForm: m.inForm, type: m.type, tag: m.tag })) };
}

async function prefill(page, profile, cvPdf) {
  let fields = await detectFields(page);
  const plan = [];
  const mappings = [
    { key: 'fullName', value: profile.fullName, patterns: ['full name', 'nombre completo', 'name'] },
    { key: 'email', value: profile.email, patterns: ['email', 'e-mail', 'correo'] },
    { key: 'phone', value: profile.phone, patterns: ['phone', 'mobile', 'tel', 'celular'] },
    { key: 'location', value: profile.location, patterns: ['location', 'city', 'ciudad', 'ubicacion'] },
    { key: 'linkedin', value: profile.linkedin, patterns: ['linkedin'] },
    { key: 'github', value: profile.github, patterns: ['github', 'portfolio', 'website'] },
  ];
  for (const m of mappings) {
    if (!m.value) continue;
    const f = pickField(fields, m.patterns);
    if (!f) { plan.push({ key: m.key, status: 'missing-field' }); continue; }
    if (f.value && normalizeText(f.value) === normalizeText(m.value)) { plan.push({ key: m.key, status: 'already-filled', field: f }); continue; }
    const selector = f.id ? `#${cssEscapeAttr(f.id)}` : (f.name ? `[name="${cssEscapeAttr(f.name)}"]` : null);
    if (!selector) { plan.push({ key: m.key, status: 'no-selector', field: f }); continue; }
    try {
      const loc = page.locator(selector).first();
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.fill(String(m.value), { timeout: 5000 });
      plan.push({ key: m.key, status: 'filled', field: f });
    } catch (e) {
      plan.push({ key: m.key, status: 'error', field: f, error: String(e.message || e).slice(0, 160) });
    }
  }

  const fileField = fields.find((f) => f.visible && !f.disabled && (f.type === 'file' || (f.tag === 'input' && normalizeText([f.label, f.name, f.id, f.aria].join(' ')).match(/resume|cv|curriculum/))));
  if (cvPdf && fileField) {
    const selector = fileField.id ? `#${cssEscapeAttr(fileField.id)}` : (fileField.name ? `[name="${cssEscapeAttr(fileField.name)}"]` : null);
    if (selector) {
      try {
        await page.locator(selector).first().setInputFiles(cvPdf, { timeout: 5000 });
        plan.push({ key: 'cvPdf', status: 'attached', field: fileField, value: cvPdf });
      } catch (e) {
        plan.push({ key: 'cvPdf', status: 'attach-error', field: fileField, value: cvPdf, error: String(e.message || e).slice(0, 160) });
      }
    } else plan.push({ key: 'cvPdf', status: 'no-selector', field: fileField, value: cvPdf });
  } else if (cvPdf) plan.push({ key: 'cvPdf', status: 'missing-file-field', value: cvPdf });
  else plan.push({ key: 'cvPdf', status: 'no-cv-found' });

  fields = await detectFields(page);
  return { fields, plan };
}

function summarizePlan(plan) {
  const counts = { filled: 0, attached: 0, skipped: 0, errors: 0 };
  for (const p of plan) {
    if (p.status === 'filled' || p.status === 'already-filled') counts.filled++;
    else if (p.status === 'attached') counts.attached++;
    else if (p.status === 'error' || p.status === 'attach-error') counts.errors++;
    else counts.skipped++;
  }
  return counts;
}

function fieldSelector(f) {
  if (f.id) return `#${cssEscapeAttr(f.id)}`;
  if (f.name) return `[name="${cssEscapeAttr(f.name)}"]`;
  return null;
}

async function readFieldState(page, f) {
  const selector = fieldSelector(f);
  if (!selector) return { ok: false, reason: 'no-selector', filled: false };
  try {
    const loc = page.locator(selector).first();
    const state = await loc.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || tag).toLowerCase();
      const checked = 'checked' in el ? !!el.checked : false;
      const value = 'value' in el ? String(el.value || '') : String(el.textContent || '');
      const files = 'files' in el && el.files ? el.files.length : 0;
      return { tag, type, checked, value, files, disabled: !!el.disabled };
    });
    const filled = state.type === 'checkbox' || state.type === 'radio'
      ? state.checked
      : state.type === 'file'
        ? state.files > 0
        : String(state.value || '').trim().length > 0;
    return { ok: true, filled, state };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 120), filled: false };
  }
}

async function requiredUnfilled(fields, page) {
  const out = [];
  for (const f of fields) {
    if (!f.visible || f.disabled) continue;
    if (!f.required) continue;
    if (['button', 'submit', 'image', 'reset'].includes(f.type)) continue;
    const st = await readFieldState(page, f);
    if (!st.filled) out.push({ label: f.label || f.name || f.id || f.type, type: f.type, reason: st.reason || 'empty' });
  }
  return out;
}

function nextStepControls(fields) {
  const patterns = ['next', 'continue', 'siguiente', 'continuar', 'review', 'revisar', 'proceed', 'avanzar'];
  return fields.filter((f) => {
    if (!f.visible || f.disabled) return false;
    if (!(f.tag === 'button' || f.type === 'button' || f.type === 'submit' || f.type === 'image' || f.tag === 'a')) return false;
    const hay = normalizeText([f.label, f.name, f.id, f.aria, f.value, f.type].join(' '));
    return patterns.some((p) => hay.includes(p));
  }).map((f) => ({ id: f.id, name: f.name, label: snapshotLabel(f), type: f.type, tag: f.tag, inForm: f.inForm }));
}

function submitSafety({ submitField, requiredMissing, nextControls }) {
  const reasons = [];
  if (!submitField) reasons.push('submit-not-found');
  if (submitField?.ambiguous) reasons.push('ambiguous-submit');
  if (requiredMissing.length > 0) reasons.push('required-fields-unfilled');
  if (nextControls.length > 0) reasons.push('multi-step-or-next-control-detected');
  return { safe: reasons.length === 0, reasons };
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) { console.log(USAGE); return; }
  const noGenerate = hasFlag(args, '--no-generate');
  const noOpenDraft = hasFlag(args, '--no-open-draft');
  const jsonOut = hasFlag(args, '--json');
  const markApplied = hasFlag(args, '--mark-applied');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error(USAGE); process.exit(2); }

  let reportNum;
  try { reportNum = resolveReportNumber(target); }
  catch {
    if (!target.startsWith('http')) throw new Error(`Could not resolve report number for: ${target}`);
    // allow URL-only assist by creating no report-based draft? safer to require report.
    throw new Error(`No report found for URL. Evaluate/create report first: ${target}`);
  }
  const reportPath = findReportFile(reportNum);
  if (!reportPath) throw new Error(`report not found for ${reportNum}`);
  const report = parseReport(readFileSync(reportPath, 'utf-8'));
  const url = report.url || (target.startsWith('http') ? target : '');
  if (!url) throw new Error('report has no URL; cannot open form safely');

  const prep = runPrepare(reportNum, { noGenerate, noOpenDraft });
  const appDir = join(OUT_ROOT, reportNum);
  const manifestPath = join(appDir, 'manifest.json');
  const profile = readProfile();
  const cvPdf = findLatestCvPdf(reportNum, report.company);

  writeManifest(manifestPath, {
    reportNum, reportPath, company: report.company, role: report.role, url,
    mode: 'assisted-human-confirmed',
    safety: 'never auto-submit; submit click requires explicit typed confirmation',
    prepare: prep,
    humanConfirmation: { draftPrepared: true, confirmed: false, submittedByHuman: null },
    timeline: [{ at: nowIso(), event: 'draft-prepared' }],
  });

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let finalStatus = 'draft-only-not-submitted';
  let submitResult = { attempted: false, submittedByHuman: false };
  let safety = { safe: false, reasons: ['not-evaluated'] };
  let requiredMissing = [];
  let nextControls = [];
  let counts = { filled: 0, attached: 0, skipped: 0, errors: 0 };
  let summary = null;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const { fields, plan } = await prefill(page, profile, cvPdf);
    const submitField = findSubmit(fields);
    counts = summarizePlan(plan);
    requiredMissing = await requiredUnfilled(fields, page);
    nextControls = nextStepControls(fields);
    safety = submitSafety({ submitField, requiredMissing, nextControls });
    summary = {
      reportNum, company: report.company, role: report.role, url, finalUrl: page.url(),
      manifestPath, cvPdf, counts, requiredMissing, nextControls, safety,
      submitCandidate: submitField ? { label: submitField.label, type: submitField.type, id: submitField.id, name: submitField.name, ambiguous: submitField.ambiguous } : null,
      confirmationRequired: CONFIRM_WORD,
    };
    writeManifest(manifestPath, {
      browser: { launchedBy: 'apply-scope', finalUrl: page.url() },
      prefill: { plan, counts, cvPdf: cvPdf || null },
      submitCandidate: submitField || null,
      requiredMissing,
      nextControls,
      safetyCheck: safety,
      timeline: [{ at: nowIso(), event: 'prefill-completed', counts, safety }],
    });

    if (!jsonOut) {
      console.log(`apply-assist: ${reportNum} ${report.company} — ${report.role}`);
      console.log(`URL: ${url}`);
      console.log(`Final URL: ${page.url()}`);
      console.log(`Manifest: ${manifestPath}`);
      console.log(`Prefill: filled=${counts.filled} attached=${counts.attached} skipped=${counts.skipped} errors=${counts.errors}`);
      console.log(`Submit button: ${submitField ? (submitField.label || submitField.name || submitField.id || submitField.type) : 'not detected'}`);
      if (requiredMissing.length) console.log(`Required unfilled: ${requiredMissing.map((f) => f.label).join(', ')}`);
      if (nextControls.length) console.log(`Next/continue controls: ${nextControls.map((c) => c.label || c.name || c.id).join(', ')}`);
      if (!safety.safe) console.log(`Safety block: ${safety.reasons.join(', ')}`);
      console.log('');
      console.log('Review the browser form carefully. No submit has been performed.');
      if (safety.safe) console.log(`To submit now, type ${CONFIRM_WORD} exactly. Anything else keeps it draft-only.`);
      else console.log('Submission disabled by safety checks. Complete the form manually or resolve blockers, then rerun.');
    }

    const answer = (!jsonOut && safety.safe) ? await ask(`Confirmation (${CONFIRM_WORD} to submit, anything else to skip): `) : '';
    if (!jsonOut && safety.safe && answer === CONFIRM_WORD) {
      if (!submitField) {
        finalStatus = 'confirmed-no-submit-found';
        writeManifest(manifestPath, {
          humanConfirmation: { confirmed: true, confirmedAt: nowIso(), submittedByHuman: false, reason: 'submit-not-found' },
          timeline: [{ at: nowIso(), event: 'submit-requested-but-not-found' }],
        });
        console.error('apply-assist: confirmation received but no submit button detected; no action taken.');
      } else {
        // Recheck safety immediately before click.
        const fieldsNow = await detectFields(page);
        const requiredNow = await requiredUnfilled(fieldsNow, page);
        const nextNow = nextStepControls(fieldsNow);
        const submitNow = findSubmit(fieldsNow);
        const safetyNow = submitSafety({ submitField: submitNow, requiredMissing: requiredNow, nextControls: nextNow });
        if (!safetyNow.safe) {
          finalStatus = 'confirmed-blocked-by-safety-recheck';
          writeManifest(manifestPath, {
            humanConfirmation: { confirmed: true, confirmedAt: nowIso(), submittedByHuman: false, reason: 'safety-recheck-failed' },
            safetyRecheck: safetyNow,
            timeline: [{ at: nowIso(), event: 'submit-blocked-by-safety-recheck', safety: safetyNow }],
          });
          console.error(`apply-assist: submit blocked by safety recheck: ${safetyNow.reasons.join(', ')}`);
        } else {
          writeManifest(manifestPath, {
            humanConfirmation: { confirmed: true, confirmedAt: nowIso() },
            timeline: [{ at: nowIso(), event: 'human-confirmed-submit' }],
          });
          const selector = fieldSelector(submitNow);
          if (!selector) throw new Error('submit button has no usable selector');
          await page.locator(selector).first().click({ timeout: 5000 });
          await page.waitForTimeout(2500);
          submitResult = { attempted: true, submittedByHuman: true, at: nowIso(), finalUrl: page.url() };
          finalStatus = 'submitted-by-human-confirmation';
          let trackerUpdate = null;
          if (markApplied) {
            const day = new Date().toISOString().slice(0, 10);
            try {
              execFileSync(process.execPath, ['set-status.mjs', '--report', reportNum, 'Applied', '--on', day, '--note', `human-confirmed submit via apply-assist ${day}`], {
                cwd: REPO, encoding: 'utf8', timeout: 30000, env: { ...process.env, CAREER_OPS_ROOT: DATA_ROOT },
              });
              trackerUpdate = { ok: true, status: 'Applied', on: day };
            } catch (e) {
              trackerUpdate = { ok: false, error: String(e.stderr || e.message || e).slice(0, 200) };
            }
          }
          writeManifest(manifestPath, {
            humanConfirmation: { submittedByHuman: true, submittedAt: nowIso(), finalUrl: page.url() },
            trackerUpdate,
            timeline: [{ at: nowIso(), event: 'submit-clicked-after-confirmation', finalUrl: page.url(), trackerUpdate }],
          });
          console.log('apply-assist: submit click performed after explicit human confirmation.');
          if (trackerUpdate?.ok) console.log('apply-assist: tracker updated to Applied.');
          if (trackerUpdate && !trackerUpdate.ok) console.error(`apply-assist: tracker update failed: ${trackerUpdate.error}`);
        }
      }
    } else if (jsonOut) {
      finalStatus = safety.safe ? 'ready-for-confirmation' : 'blocked-for-safety';
    } else {
      writeManifest(manifestPath, {
        humanConfirmation: { confirmed: false, submittedByHuman: false, declinedAt: nowIso(), reason: safety.safe ? 'not-confirmed' : 'blocked-by-safety' },
        timeline: [{ at: nowIso(), event: safety.safe ? 'submit-not-confirmed' : 'submit-blocked-by-safety', safety }],
      });
      console.log(safety.safe ? 'apply-assist: no confirmation received; leaving as draft only.' : 'apply-assist: blocked by safety checks; leaving as draft only.');
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  writeManifest(manifestPath, { finalStatus, submitResult, finishedAt: nowIso(), safetyCheck: safety });
  if (jsonOut) console.log(JSON.stringify({ ok: true, finalStatus, submitResult, manifestPath, safety, requiredMissing, nextControls, counts, submitCandidate: summary?.submitCandidate || null, phase: finalStatus }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`apply-assist: ${err.message || err}`);
    process.exit(1);
  });
}
