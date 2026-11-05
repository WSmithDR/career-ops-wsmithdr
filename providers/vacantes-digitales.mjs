// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

// Vacantes Digitales provider — LatAm tech job board, free public REST API.
//
// WHY THIS BOARD MATTERS FOR A LATAM SEARCH
// vacantesdigitales.com advertises itself in its own JSON-LD as a "Free public
// REST API for tech job listings in Latin America… No authentication required",
// and the spec is published at /.well-known/openapi.yaml. That is the rarest
// combination in this directory: a regional board (not a global aggregator),
// zero auth, zero tokens, and a documented JSON contract.
//
// It is also an INDIRECT ROUTE TO LINKEDIN POSTS. Each record carries an
// `apply_url`, and for a large share of listings that field is a LinkedIn feed
// permalink (`linkedin.com/feed/update/urn:li:activity:…`) — i.e. the very
// "post, not structured posting" surface a Latam search actually depends on.
// LinkedIn publishes no API for those posts and scraping them violates their
// ToS, so the practical way to reach them is a board that indexes them. This
// provider surfaces them as ordinary postings, with the destination URL intact.
//
// API shape (verified 2026-09-26):
//   GET /api/list?page=N     → { data: Job[], pagination: { page, limit, total, pages } }
//   10 per page, total 1000 (100 pages) at time of writing.
//   Record: { id, title, slug, category, company: { name, slug, industry } | string,
//             location_type, address_locality, address_country, experience_level,
//             date_posted (ISO), valid_through, skills[], summary, content,
//             apply_url, url }
//
// Wire in via a `job_boards:` entry with `provider: vacantes-digitales`.
// Portal entry fields (all optional):
//   category     — restrict to one category slug (see /api/categories)
//   max_pages    — page cap; default 10 (=100 postings), hard cap 100
//
// Deliberate non-behaviours:
//   - `url` is the board's own permalink, NOT `apply_url`. scan.mjs dedups on
//     `url`, and keying on apply_url would collide across boards that repost the
//     same LinkedIn activity. apply_url is preserved on the record for triage.
//   - `description` is left unset. `content`/`content_html` exist but are large
//     and per-record; scan.mjs's content_filter needs them only for providers
//     that return them at list level for free, and pulling them would mean 10
//     extra requests per page. The scanner's title/location filters do the work.

const API_BASE = 'https://vacantesdigitales.com/api';
const TRUSTED_HOST = 'vacantesdigitales.com';
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 100;

/** @param {string} url */
function assertApiUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`vacantes-digitales: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`vacantes-digitales: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`vacantes-digitales: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** ISO date → epoch ms. NaN-safe: `|| undefined` would coerce a valid epoch 0. */
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** ISO 3166-1 alpha-2 → country name, for the location field. */
const COUNTRY_NAMES = {
  AR: 'Argentina', BO: 'Bolivia', BR: 'Brazil', CL: 'Chile', CO: 'Colombia',
  CR: 'Costa Rica', EC: 'Ecuador', GT: 'Guatemala', HN: 'Honduras', MX: 'Mexico',
  NI: 'Nicaragua', PA: 'Panama', PE: 'Peru', PR: 'Puerto Rico', PY: 'Paraguay',
  SV: 'El Salvador', US: 'United States', UY: 'Uruguay', VE: 'Venezuela',
};

/**
 * Build the location string. The board splits remote-ness (`location_type`) from
 * geography (`address_country` / `address_locality`), and both matter to the
 * scanner: `location_type` is what makes a LatAm remote posting legible to
 * `location_filter`, and the country is what `block_hard` matches on.
 */
export function buildLocation(rec) {
  const parts = [];
  const remote = /remote|remoto|remota/i.test(String(rec.location_type || ''));
  if (remote) parts.push('Remote');
  const country = COUNTRY_NAMES[String(rec.address_country || '').toUpperCase()]
    || (rec.address_country || '');
  const locality = rec.address_locality || '';
  if (locality) parts.push(locality);
  if (country) parts.push(country);
  // An explicit non-remote office designation is load-bearing for scoring, so
  // keep it rather than implying remote.
  if (!remote && rec.location_type) parts.push(String(rec.location_type));
  return parts.join(', ');
}

/** Company is an object on this API but a bare string on some older records. */
function companyName(rec) {
  if (typeof rec.company === 'string') return rec.company.trim();
  if (rec.company && typeof rec.company === 'object' && typeof rec.company.name === 'string') {
    return rec.company.name.trim();
  }
  return '';
}

/** Keep only absolute https board permalinks; the dedup key depends on this. */
function boardUrl(rec) {
  const raw = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase();
    if (host !== TRUSTED_HOST && !host.endsWith(`.${TRUSTED_HOST}`)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

/**
 * Normalize one API record into a Job.
 * Exported for the unit test; the malformed cases below are all real shapes
 * observed on the live feed, not invented.
 *
 * @param {any} rec
 * @returns {Job | null}
 */
export function normalize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  const url = boardUrl(rec);
  if (!title || !url) return null;

  /** @type {any} */
  const job = { title, url, company: companyName(rec), location: buildLocation(rec) };

  const postedAt = toEpochMs(rec.date_posted);
  if (postedAt !== undefined) job.postedAt = postedAt;

  // Category and seniority are free, list-level signals the scanner's title
  // filter cannot see, so carry them on the record for triage to use.
  if (rec.category) job.category = String(rec.category);
  if (rec.experience_level) job.experienceLevel = String(rec.experience_level);
  if (Array.isArray(rec.skills) && rec.skills.length) job.skills = rec.skills.slice(0, 12);
  // Preserved, not used as the dedup key — see the deliberate non-behaviours.
  if (typeof rec.apply_url === 'string' && /^https:\/\//.test(rec.apply_url.trim())) {
    job.applyUrl = rec.apply_url.trim();
  }
  return job;
}

/** @type {Provider} */
export default {
  id: 'vacantes-digitales',

  detect(entry) {
    if (entry?.provider && entry.provider !== 'vacantes-digitales') return null;
    const url = String(entry?.careers_url || entry?.api || '');
    if (!url) return null;
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
    return host === TRUSTED_HOST ? { url: `${API_BASE}/list?page=1` } : null;
  },

  async fetch(entry, ctx) {
    const maxPages = Math.min(
      Math.max(Number(entry?.max_pages) || DEFAULT_MAX_PAGES, 1),
      HARD_MAX_PAGES,
    );
    const category = typeof entry?.category === 'string' ? entry.category.trim() : '';

    const seen = new Set();
    /** @type {Job[]} */
    const out = [];
    let reportedPages = 0;

    for (let page = 1; page <= maxPages; page++) {
      const qs = new URLSearchParams({ page: String(page) });
      if (category) qs.set('category', category);
      const url = assertApiUrl(`${API_BASE}/list?${qs.toString()}`);

      // redirect:'error' blocks SSRF by server-side redirect; assertApiUrl keeps
      // the request pinned to the board's own host.
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) break;

      for (const rec of rows) {
        const job = normalize(rec);
        if (!job) continue;
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        out.push(job);
      }

      // Stop at the server's own page count rather than probing past the end.
      const total = Number(json?.pagination?.pages);
      if (Number.isFinite(total) && total > 0) {
        reportedPages = Math.min(total, maxPages);
        if (page >= reportedPages) break;
      }
    }

    return out;
  },
};
