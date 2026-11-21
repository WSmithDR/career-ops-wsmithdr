#!/usr/bin/env node
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import {
  appendToPipeline, appendToScanHistory, appendUnrecordedToScanHistory,
  loadSeenUrls, buildTitleFilter, buildLocationFilter, loadBlacklist,
  PORTALS_PATH,
} from './scan.mjs';
import { createAdmissionGate } from './lib/admission-gate.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const DATA_ROOT = getCareerOpsRoot();
const BASE = 'https://www.turijobs.com/es/ofertas-trabajo';
const SEL_OFFER_LINK = 'a[href*="/es/oferta-trabajo/"]';
const DEFAULT_CITIES = ['madrid'];

const KNOWN_FLAGS = ['--dry-run', '--debug', '--all', '--city', '--help', '-h'];
const VALUE_FLAGS = ['--city'];
const args = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const NO_FILTER = args.includes('--all');
const CITIES    = flagValues(args, '--city');

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

function parseTurijobsOfferText(text) {
  const parts = text.split(' - ').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return { title: parts[0], company: parts.length >= 2 ? parts[parts.length - 1] : '', location: parts.length >= 3 ? parts[parts.length - 1] : '' };
}
function isOfferUrl(href) { return typeof href === 'string' && /\/es\/oferta-trabajo\//.test(href); }
function absolutize(href) { try { return new URL(href, 'https://www.turijobs.com').href; } catch { return ''; } }
function loadLastScanDate() {
  const hist = join(DATA_ROOT, 'data', 'scan-history.tsv');
  if (!existsSync(hist)) return null;
  let latest = null;
  for (const line of readFileSync(hist, 'utf-8').split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 4 && parts[4] === 'turijobs') { const d = parts[1]; if (d && (!latest || d > latest)) latest = d; }
  }
  return latest ? new Date(latest) : null;
}

let config = {};
if (existsSync(PORTALS_PATH)) config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
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

try {
  for (const city of CITIES.length ? CITIES : DEFAULT_CITIES) {
    console.log(`  ${city}...`);
    try {
      await page.goto(`${BASE}/${city}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('button:has-text("Aceptar"), button:has-text("Accept")').first().click().catch(() => null);
      await page.waitForSelector('a[href*="/es/oferta-trabajo/"]', { state: 'visible', timeout: 15000 }).catch(() => null);

      const links = page.locator('a[href*="/es/oferta-trabajo/"]');
      const count = await links.count();
      console.log(`    ${count} links`);

      for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const href = await link.getAttribute('href').catch(() => '') || '';
        if (!isOfferUrl(href)) continue;
        const text = (await link.textContent()) || '';
        const parsed = parseTurijobsOfferText(text);
        if (!parsed || !parsed.title) continue;
        const absUrl = absolutize(href);
        if (!absUrl) continue;

        const offer = { title: parsed.title, company: parsed.company || '?', location: parsed.location || '', url: absUrl, source: 'turijobs' };
        if (handled.has(offer.url)) continue;
        handled.add(offer.url);

        const reason = gate.check(offer);
        if (reason === 'seen') { dupeSkipped.push(offer); continue; }
        if (reason === 'blacklisted') continue;
        if (reason === 'title') { titleSkipped.push(offer); continue; }
        if (reason === 'location') { locationSkipped.push(offer); continue; }
        if (lastScanDate && offer.postedAt && offer.postedAt < lastScanDate.getTime()) { dateSkipped.push(offer); continue; }
        newOffers.push(offer);
        totalFound++;
      }
    } catch (err) {
      console.log(`    ERROR: ${err.message}`);
      errors.push({ city, error: err.message });
    }
  }
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

printScanSummaryHeader('Turijobs Scan', date);
console.log(`Cities:        ${CITIES.length ? CITIES.length : DEFAULT_CITIES.length}`);
console.log(`Total found:   ${totalFound}`);
console.log(`Filtered title:${titleSkipped.length}`);
console.log(`Filtered loc:  ${locationSkipped.length}`);
console.log(`Filtered date: ${dateSkipped.length}`);
console.log(`Duplicates:    ${dupeSkipped.length}`);
console.log(`New offers:    ${newOffers.length}`);
if (errors.length) { console.log(`\nErrors (${errors.length}):`); for (const e of errors) console.log(`  ✗ ${e.city}: ${e.error}`); }
if (newOffers.length) { console.log('\nNew offers:'); for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`); if (DRY_RUN) console.log('(dry run — not saved)'); else console.log(`Saved to data/pipeline.md`); }
console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
