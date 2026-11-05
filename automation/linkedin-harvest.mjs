// linkedin-harvest.mjs — find LinkedIn POSTS via public web search engines.
//
// WHY THIS EXISTS
// Latam AI roles are announced as LinkedIn feed posts far more often than they
// are published as structured postings, and LinkedIn offers no public API for
// posts. Authenticated scraping violates their ToS and risks the account the
// candidate depends on. Web search is the only legitimate route.
//
// IMPORTANT, MEASURED CAVEAT
// Search-engine coverage of LinkedIn posts varies enormously by engine and by
// how aggressively you poll. During development:
//   - the agent's bundled search provider returned ZERO results for
//     site:linkedin.com/posts, and a control query for bare site:linkedin.com
//     returned only 2 company-page stubs → effectively no LinkedIn post index
//   - DuckDuckGo's HTML endpoint returned 9 real post permalinks for
//     site:linkedin.com/posts "AI Engineer", then began refusing further
//     requests (anomaly/challenge page) after roughly a dozen rapid queries
// So engines are tried in order with real backoff, and every run reports which
// engine produced what. A zero-result run is reported as INCONCLUSIVE, never
// as "no jobs exist".
//
// Usage: node linkedin-harvest.mjs [--engine all|ddg|bing] [--delay MS] [--out FILE]

import { writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"

const REPO = process.env.CAREER_OPS_REPO || process.cwd()
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }

const ENGINE = arg("--engine", "all")
const DELAY = Number(arg("--delay", "9000"))
const OUT = arg("--out", join(REPO, "data/linkedin-posts.md"))
const STATE = join(REPO, "data/linkedin-harvest-state.json")

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Queries are read from portals.yml so the search terms live in ONE place
// alongside every other scanner config, rather than being duplicated here.
function queriesFromPortals() {
  const p = join(REPO, "portals.yml")
  if (!existsSync(p)) return []
  const yml = readFileSync(p, "utf8")
  const out = []
  for (const m of yml.matchAll(/^\s*-\s*name:\s*(.+?)\s*\n\s*query:\s*['"](.+?)['"]\s*$/gm)) {
    const [, name, q] = m
    if (/linkedin/i.test(name) && /linkedin\.com/.test(q)) out.push({ name: name.replace(/^["']|["']$/g, ""), query: q })
  }
  return out
}

// ── engines ──────────────────────────────────────────────────────────────────

/** DuckDuckGo HTML endpoint. No key. Aggressive bot detection — needs big gaps. */
async function ddg(query) {
  const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    { headers: { "User-Agent": UA, "Accept-Language": "en,es;q=0.8" }, signal: AbortSignal.timeout(30000) })
  const h = await r.text()
  // Anomaly/challenge page masquerades as a zero-result page. Distinguish them,
  // because "blocked" and "genuinely nothing" demand different responses.
  const blocked = /anomaly|challenge|unusual traffic|blocked/i.test(h)
  const items = [...h.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  return {
    blocked,
    hits: items.map(m => {
      let u = m[1]
      const um = u.match(/uddg=([^&]+)/)
      if (um) u = decodeURIComponent(um[1])
      return { url: u, title: m[2].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim() }
    }),
  }
}

/** Bing HTML. Different index from DDG, so it is a genuine second source. */
async function bing(query) {
  const r = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=30",
    { headers: { "User-Agent": UA, "Accept-Language": "en,es;q=0.8" }, signal: AbortSignal.timeout(30000) })
  const h = await r.text()
  const blocked = /captcha|unusual traffic|verify you are human/i.test(h)
  const items = [...h.matchAll(/<h2><a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  return {
    blocked,
    hits: items.map(m => ({ url: m[1], title: m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() })),
  }
}

const ENGINES = { ddg, bing }

// ── filters ──────────────────────────────────────────────────────────────────

const isLinkedInPost = u => /(^|\.)linkedin\.com\/(posts|feed)\//i.test(u)

// "Remote, anywhere" and "DM me" are the two shapes a Latam post takes.
const NOISE = /pulse|article|newsletter|event|webinar| podcast|profile|company\/[a-z0-9_-]+\/?$/i
const SIGNAL = /\b(vacante|vacantes|empleo|empleos|oferta|ofertas|we.?re hiring|we are hiring|seeking|hiring|opening|open position|role|buscamos|requerimos|postula|aplic[aá]|remote|remoto|remota|contract|freelance|latam|ecuador|colombia|argentina|peru|m[eé]xico)\b/i

function classify(hit) {
  if (NOISE.test(hit.url) && !SIGNAL.test(hit.title)) return "MAYBE"
  if (SIGNAL.test(hit.title)) return "HIT"
  return "MAYBE"
}

// ── run ──────────────────────────────────────────────────────────────────────

const queries = queriesFromPortals()
if (!queries.length) {
  console.error("linkedin-harvest: no LinkedIn queries found in portals.yml search_queries")
  process.exit(1)
}
console.log(`linkedin-harvest: ${queries.length} LinkedIn queries from portals.yml`)
console.log(`linkedin-harvest: engine=${ENGINE} delay=${DELAY}ms\n`)

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { seen: {}, runs: 0 }
state.runs = (state.runs || 0) + 1
const fresh = []
const perEngine = {}
let blockedCount = 0
let queryCount = 0

const engineNames = ENGINE === "all" ? Object.keys(ENGINES) : [ENGINE]

for (const q of queries) {
  for (const en of engineNames) {
    const fn = ENGINES[en]
    if (!fn) { console.error(`unknown engine: ${en}`); process.exit(1) }
    queryCount++
    process.stdout.write(`  [${en}] ${q.name.slice(0, 52).padEnd(52)} `)
    try {
      const { blocked, hits } = await fn(q.query)
      if (blocked) {
        blockedCount++
        console.log("BLOCKED (anomaly/challenge — not a zero result)")
      } else {
        const posts = hits.filter(h => isLinkedInPost(h.url))
        perEngine[en] = (perEngine[en] || 0) + posts.length
        console.log(`${hits.length} hits, ${posts.length} linkedin posts`)
        for (const h of posts) {
          if (state.seen[h.url]) continue
          state.seen[h.url] = { firstSeen: new Date().toISOString().slice(0, 10), query: q.name, engine: en }
          fresh.push({ ...h, query: q.name, engine: en, grade: classify(h) })
        }
      }
    } catch (e) {
      console.log(`ERROR ${e.message.slice(0, 50)}`)
    }
    // One engine per delay tick: engines share nothing, but the point is to
    // stay well under any single engine's rate limit.
    await sleep(DELAY)
  }
}

writeFileSync(STATE, JSON.stringify(state, null, 2))

// Honest reporting: a run where every engine was blocked proves nothing about
// whether posts exist. Say so rather than writing an empty report that reads
// as "no openings".
const allBlocked = blockedCount === queryCount && queryCount > 0
const verdict = allBlocked ? "INCONCLUSIVE — every engine rate-limited this run"
  : blockedCount > 0 ? "PARTIAL — some engines rate-limited"
  : fresh.length ? "OK" : "NO_NEW_POSTS — engines answered, nothing unseen"

const lines = [
  "# LinkedIn posts harvest", "",
  `Run ${state.runs} — ${new Date().toISOString().slice(0, 10)}`, "",
  `**Verdict: ${verdict}**`, "",
  `- queries: ${queries.length} (read from portals.yml search_queries)`,
  `- engine requests: ${queryCount}, rate-limited: ${blockedCount}`,
  `- LinkedIn post hits: ${Object.entries(perEngine).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
  `- new since last run: ${fresh.length}`, "",
  "> LinkedIn has no public API for posts. This is web-search discovery only.",
  "> Engines rate-limit aggressively; a blocked request is NOT evidence of no openings.", "",
]
if (allBlocked) {
  lines.push("## Nothing collected — every engine refused", "",
    "Raise `--delay` (try 20000+) or add a keyed search API (Brave, Serper, Google CSE).",
    "A keyed engine is the only reliable option for a cron-driven harvester.", "")
} else if (fresh.length) {
  const hits = fresh.filter(f => f.grade === "HIT")
  const maybes = fresh.filter(f => f.grade === "MAYBE")
  lines.push("## Strong signal", "")
  hits.forEach(f => lines.push(`- **${f.title}** — _${f.query}_ (${f.engine})\n  ${f.url}`))
  lines.push("", "## Possible — verify before spending time", "")
  maybes.forEach(f => lines.push(`- ${f.title} — _${f.query}_ (${f.engine})\n  ${f.url}`))
  lines.push("")
} else {
  lines.push("## Nothing new", "", "All engines answered; every post URL was already collected.", "")
}

writeFileSync(OUT, lines.join("\n"))
// Machine-readable sidecar, so a later stage can consume hits without parsing prose.
if (fresh.length) {
  appendFileSync(join(REPO, "data/linkedin-posts.jsonl"),
    fresh.map(f => JSON.stringify({ ...f, seen: new Date().toISOString() })).join("\n") + "\n")
}

console.log(`\nverdict: ${verdict}`)
console.log(`new: ${fresh.length} (${fresh.filter(f => f.grade === "HIT").length} strong signal)`)
console.log(`wrote: ${OUT}`)
if (allBlocked) process.exit(2)
