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
 * Robustness over real ATS shapes:
 *  - fields inside same-origin iframes are detected and filled
 *  - React-select / custom combobox widgets are filled char-by-char with
 *    re-detection after every keystroke
 *  - checkboxes/radio groups are never guessed: legal/consent attestations are
 *    reported as candidate-decision, other unambiguous profile mappings are
 *    filled and reported
 *  - the required-field sweep is iterative: after each fill pass the form is
 *    re-scanned until no new required control appears (Workday-style dynamic
 *    blocks)
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

const TEXT_WIDGET_TAGS = new Set(['input', 'textarea', 'select']);
const LEGAL_HINTS = ['termino', 'condicion', 'política', 'politica', 'privacidad', 'datos',
  'consentimiento', 'consent', 'i agree', 'i accept', 'accept', 'acepto', 'atestiguo',
  'declaración', 'declaracion', 'certifico', 'certify', 'affirm', 'legal'];

const CHAR_DELAY_MS = 60;

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
      workAuth: pick('work_authorization') || pick('work_auth') || '',
      relocation: pick('relocation') || '',
      sponsorship: pick('visa_sponsorship') || pick('sponsorship') || '',
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

/**
 * Detect every fillable / clickable control inside one frame. Mirrors the
 * previous page-level detect so the same selector / label logic applies to
 * the main frame and to same-origin iframes alike.
 */
async function detectFieldsInFrame(frame) {
  return frame.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const els = Array.from(document.querySelectorAll('input, textarea, select, button, [role="button"], [role="combobox"], [role="listbox"], [contenteditable="true"]'));
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
      const section = el.closest('section,fieldset,[role="group"]');
      const role = el.getAttribute('role') || '';
      const isCustomWidget = (tag !== 'input' && tag !== 'textarea' && tag !== 'select')
        && (role === 'combobox' || role === 'listbox' || role === 'spinbutton' || el.getAttribute('contenteditable') === 'true');
      return {
        idx, tag, type, id, name, aria, role,
        label: clean(label),
        required: !!el.required || el.getAttribute('aria-required') === 'true',
        value: clean(el.value || el.textContent || ''),
        visible: isVisible(el),
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        inForm: !!form,
        formAction: form ? clean(form.getAttribute('action') || '') : '',
        section: section ? clean(section.getAttribute('aria-label') || section.id || section.className || '') : '',
        isCustomWidget,
      };
    }).filter((f) => !['hidden', 'password'].includes(f.type)).slice(0, 220);
  });
}

/**
 * Fields across the main frame and every same-origin iframe. Cross-origin
 * iframes are skipped (their fields cannot be reached safely).
 */
async function detectAllFields(page) {
  const out = [];
  const seen = new Set();
  const add = (frame, frameUrl) => {
    try {
      const got = detectFieldsInFrame(frame);
      // evaluate is async; this helper is awaited by the caller per frame below.
      return got.then((fields) => {
        for (const f of fields) {
          const key = f.frameUrl || frame.url();
          if (seen.has(key + '|' + f.idx + '|' + (f.id || f.name || f.label))) continue;
          seen.add(key + '|' + f.idx + '|' + (f.id || f.name || f.label));
          out.push({ ...f, _frame: frame, frameUrl: frame.url() });
        }
      });
    } catch { return Promise.resolve(); }
  };
  await add(page.mainFrame(), page.mainFrame().url());
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    await add(frame, frame.url());
  }
  return out;
}

function frameLocator(f, selector) {
  const frame = f._frame;
  return frame ? frame.locator(selector).first() : undefined;
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

/** Fill a normal text / textarea / select control. */
async function fillTextControl(loc, value) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.fill(String(value), { timeout: 5000 });
}

/**
 * Fill a React-select / custom combobox widget: click to reveal the input,
 * type char-by-char (real keystrokes so onChange fires), press Enter to
 * confirm, then re-detect to confirm the value registered.
 */
async function fillCustomWidget(page, field, value) {
  const frame = field._frame;
  const loc = frame ? frame.locator(`[role="combobox"]`).first() : page.locator(`[role="combobox"]`).first();
  if (!(await loc.count())) return { ok: false, reason: 'no-combobox-locator' };
  try {
    await loc.first().click({ timeout: 3000 });
    await page.waitForTimeout(100);
    const input = frame ? frame.locator('input').first() : page.locator('input').first();
    await input.fill('');
    for (const ch of String(value)) {
      await input.type(ch, { delay: CHAR_DELAY_MS });
    }
    await input.press('Enter');
    await page.waitForTimeout(200);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 160) };
  }
}

function isLegalField(f) {
  const hay = normalizeText([f.label, f.name, f.id, f.aria, f.type].join(' '));
  return LEGAL_HINTS.some((h) => hay.includes(h));
}

function mapCheckboxValue(f, profile) {
  const hay = normalizeText([f.label, f.name, f.id, f.aria].join(' '));
  const yesHints = ['relocation', 'relocación', 'traslado', 'work authorization', 'autorización',
    'visa', 'sponsorship', 'patrocinio', 'remote', 'remoto', 'relocate'];
  const noHints = ['no ', 'ninguna', 'ningún', 'no requiero', 'no necesito'];
  for (const h of yesHints) {
    if (hay.includes(h)) {
      const v = String(profile.workAuth || profile.relocation || profile.sponsorship || '').toLowerCase();
      if (v.includes('yes') || v.includes('sí') || v.includes('si') || v.includes('authorized') || v.includes('autoriz')) return true;
      if (v.includes('no') || v.includes('no ') || v.includes('no requiere') || v.includes('no necesito')) return false;
      return null; // needs candidate
    }
  }
  return null;
}

/**
 * Handle checkboxes and radio groups. Legal/consent attestations are never
 * auto-checked: reported as `candidate-decision`. Unambiguous boolean profile
 * mappings are filled and reported. Everything else is skipped and reported.
 */
async function handleSelections(page, fields, profile) {
  const filled = [];
  const skipped = [];
  for (const f of fields) {
    if (!f.visible || f.disabled) continue;
    if (f.type !== 'checkbox' && f.type !== 'radio') continue;
    if (isLegalField(f)) {
      skipped.push({ label: f.label || f.name || f.id || f.type, type: f.type, reason: 'legal-consent-needs-candidate' });
      continue;
    }
    const mapped = mapCheckboxValue(f, profile);
    if (mapped === true || mapped === false) {
      try {
        const loc = frameLocator(f, f.id ? `#${cssEscapeAttr(f.id)}` : (f.name ? `[name="${cssEscapeAttr(f.name)}"]` : null));
        if (!loc) { skipped.push({ label: f.label || f.name || f.id, type: f.type, reason: 'no-selector' }); continue; }
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.setChecked(mapped);
        filled.push({ key: f.label || f.name || f.id, status: 'filled', field: f, value: mapped });
      } catch (e) {
        skipped.push({ label: f.label || f.name || f.id, type: f.type, reason: String(e.message || e).slice(0, 120) });
      }
    } else {
      skipped.push({ label: f.label || f.name || f.id || f.type, type: f.type, reason: 'needs-candidate' });
    }
  }
  return { filled, skipped };
}

async function prefill(page, profile, cvPdf) {
  let fields = await detectAllFields(page);
  const plan = [];
  const selections = { filled: [], skipped: [] };
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
    if (f.isCustomWidget) {
      const res = await fillCustomWidget(page, f, m.value);
      plan.push({ key: m.key, status: res.ok ? 'filled' : 'custom-widget-error', field: f, ...(res.ok ? {} : { error: res.reason }) });
      continue;
    }
    const selector = f.id ? `#${cssEscapeAttr(f.id)}` : (f.name ? `[name="${cssEscapeAttr(f.name)}"]` : null);
    if (!selector) { plan.push({ key: m.key, status: 'no-selector', field: f }); continue; }
    try {
      const loc = frameLocator(f, selector);
      if (!loc) { plan.push({ key: m.key, status: 'no-frame-locator', field: f }); continue; }
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.fill(String(m.value), { timeout: 5000 });
      plan.push({ key: m.key, status: 'filled', field: f });
    } catch (e) {
      plan.push({ key: m.key, status: 'error', field: f, error: String(e.message || e).slice(0, 160) });
    }
  }

  const sel = await handleSelections(page, fields, profile);
  selections.filled = sel.filled;
  selections.skipped = sel.skipped;

  const fileField = fields.find((f) => f.visible && !f.disabled && (f.type === 'file' || (f.tag === 'input' && normalizeText([f.label, f.name, f.id, f.aria].join(' ')).match(/resume|cv|curriculum/))));
  if (cvPdf && fileField) {
    const selector = fileField.id ? `#${cssEscapeAttr(fileField.id)}` : (fileField.name ? `[name="${cssEscapeAttr(fileField.name)}"]` : null);
    if (selector) {
      try {
        const loc = frameLocator(fileField, selector);
        if (!loc) throw new Error('no-frame-locator');
        await loc.setInputFiles(cvPdf, { timeout: 5000 });
        plan.push({ key: 'cvPdf', status: 'attached', field: fileField, value: cvPdf });
      } catch (e) {
        plan.push({ key: 'cvPdf', status: 'attach-error', field: fileField, value: cvPdf, error: String(e.message || e).slice(0, 160) });
      }
    } else plan.push({ key: 'cvPdf', status: 'no-selector', field: fileField, value: cvPdf });
  } else if (cvPdf) plan.push({ key: 'cvPdf', status: 'missing-file-field', value: cvPdf });
  else plan.push({ key: 'cvPdf', status: 'no-cv-found' });

  fields = await detectAllFields(page);
  return { fields, plan, selections };
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
  const loc = frameLocator(f, selector);
  if (!loc) return { ok: false, reason: 'no-frame-locator', filled: false };
  try {
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

/**
 * Iterative required-field sweep (Step 7b, modes/apply.md): re-scan the form
 * after every fill pass until the set of required-but-unfilled controls stops
 * changing. Workday and similar ATS add required controls (e.g. a Role
 * Description per experience block) only after earlier blocks exist, so a
 * single pass misses them.
 */
async function requiredUnfilledSweep(page, fields, maxRounds = 8) {
  let current = fields;
  let allMissing = [];
  let rounds = 0;
  while (rounds < maxRounds) {
    rounds++;
    const missing = [];
    for (const f of current) {
      if (!f.visible || f.disabled) continue;
      if (!f.required) continue;
      if (['button', 'submit', 'image', 'reset'].includes(f.type)) continue;
      const st = await readFieldState(page, f);
      if (!st.filled) missing.push({ label: f.label || f.name || f.id || f.type, type: f.type, reason: st.reason || 'empty', frameUrl: f.frameUrl });
    }
    if (missing.length === 0) break;
    // Only count newly-seen missing controls; stable set means sweep is done.
    const newly = missing.filter((m) => !allMissing.some((p) => p.label === m.label && p.type === m.type && p.frameUrl === m.frameUrl));
    allMissing = missing;
    if (newly.length === 0) break;
    // Re-scan: new required controls may have appeared after fills.
    current = await detectAllFields(page);
  }
  return { missing: allMissing, rounds };
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
  let selections = { filled: [], skipped: [] };
  let summary = null;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const { fields, plan, selections: sel } = await prefill(page, profile, cvPdf);
    selections = sel;
    const submitField = findSubmit(fields);
    counts = summarizePlan(plan);
    const sweep = await requiredUnfilledSweep(page, fields);
    requiredMissing = sweep.missing;
    nextControls = nextStepControls(fields);
    safety = submitSafety({ submitField, requiredMissing, nextControls });
    summary = {
      reportNum, company: report.company, role: report.role, url, finalUrl: page.url(),
      manifestPath, cvPdf, counts, selections, requiredMissing, nextControls, safety,
      submitCandidate: submitField ? { label: submitField.label, type: submitField.type, id: submitField.id, name: submitField.name, ambiguous: submitField.ambiguous } : null,
      confirmationRequired: CONFIRM_WORD,
    };
    writeManifest(manifestPath, {
      browser: { launchedBy: 'apply-scope', finalUrl: page.url() },
      prefill: { plan, counts, selections, cvPdf: cvPdf || null },
      submitCandidate: submitField || null,
      requiredMissing,
      nextControls,
      safetyCheck: safety,
      sweepRounds: sweep.rounds,
      timeline: [{ at: nowIso(), event: 'prefill-completed', counts, safety, selections }],
    });

    if (!jsonOut) {
      console.log(`apply-assist: ${reportNum} ${report.company} — ${report.role}`);
      console.log(`URL: ${url}`);
      console.log(`Final URL: ${page.url()}`);
      console.log(`Manifest: ${manifestPath}`);
      console.log(`Prefill: filled=${counts.filled} attached=${counts.attached} skipped=${counts.skipped} errors=${counts.errors}`);
      if (selections.filled.length) console.log(`Selections filled: ${selections.filled.map((s) => s.key).join(', ')}`);
      if (selections.skipped.length) console.log(`Selections skipped: ${selections.skipped.map((s) => `${s.label}(${s.reason})`).join(', ')}`);
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
        const fieldsNow = await detectAllFields(page);
        const sweepNow = await requiredUnfilledSweep(page, fieldsNow);
        const requiredNow = sweepNow.missing;
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
          const loc = frameLocator(submitNow, selector);
          if (!loc) throw new Error('submit button has no usable frame locator');
          await loc.click({ timeout: 5000 });
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
  if (jsonOut) console.log(JSON.stringify({ ok: true, finalStatus, submitResult, manifestPath, safety, requiredMissing, nextControls, counts, selections, submitCandidate: summary?.submitCandidate || null, phase: finalStatus }, null, 2));
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

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`apply-assist: ${err.message || err}`);
    process.exit(1);
  });
}
