// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * html-board.mjs — generic provider for server-rendered job boards with no
 * public JSON/ATS feed.
 *
 * Reads the board's listing page(s) via fetchText and extracts job links with
 * regex (no DOM parser — zero extra dependencies). Intended for boards that
 * expose a static HTML listing: InfoJobs, Domestika, Tecnoempleo, etc.
 *
 * Board owners change markup without notice; treat this as a best-effort
 * scraper, not a contract. If the board blocks bots (403/captcha), fetchText
 * throws and the entry is reported as `error` by verify-portals.mjs.
 *
 * Wire in via a `job_boards:` entry with `provider: html-board` plus:
 *   listing_url: https://.../jobs      (required — page with job links)
 *   base_url:    https://...           (required — origin for relative links)
 *   max_pages:   3                     (optional, default 1)
 *   page_param:  page                  (optional, default 'page')
 *
 * The entry name is used as fallback company when the source doesn't expose one.
 */

const JOB_URL_RE = /(^|[\/_-])(job|jobs|vacante|vacantes|empleo|empleos|oferta|ofertas|role|roles|position|positions|opening|openings|career|careers)[\/_-]/i;
const NOT_CHROME = /^(javascript|mailto|tel|#)/i;
const CHROME_TEXT = /^(home|inicio|about|sobre|contacto|contact|login|sign in|privacy|terms|cookie|blog|homepage|inicio)$/i;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJobLinks(html, origin) {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const out = new Map();
  for (const m of html.matchAll(/href="((?:https?:\/\/[^"]+|\/)[^"]*)"[^>]*>([^<]{6,160})</gi)) {
    let href = m[1];
    if (href.startsWith('/')) href = `https://${host}${href}`;
    try { new URL(href); } catch { continue; }
    const parsed = new URL(href);
    if (parsed.hostname.replace(/^www\./, '') !== host) continue;
    const path = parsed.pathname.replace(/\/+$/, '');
    const text = m[2].replace(/\s+/g, ' ').trim();
    const looksLikeJob = JOB_URL_RE.test(path);
    const notChrome = !NOT_CHROME.test(parsed.pathname) && text.length > 8 && !CHROME_TEXT.test(text.toLowerCase());
    if (looksLikeJob && notChrome) out.set(path, { title: text || path.split('/').pop(), url: href });
  }
  return [...out.values()];
}

function detectHtmlBoard(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider === 'html-board') return { url: entry.listing_url };
  if (entry.provider) return null;
  for (const value of [entry.listing_url, entry.careers_url]) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:') return { url: value };
    } catch { /* ignore */ }
  }
  return null;
}

function assertHtmlBoardUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`html-board: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`html-board: URL must use HTTPS: ${url}`);
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, 20);
  return 1;
}

/** @type {Provider} */
export default {
  id: 'html-board',

  detect: detectHtmlBoard,

  async fetch(entry, ctx) {
    const listingUrl = assertHtmlBoardUrl(entry.listing_url);
    const baseUrl = entry.base_url ? new URL(entry.base_url).origin : new URL(listingUrl).origin;
    const maxPages = resolveMaxPages(entry);
    const pageParam = entry.page_param || 'page';
    const fallbackCompany = typeof entry.name === 'string' ? entry.name.trim() : '';
    const out = [];

    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 ? listingUrl : `${listingUrl}${(listingUrl.includes('?') ? '&' : '?')}${pageParam}=${page}`;
      const html = await ctx.fetchText(url, { redirect: 'error' });
      if (!html || html.length < 500) break;
      const jobs = extractJobLinks(html, baseUrl);
      for (const j of jobs) {
        out.push({
          title: j.title,
          url: j.url,
          company: fallbackCompany,
          location: '',
        });
      }
    }
    return out;
  },
};
