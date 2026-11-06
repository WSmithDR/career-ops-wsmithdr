#!/usr/bin/env node
/**
 * search-portals.mjs — busca ofertas de empleo en portales vía búsqueda web.
 *
 * Algunos portales (InfoJobs, Domestika, Tecnoempleo, Job Today, Turijobs,
 * Fashion Jobs, StudentJob, Primero Empleo, Vacantes.lat, TellmeJobs, Loka,
 * Civo, Remote.com) no exponen feed RSS ni ATS estándar detectable, así que
 * no entran en `tracked_companies`. Este script los busca con DuckDuckGo y
 * Bing (fallback) y deja los enlaces en `output/search-portals/` para que
 * tú los abras y apliques.
 *
 * Limitaciones honradas:
 *   - Los motores de búsqueda rate-limitean y pueden mostrar captcha.
 *   - Los resultados de búsqueda pueden cambiar de formato sin aviso.
 *   - Nunca envía correos ni rellena formularios: solo deja enlaces.
 *
 * Uso:
 *   node automation/search-portals.mjs [--delay MS] [--max-results N] [--out DIR]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const DEFAULT_OUT = join(REPO, 'output', 'search-portals');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portals = [
  { name: 'infojobs', base: 'infojobs.net', label: 'InfoJobs' },
  { name: 'domestika', base: 'domestika.org/es/jobs', label: 'Domestika Jobs' },
  { name: 'tecnoempleo', base: 'tecnoempleo.com', label: 'Tecnoempleo' },
  { name: 'jobtoday', base: 'jobs.today', label: 'Job Today' },
  { name: 'turijobs', base: 'turijobs.com', label: 'Turijobs' },
  { name: 'fashionjobs', base: 'fashionjobs.com', label: 'Fashion Jobs' },
  { name: 'studentjob', base: 'studentjob.es', label: 'StudentJob' },
  { name: 'primeroempleo', base: 'primeroempleo.gob.ec', label: 'Primero Empleo' },
  { name: 'vacanteslat', base: 'vacantes.lat', label: 'Vacantes.lat' },
  { name: 'tellmejobs', base: 'tellmejobs.com', label: 'TellmeJobs' },
  { name: 'loka', base: 'loka.local', label: 'Loka' },
  { name: 'civo', base: 'civo.com', label: 'Civo' },
  { name: 'remote', base: 'remote.com/openings', label: 'Remote.com' },
  { name: 'buffer', base: 'buffer.com/careers', label: 'Buffer careers' },
  { name: 'deel', base: 'deel.com/careers', label: 'Deel careers' },
  { name: 'automattic', base: 'automattic.com/careers', label: 'Automattic careers' },
  { name: 'hubstaff', base: 'hubstaff.com/jobs', label: 'Hubstaff jobs' },
];

const KEYWORDS = [
  '"AI Engineer"', '"Full Stack"', '"Software Engineer"', '"Desarrollador"',
  '"IA"', '"Inteligencia Artificial"', '"Frontend"', '"Backend"',
  '"DevOps"', '"Machine Learning"', '"LLM"', '"Agentic"',
];
const LOCATIONS = ['remote', 'remoto', 'teletrabajo', 'LATAM', 'Ecuador'];

function parseArgs(argv) {
  const args = { delay: 12000, maxResults: 5, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--delay') args.delay = Number(argv[++i]) || args.delay;
    if (a === '--max-results') args.maxResults = Number(argv[++i]) || args.maxResults;
    if (a === '--out') args.out = argv[++i];
  }
  return args;
}

/** Intenta fetch con reintentos y backoff exponencial. */
async function fetchWithRetry(url, opts, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      return await res.text();
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(1000 * 2 ** attempt, 10000);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function ddgSearch(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const html = await fetchWithRetry(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en,es;q=0.8' },
  });

  const blocked = /anomaly|challenge|unusual traffic|blocked/i.test(html);
  if (blocked) return { blocked: true, results: [], engine: 'ddg' };

  const results = [];
  for (const m of html.matchAll(
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  )) {
    let u = m[1];
    const um = u.match(/uddg=([^&]+)/);
    if (um) u = decodeURIComponent(um[1]);
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
    if (title && u) results.push({ title, url: u });
  }
  return { blocked: false, results, engine: 'ddg' };
}

async function bingSearch(query) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=10';
  const html = await fetchWithRetry(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en,es;q=0.8' },
  });

  const blocked = /captcha|unusual traffic|verify you are human/i.test(html);
  if (blocked) return { blocked: true, results: [], engine: 'bing' };

  const results = [];
  for (const m of html.matchAll(/<h2><a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const u = m[1];
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (title && u) results.push({ title, url: u });
  }
  return { blocked: false, results, engine: 'bing' };
}

function isJobLike(result) {
  const text = (result.title + ' ' + result.url).toLowerCase();
  const hasJob = KEYWORDS.some((k) => text.includes(k.toLowerCase()));
  const hasLoc = LOCATIONS.some((l) => text.includes(l.toLowerCase()));
  return hasJob && hasLoc;
}

async function searchPortal(p, args) {
  const keywords = KEYWORDS.slice(0, 3).join(' OR ');
  const locations = LOCATIONS.slice(0, 2).join(' OR ');
  const query = `site:${p.base} (${keywords}) (${locations})`;

  process.stdout.write(`  [${p.label.padEnd(16)}] `);

  let data;
  try {
    data = await ddgSearch(query);
  } catch (e) {
    console.log(`DDG ERROR ${String(e.message).slice(0, 30)} → probando Bing`);
    data = { blocked: false, results: [], engine: 'ddg' };
  }

  if (data.blocked || data.results.length === 0) {
    try {
      const b = await bingSearch(query);
      if (!b.blocked && b.results.length > 0) {
        data = b;
      } else if (data.blocked) {
        data = b;
      }
    } catch (e) {
      console.log(`BING ERROR ${String(e.message).slice(0, 30)}`);
    }
  }

  if (data.blocked) {
    console.log(`BLOCKED (${data.engine})`);
    return [];
  }

  const jobLike = data.results.filter(isJobLike).slice(0, args.maxResults);
  console.log(`${data.results.length} hits, ${jobLike.length} job-like (${data.engine})`);
  return jobLike.map((r) => ({ portal: p.label, ...r }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  console.log(`search-portals: ${portals.length} portals, delay=${args.delay}ms, max=${args.maxResults} results/portal`);

  const allResults = [];

  for (const p of portals) {
    try {
      const results = await searchPortal(p, args);
      allResults.push(...results);
    } catch (e) {
      console.log(`ERROR ${String(e.message).slice(0, 40)}`);
    }
    await sleep(args.delay);
  }

  const ts = new Date().toISOString().slice(0, 10);
  const outFile = join(args.out, `search-${ts}.md`);
  const lines = [
    `# Búsqueda de portales de empleo — ${ts}`,
    '',
    `Búsqueda vía DuckDuckGo + Bing sobre ${portals.length} portales.`,
    `Resultados tipo-empleo: ${allResults.length}.`,
    '',
    '## Resultados',
    '',
  ];
  if (allResults.length === 0) {
    lines.push('_No se encontraron resultados tipo-empleo en esta ejecución._');
    lines.push('');
    lines.push('**Nota:** Muchos portales bloquean el scraping de búsqueda web. Si ves 0 resultados,');
    lines.push('intenta acceder directamente a las páginas de carreras de las empresas');
    lines.push('con ATS verificado (Buffer, Deel, Automattic, Hubstaff, GitLab) o pega');
    lines.push('una URL de oferta en `automation/prepare-application.mjs <URL>`.');
  } else {
    for (const r of allResults) {
      lines.push(`- [${r.title}](${r.url}) — ${r.portal}`);
    }
  }
  lines.push('', '⚠ Este script solo enlaza ofertas. Nunca envía correos ni rellena formularios.');

  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`\nEscrito: ${outFile}`);
  console.log(`Resultados tipo-empleo: ${allResults.length}`);
}

main().catch((e) => {
  console.error('search-portals: error fatal', e);
  process.exit(1);
});
