/**
 * .shared/hooks/liveness-evidence.mjs
 *
 * GUARD: an HTTP 200 is not proof a job posting is open.
 *
 * THE FAILURE THIS PREVENTS
 * Postings were reported as "verified" on the strength of a bare HTTP 200. Job
 * boards overwhelmingly serve soft-404 shells — a page with nav, footer and an
 * "Apply" string, but no role and no description — under a 200 status. A 200
 * therefore proves the server answered, not that the vacancy exists.
 *
 * The repo already encodes the correct distinction in its own liveness gate
 * (`check-liveness.mjs`), which classifies postings as active / expired /
 * uncertain from RENDERED content. This hook makes that evidence tier visible in
 * the transcript, so a later reader can see how strong the evidence actually was
 * instead of taking "verified" on faith.
 *
 * Tiers, strongest first:
 *   browser — content was rendered (check-liveness output, Playwright, a snapshot)
 *   http    — only a status code was observed
 *   unknown — no usable evidence either way
 *
 * Pure: no side effects, no CLI imports.
 */

import { EVENTS, ORDER, LEVEL, warn, ok } from "./contract.mjs"

export const id = "liveness-evidence"
export const description = "Require rendered-content evidence before calling a posting live"
export const order = ORDER[EVENTS.AFTER_EXEC]

const BROWSER = /check-liveness|browser-extract|browser_navigate|browser_snapshot|playwright|chromium|browserType|\bactive\b|\bexpired\b|\buncertain\b/i
const HTTP_OK = /\b(200|201|204)\b|HTTP\/[12](\.\d)?\s+\d{3}/
const DEAD = /\b(404|410|451)\b|not found|no such page|page not found|no longer (accepting|available|active|open)|(this (job|position|posting|vacancy|oferta) (is|has been) (closed|expired|filled|closed))|applications? (are|have) (closed|not being accepted)|esta (oferta|vacante) (ya )?no (está|esta) disponible/i

/** Tools whose output is evidence about a posting's liveness. */
const EVIDENCE_TOOLS = /check-liveness|curl|wget|http|fetch|webfetch|browser-extract|navigate|snapshot|playwright|scrape|harvest|extract/i

/**
 * Classify the evidence tier of a tool output string.
 * @returns {"browser"|"http"|"unknown"}
 */
export function classify(output) {
  const s = String(output || "")
  if (BROWSER.test(s)) return "browser"
  if (HTTP_OK.test(s)) return "http"
  return "unknown"
}

export function run(event, payload, ctx = {}) {
  if (event !== EVENTS.AFTER_EXEC) return null
  const tool = String(payload?.tool || "")
  if (!EVIDENCE_TOOLS.test(tool)) return null
  const output = typeof payload?.output === "string" ? payload.output : String(payload?.output ?? "")

  if (DEAD.test(output)) {
    return warn(id,
      `${tool}: response carries a DEAD signal (404/410/"no longer accepting"/closure banner).`,
      `  Do NOT report this posting as live. Confirm the URL, then re-check.`,
    )
  }

  const tier = classify(output)
  if (tier === "http") {
    return warn(id,
      `${tool}: evidence is HTTP-STATUS ONLY.`,
      `  A 200 does not prove a posting is open — job boards serve soft-404 shells with a 200 status.`,
      `  Before calling this "verified", render it: node check-liveness.mjs <url>`,
    )
  }
  if (tier === "browser") {
    return ok(id, `${tool}: browser-tier evidence present (rendered content).`)
  }
  return null
}

export default { id, description, order, run, classify }
