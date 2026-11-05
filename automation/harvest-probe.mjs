// Harvest probe — test whether a job board exposes a machine-readable feed.
//
// A board is worth a providers/*.mjs module only if its job list can be read
// over plain HTTP with no auth and no browser. This probes for the shapes
// career-ops providers already consume: RSS/Atom, JSON:API, Next.js
// __NEXT_DATA__ (server-rendered React), WordPress REST, and plain server-side
// HTML with real job links.
//
// Reads candidate URLs from argv[2], writes a markdown report to argv[3], and
// the list of already-configured hosts on stdin.

import { readFileSync, writeFileSync } from 'fs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 20000;

const configured = new Set(
  (process.argv[4] || '').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)
);

const strip = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  const body = await res.text();
  return { status: res.status, body, finalUrl: res.url };
}

const countItems = b => (b.match(/<item[\s>]/gi) || []).length || (b.match(/<entry[\s>]/gi) || []).length;

// A feed full of blog posts is NOT a job feed. focoempleo.com serves an RSS
// whose 16 items are all articles with broken `/blog/undefined/` links, and a
// naive "has RSS → PROVIDER_WORTHY" check recommends it. So inspect what the
// feed actually CONTAINS before judging it.
const JOB_URL = /(^|[\/_-])(job|jobs|vacante|vacantes|empleo|empleos|oferta|ofertas|role|roles|position|positions|opening|openings|posting|postings|career|careers)[\/_-]/i;
const JOB_WORDS = /\b(vacante|vacantes|empleo|empleos|oferta|ofertas|we.are.hiring|seeking|hiring|position|role|job|openings?|vacancy|vacancies|contratamos)\b/i;
const CONTENT_WORDS = /\b(blog|noticias|news|art[ií]culo|article|gu[ií]a|guide|consejos|tips|estrategia|opinion|entrevista|webinar|capacitaci[oó]n|curso)\b/i;

function inspectFeed(xml, baseUrl) {
  const items = [...xml.matchAll(/<(item|entry)>([\s\S]*?)<\/\1>/g)].map(m => m[2]);
  if (!items.length) return { verdict: 'EMPTY', sample: 0, jobish: 0 };
  const sample = items.slice(0, 12);
  let jobish = 0;
  for (const it of sample) {
    const link = ((it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || (it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '').trim();
    const title = ((it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const linkJob = JOB_URL.test(link) && !/\/blog\/undefined\//.test(link);
    const textJob = JOB_WORDS.test(title) && !CONTENT_WORDS.test(title);
    if (linkJob || textJob) jobish++;
  }
  const ratio = jobish / sample.length;
  const verdict = ratio >= 0.5 ? 'JOB_FEED' : ratio >= 0.25 ? 'MIXED_FEED' : 'CONTENT_FEED';
  return { verdict, sample: sample.length, jobish, ratio };
}

/** Job-ish anchors in server-rendered HTML. Filters out nav/category chrome. */
function jobLinks(html, origin) {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const out = new Set();
  for (const m of html.matchAll(/href="((?:https?:\/\/[^"]+|\/)[^"]*)"[^>]*>([^<]{6,120})</g)) {
    let href = m[1];
    if (href.startsWith('/')) href = `https://${host}${href}`;
    if (!href.includes(host)) continue;
    const p = href.replace(/[?#].*$/, '').replace(/\/$/, '');
    const text = m[2].replace(/\s+/g, ' ').trim();
    const looksLikeJob = /(^|[\/_-])(job|jobs|vacante|vacantes|role|roles|position|positions|empleo|empleos|opening|openings|career|careers)[\/_-]/i.test(p);
    const notChrome = !/^(javascript|mailto|tel|#)/i.test(p) && text.length > 8 && !/^(home|about|contact|login|sign in|privacy|terms|cookie|blog|homepage)$/i.test(text);
    if (looksLikeJob && notChrome) out.add(p);
  }
  return [...out];
}

async function probe(candidate) {
  const r = { url: candidate, host: '', verdict: 'UNKNOWN', signals: [], jobs: 0, note: '', alreadyConfigured: false };
  try { r.host = new URL(candidate).hostname.replace(/^www\./, ''); } catch { r.note = 'not a valid URL'; r.verdict = 'INVALID'; return r; }
  r.alreadyConfigured = [...configured].some(c => r.host === c || r.host.endsWith('.' + c));

  let page;
  try { page = await get(candidate); } catch (e) { r.verdict = 'UNREACHABLE'; r.note = e.message.slice(0, 60); return r; }
  if (page.status >= 400) { r.verdict = 'HTTP_ERROR'; r.note = `HTTP ${page.status}`; return r; }

  const html = page.body;
  r.signals.push(`html ${(html.length / 1024).toFixed(0)}KB`);
  if (/__NEXT_DATA__/.test(html)) r.signals.push('__NEXT_DATA__ (Next.js SSR)');
  if (/"@context"\s*:\s*"https?:\/\/json-ld|jsonapi/i.test(html)) r.signals.push('JSON:API marker');
  if (/wp-content|wp-json/i.test(html)) r.signals.push('WordPress');

  // 1. RSS / Atom at the conventional paths — and check it is a JOB feed,
  //    not a marketing blog (see inspectFeed).
  let feedItems = 0, feedVerdict = null, feedPath = null;
  for (const p of ['/feed/', '/rss', '/rss.xml', '/feed', '/atom.xml', '/index.xml', '/jobs/rss', '/rss/jobs']) {
    try {
      const f = await get(new URL(p, page.finalUrl).href);
      if (f.status !== 200 || !/<(rss|feed)[\s>]/i.test(f.body)) continue;
      const ins = inspectFeed(f.body, f.finalUrl);
      if (ins.verdict === 'EMPTY') continue;
      feedItems = countItems(f.body);
      feedVerdict = ins.verdict;
      feedPath = p;
      r.signals.push(`RSS ${p} (${feedItems} items, ${ins.verdict}: ${ins.jobish}/${ins.sample} job-like)`);
      break;
    } catch { /* candidate path absent — expected for most */ }
  }
  r.feedVerdict = feedVerdict;

  // 2. Server-rendered job links
  const links = jobLinks(html, page.finalUrl);
  if (links.length) r.signals.push(`${links.length} job links in HTML`);

  r.jobs = Math.max(feedItems, links.length);

  if (r.alreadyConfigured) r.verdict = 'ALREADY_WIRED';
  else if (feedVerdict === 'JOB_FEED') r.verdict = 'PROVIDER_WORTHY';
  else if (feedVerdict === 'MIXED_FEED') r.verdict = 'PROVIDER_WORTHY';
  else if (feedVerdict === 'CONTENT_FEED') {
    r.verdict = 'NO_FEED_FOUND';
    r.note = `has RSS at ${feedPath} but it is a BLOG/CONTENT feed, not postings — a provider would read no jobs from it`;
  }
  else if (/__NEXT_DATA__/.test(html) && links.length >= 3) r.verdict = 'PROVIDER_WORTHY';
  else if (links.length >= 3) r.verdict = 'SCRAPEABLE';
  else if (html.length < 3000) r.verdict = 'THIN_OR_JS_ONLY';
  else r.verdict = 'NO_FEED_FOUND';

  if (r.verdict === 'SCRAPEABLE') r.note = 'server-rendered links, no feed — a provider would need HTML parsing';
  if (r.verdict === 'THIN_OR_JS_ONLY') r.note = 'content is client-rendered; needs the browser tier, not an HTTP provider';
  return r;
}

const cands = readFileSync(process.argv[2], 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const results = [];
for (const c of cands) { results.push(await probe(c)); await new Promise(r => setTimeout(r, 1200)); }

const icon = { PROVIDER_WORTHY: '✅', SCRAPEABLE: '🟡', ALREADY_WIRED: 'ℹ️ ', NO_FEED_FOUND: '❌', THIN_OR_JS_ONLY: '⚠️ ', UNREACHABLE: '⚠️ ', HTTP_ERROR: '⚠️ ', INVALID: '⚠️ ' };

console.log('\n=== career-harvest: platform probe ===\n');
for (const r of results) {
  console.log(`${icon[r.verdict] || '? '} ${r.verdict.padEnd(18)} ${String(r.jobs).padStart(4)} jobs  ${r.host}`);
  console.log(`    signals: ${r.signals.join(' | ') || 'none'}`);
  if (r.note) console.log(`    note:    ${r.note}`);
}

const worthy = results.filter(r => r.verdict === 'PROVIDER_WORTHY');
const scrape = results.filter(r => r.verdict === 'SCRAPEABLE');

const md = [
  '# Platform harvest report', '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`career-harvest\`.`,
  'A board is **PROVIDER_WORTHY** when its job list is readable over plain HTTP',
  'with no auth and no browser — i.e. when a `providers/*.mjs` module could serve it',
  'at zero token cost, like every other source in `portals.yml`.', '',
  '| Verdict | Board | Jobs | Signals | Note |', '|---|---|---|---|---|',
  ...results.map(r => `| ${r.verdict} | ${r.url} | ${r.jobs} | ${r.signals.join('; ') || '—'} | ${r.note || '—'} |`),
  '',
  worthy.length ? `## Add a provider for\n\n${worthy.map(r => `- \`${r.host}\` — ${r.jobs} jobs reachable, ${r.signals.join(', ')}`).join('\n')}` : '## Add a provider for\n\n_None in this batch._',
  '',
  scrape.length ? `## Needs HTML parsing, no feed\n\n${scrape.map(r => `- \`${r.host}\` — ${r.jobs} job links but no RSS/JSON feed`).join('\n')}` : '',
].filter(Boolean).join('\n');

writeFileSync(process.argv[3], md + '\n');

const t = {};
for (const r of results) t[r.verdict] = (t[r.verdict] || 0) + 1;
console.log('\n--- summary ---');
console.log(JSON.stringify(t));
