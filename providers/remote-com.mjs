// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * remote-com.mjs — provider for Remote.com (remote.com).
 *
 * Remote.com does not expose a public ATS API or RSS feed. Its openings page
 * (https://remote.com/openings) links individual postings at
 * https://apply.remote.com/jobs/<uuid>. This provider fetches the openings
 * listing and extracts those UUID job URLs with regex (no DOM parser).
 *
 * Caveats:
 *   - Remote.com may serve a JS-rendered shell; if the HTML contains no
 *     apply.remote.com links, fetch returns [] and the entry is reported as
 *     empty by verify-portals.mjs.
 *   - Remote.com may block bots (403/captcha); then fetchText throws and the
 *     entry is reported as `error`.
 *
 * Wire in via a `job_boards:` entry with `provider: remote-com`:
 *   - name: Remote.com
 *     careers_url: https://remote.com/openings
 *     provider: remote-com
 *     enabled: true
 */

const LISTING_URL = 'https://remote.com/openings';
const TRUSTED_HOST = 'remote.com';
const JOB_URL_RE = /https:\/\/apply\.remote\.com\/jobs\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function detectRemoteCom(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.provider === 'remote-com') return { url: LISTING_URL };
  if (entry.provider) return null;
  for (const value of [entry.careers_url, entry.api]) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && parsed.hostname.replace(/^www\./, '') === TRUSTED_HOST) {
        return { url: LISTING_URL };
      }
    } catch { /* ignore */ }
  }
  return null;
}

function assertRemoteComUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`remote-com: invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') throw new Error(`remote-com: URL must use HTTPS: ${url}`);
  if (parsed.hostname.replace(/^www\./, '') !== TRUSTED_HOST) {
    throw new Error(`remote-com: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

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

/** @type {Provider} */
export default {
  id: 'remote-com',

  detect: detectRemoteCom,

  async fetch(entry, ctx) {
    assertRemoteComUrl(LISTING_URL);
    const html = await ctx.fetchText(LISTING_URL, { redirect: 'error' });
    if (!html || html.length < 500) return [];

    const text = htmlToText(html);
    const urls = new Set();
    for (const m of text.matchAll(JOB_URL_RE)) urls.add(m[0]);

    const out = [];
    for (const url of urls) {
      // Derive a title from the URL slug when present; otherwise unknown.
      const slug = url.split('/jobs/')[1] || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Remote.com position';
      out.push({ title, url, company: 'Remote.com', location: '' });
    }
    return out;
  },
};
