/**
 * .shared/hooks/portal-filters.mjs
 *
 * GUARD: a location filter that excludes the candidate's own region.
 *
 * THE FAILURE THIS PREVENTS
 * A first-pass `portals.yml` shipped a location_filter whose allow-list was
 * Remote / United States / USA / Europe, and whose block list named Brazil. For a
 * candidate in Ecuador seeking remote LatAm roles, that discarded exactly the
 * postings being searched for — and the scan still reported "0 errors", because
 * a filter working as written is indistinguishable from a filter working well.
 *
 * The scan's own counters are the tell: `Filtered by location: 566 removed`
 * alongside a healthy total looks like a working filter, not a misconfigured
 * one. This hook reviews the CONFIG rather than the result, because by the time
 * the counters are wrong the roles are already gone.
 *
 * It reads the candidate's own region from config/profile.yml when available, so
 * the rule generalises past a hardcoded LatAm list.
 *
 * Pure: no side effects, no CLI imports.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EVENTS, ORDER, LEVEL, warn, ok } from "./contract.mjs"

export const id = "portal-filters"
export const description = "Catch location filters that exclude the candidate's own region"
export const order = ORDER[EVENTS.BEFORE_WRITE]

/** Fallback region list when profile.yml carries no country. */
const FALLBACK = [
  "Ecuador", "Colombia", "Mexico", "México", "Argentina", "Chile", "Peru", "Perú",
  "Uruguay", "Paraguay", "Bolivia", "Costa Rica", "Panama", "Guatemala", "Honduras",
  "El Salvador", "Nicaragua", "Dominican", "Brazil", "Brasil", "LATAM", "Latam",
  "Latin America", "América Latina",
]

/** Countries whose "remote" postings are usually single-country traps. */
const REMOTE_TRAPS = new Set([
  "India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Philippines", "Indonesia",
  "Vietnam", "Thailand", "Nigeria", "Kenya", "Ghana", "Egypt", "Morocco", "Israel",
  "United Arab Emirates", "Saudi Arabia", "Singapore", "Hong Kong", "China", "Japan",
  "South Korea", "Australia", "New Zealand",
])

/** Read the candidate's country/city from config/profile.yml (best effort). */
export function candidateRegion(repoRoot) {
  const p = join(repoRoot, "config", "profile.yml")
  if (!existsSync(p)) return null
  try {
    const y = readFileSync(p, "utf8")
    const country = (y.match(/^\s*country:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1]?.trim()
    const city = (y.match(/^\s*city:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1]?.trim()
    const loc = (y.match(/^\s*location:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1]?.trim()
    return { country, city, location: loc }
  } catch { return null }
}

/**
 * Extract a YAML list under a given key, e.g. listUnder(yml, "block_hard").
 *
 * Hand-rolled rather than regex-based: the first attempt used `\Z` as an
 * end-of-string anchor, which is a Perl/Python construct — in JavaScript `\Z`
 * matches a literal "Z", so the function silently returned [] for every input.
 * Walking lines by indentation has no such portability trap.
 */
export function listUnder(yml, key) {
  const lines = String(yml || "").split("\n")
  const out = []
  let inSection = false
  let keyIndent = 0

  for (const line of lines) {
    if (!inSection) {
      const m = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s*(#.*)?$/)
      if (m && m[2] === key) {
        inSection = true
        keyIndent = m[1].length
      }
      continue
    }
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = (line.match(/^(\s*)/) || [""])[0].length
    if (indent <= keyIndent) break // dedented out of the key
    const item = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/)
    if (item) out.push(item[1].trim())
  }
  return out
}

/** Find which list a given line offset falls inside. */
function sectionAt(yml, index) {
  const before = yml.slice(0, index)
  const keys = [...before.matchAll(/^\s*(block_hard|block|allow|always_allow|positive|negative)\s*:/gm)]
  return keys.length ? keys[keys.length - 1][1] : null
}

export function run(event, payload, ctx = {}) {
  if (event !== EVENTS.BEFORE_WRITE) return null
  const filePath = String(payload?.filePath || "")
  if (!/portals\.ya?ml$/.test(filePath)) return null
  const content = payload?.content
  if (typeof content !== "string" || !content.trim()) return null

  const repoRoot = ctx.repoRoot || process.cwd()
  const region = candidateRegion(repoRoot)
  const home = new Set(
    [region?.country, region?.city, region?.location].filter(Boolean).map(s => String(s).trim())
  )
  // Also treat the whole fallback list as "candidate's region" when we have no
  // profile at all — better to over-flag than to silently pass a bad filter.
  const regionTerms = home.size ? home : new Set(FALLBACK)

  // A candidate whose country is itself in Latin America is searching a LatAm
  // market, so blocking a SIBLING LatAm country is a much stronger smell than
  // for anyone else. The original broken filter here blocked Brazil while the
  // candidate was in Ecuador — neither is his own country, so an exact-match
  // check missed it entirely.
  const inLatam = [...home].some(t => FALLBACK.includes(t))
  const latamSet = new Set(FALLBACK)

  const problems = []

  for (const m of content.matchAll(/^\s*-\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/gm)) {
    const term = m[1].trim()
    if (!term) continue
    const section = sectionAt(content, m.index)
    if (!section) continue
    const blocking = section === "block" || section === "block_hard"

    if (blocking && regionTerms.has(term)) {
      problems.push(
        `"${term}" is in '${section}' but it is the CANDIDATE'S OWN region — every matching posting will be discarded.`,
      )
    } else if (blocking && inLatam && latamSet.has(term)) {
      problems.push(
        `"${term}" is in '${section}'. The candidate is in ${[...home].join("/")}, so this blocks a SIBLING Latin American market — confirm that is intentional and not a copy-paste from another market's config.`,
      )
    }
    if (section === "allow" && REMOTE_TRAPS.has(term)) {
      problems.push(
        `"${term}" is in 'allow' but is a country-level "remote" trap — postings there are remote for residents only.`,
      )
    }
  }

  // An allow-list that names no remote-ish token AND no home region is suspect:
  // `location_filter` passes everything when `allow` is empty, so a non-empty
  // allow-list with no "remote" signal over-restricts the whole search.
  const allow = listUnder(content, "allow")
  const alwaysAllow = listUnder(content, "always_allow")
  if (allow.length && !alwaysAllow.length) {
    const hasRemote = [...allow, ...alwaysAllow].some(t => /remote|remot|worldwide|anywhere|global|distributed/i.test(t))
    if (!hasRemote) {
      problems.push(
        `location_filter.allow is non-empty with no remote-ish token and no always_allow — this rejects every posting whose location field is literally "Remote".`,
      )
    }
  }

  // NEW: for a LatAm candidate, an allow-list naming only US/EU metros and no
  // LatAm region silently rejects the local market even when "Remote" is listed
  // (because most LatAm postings are titled with a city, not the word "Remote").
  if (inLatam && allow.length) {
    const namesLatam = allow.some(t => latamSet.has(t))
    if (!namesLatam) {
      problems.push(
        `location_filter.allow names no Latin American region (${allow.slice(0, 6).join(", ")}). A LatAm-based candidate needs at least one, or every locally-posted role is filtered out.`,
      )
    }
  }

  if (problems.length) {
    return warn(id,
      `portals.yml location filter review — ${problems.length} issue(s):`,
      ...problems.map(p => `  • ${p}`),
      `  Re-check with: node audit-portals.mjs --summary   (then confirm the scan's "Filtered by location" count is plausible)`,
    )
  }
  return ok(id, "portals.yml location filter: no region-exclusion issues found.")
}

export default { id, description, order, run, listUnder, candidateRegion, FALLBACK, REMOTE_TRAPS }
