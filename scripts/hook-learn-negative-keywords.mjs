#!/usr/bin/env node
/**
 * scripts/hook-learn-negative-keywords.mjs — aprende keywords negativos automáticamente.
 *
 * Lee el tracker (data/applications.md) y data/auto-skip.md, extrae palabras clave
 * de los títulos de ofertas descartadas (status DISCARD o SKIP) y las añade a
 * data/negative-keywords.yml si aún no están registradas.
 *
 * Esto hace que la lista de keywords negativos crezca automáticamente:
 * cada oferta que descartes manualmente "enseña" al sistema qué no te interesa.
 *
 * Uso:
 *   node scripts/hook-learn-negative-keywords.mjs   # aprende del tracker y auto-skip
 *
 * Config en config/hooks.yml (opcional, ejecutar tras merge-tracker):
 *   hooks:
 *     after-tracker-add:
 *       - scripts/hook-learn-negative-keywords.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../lib/yaml-document.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const TRACKER = join(DATA_ROOT, 'data', 'applications.md');
const AUTOSKIP = join(DATA_ROOT, 'data', 'auto-skip.md');
const KEYWORDS_FILE = join(DATA_ROOT, 'data', 'negative-keywords.yml');

const STOPWORDS = new Set([
  'de','del','la','el','en','y','a','los','las','por','para','con','un','una','para',
  'senior','junior','mid','level','engineer','developer','designer','manager','specialist',
  'analyst','coordinator','assistant','intern','full','stack','remote','híbrido','hibrido',
  'presencial','m/f/d','m/w/d','part','time','contract','freelance',
]);

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-záéíóúüñ0-9]/g, '');
}

function extractCandidateWords(title) {
  const words = title.split(/\s+/).map(normalizeWord).filter(w => w.length > 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function loadKeywords() {
  if (!existsSync(KEYWORDS_FILE)) return { keywords: [] };
  const cfg = loadYaml(readFileSync(KEYWORDS_FILE, 'utf-8'));
  return cfg || { keywords: [] };
}

function yamlEscape(s) {
  if (s === null || s === undefined) return '""';
  const str = String(s);
  if (/^[a-z0-9áéíóúüñ]+$/i.test(str)) return str;
  return '"' + str.replace(/"/g, '\\"') + '"';
}

function saveKeywords(cfg) {
  let out = '# career-ops: keywords negativos dinámicos\n';
  out += '# La lista crece automáticamente cuando descartas ofertas manualmente.\n\n';
  out += 'keywords:\n';
  for (const k of cfg.keywords) {
    out += '  - keyword: ' + yamlEscape(k.keyword) + '\n';
    out += '    source: ' + yamlEscape(k.source) + '\n';
    out += '    added: ' + yamlEscape(k.added) + '\n';
    if (k.examples && k.examples.length > 0) {
      out += '    examples:\n';
      for (const ex of k.examples) {
        out += '      - ' + yamlEscape(ex) + '\n';
      }
    } else {
      out += '    examples: []\n';
    }
  }
  writeFileSync(KEYWORDS_FILE, out, 'utf8');
}

function keywordExists(cfg, word) {
  return cfg.keywords.some(k => k.keyword === word);
}

function addKeyword(cfg, word, source, example) {
  if (keywordExists(cfg, word)) return false;
  cfg.keywords.push({
    keyword: word,
    source,
    added: new Date().toISOString().slice(0, 10),
    examples: example ? [example] : [],
  });
  return true;
}

function parseTrackerRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 6) continue;
    const num = cells[1];
    if (!num || num === '#') continue;
    const status = cells[5] || '';
    const role = cells[3] || '';
    const notes = cells[8] || '';
    rows.push({ num, status, role, notes });
  }
  return rows;
}

function main() {
  const cfg = loadKeywords();
  let added = 0;
  const learned = [];

  // 1. Aprender del tracker: ofertas con status DISCARD o SKIP
  if (existsSync(TRACKER)) {
    const trackerText = readFileSync(TRACKER, 'utf-8');
    const rows = parseTrackerRows(trackerText);
    for (const row of rows) {
      if (!/^(discard|skip)$/i.test(row.status)) continue;
      const words = extractCandidateWords(row.role);
      for (const w of words) {
        if (keywordExists(cfg, w)) continue;
        addKeyword(cfg, w, 'user-discard', row.role);
        learned.push(w);
        added++;
      }
    }
  }

  // 2. Aprender de data/auto-skip.md (ofertas auto-descartadas por keywords negativos)
  if (existsSync(AUTOSKIP)) {
    const skipText = readFileSync(AUTOSKIP, 'utf-8');
    for (const line of skipText.split('\n')) {
      const m = line.match(/\| ([^|]+) \| auto-skip:/);
      if (!m) continue;
      const role = m[1].trim();
      const words = extractCandidateWords(role);
      for (const w of words) {
        if (keywordExists(cfg, w)) continue;
        addKeyword(cfg, w, 'auto-scan', role);
        learned.push(w);
        added++;
      }
    }
  }

  if (added > 0) {
    saveKeywords(cfg);
    console.log(`🪝 Hook learn-negative-keywords: ${added} keyword(s) nueva(s) aprendida(s): ${learned.join(', ')}`);
    console.log(`   Registradas en data/negative-keywords.yml`);
  } else {
    console.log('🪝 Hook learn-negative-keywords: no hay keywords nuevas que aprender.');
  }
}

main();
