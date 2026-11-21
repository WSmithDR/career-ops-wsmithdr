#!/usr/bin/env node
/**
 * scripts/hook-after-scan.mjs — descarta automáticamente ofertas con keywords
 * negativos en el título después de un scan.
 *
 * Usa la lista dinámica en data/negative-keywords.yml (crece automáticamente
 * con hook-learn-negative-keywords.mjs).
 *
 * Config en config/hooks.yml:
 *   hooks:
 *     after-scan:
 *       - scripts/hook-after-scan.mjs
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../lib/yaml-document.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PIPELINE = join(DATA_ROOT, 'data', 'pipeline.md');
const AUTOSKIP = join(DATA_ROOT, 'data', 'auto-skip.md');
const KEYWORDS_FILE = join(DATA_ROOT, 'data', 'negative-keywords.yml');

function loadNegativeKeywords() {
  if (!existsSync(KEYWORDS_FILE)) return [];
  try {
    const cfg = loadYaml(readFileSync(KEYWORDS_FILE, 'utf-8'));
    return (cfg.keywords || []).map(k => k.keyword);
  } catch {
    return [];
  }
}

function isNegative(title, keywords) {
  const lower = title.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function extractPendingOffers(text) {
  const offers = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- \[ \]\s+(https?:\/\/[^|]+)\|([^|]+)\|([^|]+)/);
    if (!m) continue;
    const url = m[1].trim();
    const company = m[2].trim();
    const role = m[3].trim();
    offers.push({ url, company, role });
  }
  return offers;
}

if (!existsSync(PIPELINE)) {
  process.exit(0);
}

const keywords = loadNegativeKeywords();
const text = readFileSync(PIPELINE, 'utf-8');
const offers = extractPendingOffers(text);
const negative = offers.filter(o => isNegative(o.role, keywords));

if (negative.length === 0) {
  console.log(`🪝 Hook after-scan: ninguna oferta con keywords negativos (${keywords.length} keywords activas).`);
  process.exit(0);
}

mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });
const timestamp = new Date().toISOString().slice(0, 10);
const lines = negative.map(o => `- [ ] ${o.url} | ${o.company} | ${o.role} | auto-skip: keyword negativo en título | ${timestamp}`);
writeFileSync(AUTOSKIP, lines.join('\n') + '\n', { flag: 'a' });

console.log(`🪝 Hook after-scan: ${negative.length} ofertas con keywords negativos registradas en data/auto-skip.md (${keywords.length} keywords activas).`);
for (const o of negative) {
  console.log(`   ✗ ${o.company} | ${o.role}`);
}
