#!/usr/bin/env node
/**
 * scan-studentjob.mjs — StudentJob portal scanner via Playwright.
 *
 * StudentJob (studentjob.es) — student / junior jobs in Spain.
 * Listings at: https://www.studentjob.es/ofertas
 * Each offer is an <a.job-opening-track> with data attributes:
 *   data-job-opening-id, data-job-opening-title, data-job-opening-item-brand,
 *   data-job-opening-salary-min, data-job-opening-salary-max, href.
 *
 * Usage:
 *   node scan-studentjob.mjs [--dry-run] [--debug] [--all]
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
const BASE = 'https://www.studentjob.es/ofertas';

const KNOWN_FLAGS = ['--dry-run', '--debug', '--all', '--help', '-h'];
const USAGE = `Usage:
  node scan-studentjob.mjs [--dry-run] [--debug] [--all]
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

let config = {};
if (existsSync(PORTALS_PATH)) {
  config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}
const gate = createAdmissionGate({ config });
const date = localToday();
const { seen } = loadSeenUrls();
let totalFound = 0;
const newOffers = [];
const titleSkipped = [], locationSkipped = [], dateSkipped = [], dupeSkipped = [], errors = [];
const handled = new Set();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
const page = await context.newPage();

try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });

  await page.locator('button:has-text("Aceptar"), button:has-text("Accept")').first().click().catch(() => null);

  if (DEBUG) {
    const dir = join(DATA_ROOT, 'output');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, 'debug-studentjob.png'), fullPage: true });
    const fs = await import('fs');
    fs.writeFileSync(join(dir, 'debug-studentjob.html'), await page.content());
  }

  await page.waitForSelector('a.job-opening-track', { state: 'visible', timeout: 15000 }).catch(() => null);

  const pageJobs = await page.evaluate(() => {
    const links = document.querySelectorAll('a.job-opening-track');
    const jobs = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const title = (link.getAttribute('data-job-opening-title') || '').trim();
      const company = (link.getAttribute('data-job-opening-item-brand') || '').trim();
      const salaryMin = link.getAttribute('data-job-opening-salary-min');
      const salaryMax = link.getAttribute('data-job-opening-salary-max');
      if (!title || !href) continue;
      jobs.push({ title, company, href, salaryMin, salaryMax });
    }
    return jobs;
  });

  totalFound = pageJobs.length;

  for (const job of pageJobs) {
    const absUrl = job.href.startsWith('http') ? job.href : `https://www.studentjob.es${job.href}`;
    if (handled.has(absUrl)) continue;
    handled.add(absUrl);

    let location = '';
    // Try to extract location from page context near this link — skipped for now,
    // location filter will use empty string (passes through most filters).

    const offer = {
      title: job.title,
      company: job.company || '?',
      location,
      url: absUrl,
      source: 'studentjob',
    };
    const reason = gate.check(offer);
    if (reason === 'seen') { dupeSkipped.push(offer); continue; }
    if (reason === 'blacklisted') continue;
    if (reason === 'title') { titleSkipped.push(offer); continue; }
    if (reason === 'location') { locationSkipped.push(offer); continue; }
    newOffers.push(offer);
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

printScanSummaryHeader('StudentJob Scan', date);
console.log(`Total found:   ${totalFound}`);
console.log(`Filtered title:${titleSkipped.length}`);
console.log(`Filtered loc:  ${locationSkipped.length}`);
console.log(`Filtered date: ${dateSkipped.length}`);
console.log(`Duplicates:    ${dupeSkipped.length}`);
console.log(`New offers:    ${newOffers.length}`);
if (errors.length) { console.log(`\nErrors (${errors.length}):`); for (const e of errors) console.log(`  ✗ ${e.error}`); }
if (newOffers.length) { console.log('\nNew offers:'); for (const o of newOffers) console.log(`  + ${o.company} | ${o.title}`); if (DRY_RUN) console.log('(dry run — not saved)'); else console.log(`Saved to data/pipeline.md`); }
console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
