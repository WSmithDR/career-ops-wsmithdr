#!/usr/bin/env node
/**
 * scan-domestika.mjs — Domestika portal scanner via Playwright.
 *
 * Domestika (domestika.org) — creative jobs board (Spain/LatAm).
 * No public API / RSS; listings scraped through Playwright.
 *
 * Listings at: https://www.domestika.org/es/jobs
 * Each offer is in a div.col-lg-6 containing:
 *   - <a class="job-item__logo" title="Title" href="/es/jobs/{id}-{slug}-{city}-espana">
 *   - <h2 class="job-item__title">Title</h2>
 *   - <div class="job-item__city">Location</div>
 *   - <div class="job-item__date">DD/MM/YY</div>
 *
 * Usage:
 *   node scan-domestika.mjs [--dry-run] [--debug] [--all]
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import {
  appendToPipeline,
  appendToScanHistory,
  appendUnrecordedToScanHistory,
  loadSeenUrls,
  buildTitleFilter,
  buildLocationFilter,
  loadBlacklist,
  PORTALS_PATH,
} from './scan.mjs';
import { createAdmissionGate } from './lib/admission-gate.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const DATA_ROOT = getCareerOpsRoot();
const BASE = 'https://www.domestika.org/es/jobs';
const SEL_OFFER_ROW = 'div.col-lg-6';
const SEL_TITLE_LINK = 'a.job-item__logo';
const SEL_TITLE_TEXT = '.job-item__title';
const SEL_CITY = '.job-item__city';
const SEL_DATE = '.job-item__date';

const DEFAULT_PAGES = 1;
const MAX_PAGES = 50;

const KNOWN_FLAGS = ['--dry-run', '--debug', '--all', '--help', '-h'];
const USAGE = `Usage:
  node scan-domestika.mjs [--dry-run] [--debug] [--all]
  --all    skip date filter (first scan)
  --dry-run print only, do not write pipeline.md / scan-history.tsv
  --debug  save screenshot + HTML to data/output/
`;

const args = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const DEBUG     = args.includes('--debug');
const NO_FILTER = args.includes('--all');

function flagValues(arr, flag) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === flag && arr[i + 1] && !arr[i + 1].startsWith('--')) { out.push(arr[i + 1]); i++; }
  }
  return out;
}

function loadYaml(text) {
  const result = {};
  let currentList = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) { currentList = null; result[m[1]] = m[2] ? JSON.parse(m[2]) : []; if (Array.isArray(result[m[1]])) currentList = m[1]; continue; }
    const m2 = line.match(/^\s{2}-\s+(.+)$/);
    if (m2 && currentList) result[currentList].push(m2[1]);
  }
  return result;
}

function parseDomestikaDate(str) {
  if (!str) return undefined;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return undefined;
  const [, d, mo, y] = m;
  const parsed = Date.parse(`${2000 + Number(y)}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00Z`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function loadLastScanDate() {
  const hist = join(DATA_ROOT, 'data', 'scan-history.tsv');
  if (!existsSync(hist)) return null;
  let latest = null;
  for (const line of readFileSync(hist, 'utf-8').split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 4 && parts[4] === 'domestika') {
      const d = parts[1];
      if (d && (!latest || d > latest)) latest = d;
    }
  }
  return latest ? new Date(latest) : null;
}

let config = {};
if (existsSync(PORTALS_PATH)) {
  config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}
const gate = createAdmissionGate({ config });
const date = localToday();
const lastScanDate = NO_FILTER ? null : loadLastScanDate();
const { seen } = loadSeenUrls();
let totalFound = 0;
const newOffers = [];
const titleSkipped = [], locationSkipped = [], dateSkipped = [], dupeSkipped = [], errors = [];
const handled = new Set();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
const page = await context.newPage();
let pageNum = 1;

try {
  while (pageNum <= MAX_PAGES) {
    const url = pageNum === 1 ? BASE : `${BASE}?page=${pageNum}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    await page.locator('button:has-text("Aceptar"), button:has-text("Accept")').first().click().catch(() => null);

    if (DEBUG) {
      const dir = join(DATA_ROOT, 'output');
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `debug-domestika-p${pageNum}.png`), fullPage: true });
      const fs = await import('fs');
      fs.writeFileSync(join(dir, `debug-domestika-p${pageNum}.html`), await page.content());
    }

    await page.waitForSelector(SEL_OFFER_ROW, { state: 'visible', timeout: 15000 }).catch(() => null);

    const pageJobs = await page.evaluate(() => {
      const rows = document.querySelectorAll('div.col-lg-6');
      const jobs = [];
      for (const row of rows) {
        const link = row.querySelector('a.job-item__logo');
        const titleEl = row.querySelector('.job-item__title');
        const cityEl = row.querySelector('.job-item__city');
        const dateEl = row.querySelector('.job-item__date');
        if (!link || !titleEl) continue;
        const href = link.getAttribute('href') || '';
        const title = (titleEl.textContent || link.getAttribute('title') || '').trim();
        const city = (cityEl?.textContent || '').trim();
        const dateStr = (dateEl?.textContent || '').trim();
        if (!title || !href) continue;
        jobs.push({ title, city, dateStr, href });
      }
      return jobs;
    });

    totalFound += pageJobs.length;

    for (const job of pageJobs) {
      const absUrl = job.href.startsWith('http') ? job.href : `https://www.domestika.org${job.href}`;
      const postedAt = parseDomestikaDate(job.dateStr);

      if (handled.has(absUrl)) continue;
      handled.add(absUrl);

      const offer = { title: job.title, company: '?', location: job.city, url: absUrl, source: 'domestika', postedAt };
      const reason = gate.check(offer);
      if (reason === 'seen') { dupeSkipped.push(offer); continue; }
      if (reason === 'blacklisted') continue;
      if (reason === 'title') { titleSkipped.push(offer); continue; }
      if (reason === 'location') { locationSkipped.push(offer); continue; }
      if (lastScanDate && postedAt && postedAt < lastScanDate.getTime()) { dateSkipped.push(offer); continue; }
      newOffers.push(offer);
    }

    // Pagination: look for "Siguiente" or page links
    const next = page.locator('a:has-text("Siguiente"), a.next, [rel="next"]').first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.evaluate(el => el.click()).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    pageNum++;
    if (!NO_FILTER && pageNum > DEFAULT_PAGES) break;
  }
} catch (err) {
  console.log(`ERROR: ${err.message}`);
  errors.push({ error: err.message });
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

if (!DRY_RUN) {
  if (newOffers.length) await appendToPipeline(newOffers);
  if (newOffers.length) await appendToScanHistory(newOffers, date, 'added');
  await appendUnrecordedToScanHistory(titleSkipped, date, 'skipped_title');
  await appendUnrecordedToScanHistory(locationSkipped, date, 'skipped_location');
  await appendUnrecordedToScanHistory(dateSkipped, date, 'skipped_date');
  await appendUnrecordedToScanHistory(dupeSkipped, date, 'skipped_dup');
}

printScanSummaryHeader('Domestika Scan', date);
console.log(`Pages:         ${pageNum - 1}`);
console.log(`Total found:   ${totalFound}`);
console.log(`Filtered title:${titleSkipped.length}`);
console.log(`Filtered loc:  ${locationSkipped.length}`);
console.log(`Filtered date: ${dateSkipped.length}`);
console.log(`Duplicates:    ${dupeSkipped.length}`);
console.log(`New offers:    ${newOffers.length}`);
if (errors.length) { console.log(`\nErrors (${errors.length}):`); for (const e of errors) console.log(`  ✗ ${e.error}`); }
if (newOffers.length) { console.log('\nNew offers:'); for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`); if (DRY_RUN) console.log('(dry run — not saved)'); else console.log(`Saved to data/pipeline.md`); }
console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
