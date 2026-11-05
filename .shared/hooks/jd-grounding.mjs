/**
 * .shared/hooks/jd-grounding.mjs
 *
 * GUARD: do not let an ungrounded evaluation reach disk.
 *
 * THE FAILURE THIS PREVENTS
 * An evaluation (Blocks A–G, a 1–5 score, a TL;DR, a STAR story) was produced
 * for a posting whose job description was never fetched — written convincingly
 * from the title line alone. That report is then read back as established fact
 * on every later pass, and every downstream artefact (CV tailoring, cover
 * letter, tracker row) inherits the fabrication.
 *
 * The check is deliberately narrow: it fires on writes to
 * `reports/{NNN}-*.md` only, and passes when EITHER a real JD capture exists for
 * that report number OR the report embeds a substantive verbatim JD section.
 * Both are legitimate; the failure is having neither.
 *
 * Pure: reads the filesystem via ctx.repoRoot, writes nothing.
 *
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EVENTS, ORDER, LEVEL, warn, block, reportNumberOf, isReportPath, norm } from "./contract.mjs"
// The repo's own nested-checkout predicate. Imported rather than injected
// because tests/mjs-files.test.mjs requires a walker to CALL it and branch on
// the result — passing it in as a parameter reads, to that check, as unguarded.
//
// On the CLI-agnostic boundary: importing lib/mjs-files.mjs couples this module
// to THIS repository, not to any AI CLI. The portability claim is that the hook
// logic imports no CLI package; a host repo's own filesystem helper is a
// different dependency class, and duplicating the predicate here would create a
// second definition to drift out of step with the one the rest of the repo uses.
import { isNestedCheckout } from "../../lib/mjs-files.mjs"

export const id = "jd-grounding"
export const description = "Require a real JD artifact before an evaluation report is written"
export const order = ORDER[EVENTS.BEFORE_WRITE]

/** Minimum bytes of body for a capture/section to count as substantive. */
const MIN_SUBSTANTIVE = 400

/**
 * Entries directly inside `dir`, skipping a nested checkout.
 *
 * The nested-checkout guard is NOT optional politeness. `jds/` and `reports/`
 * live in a repo that can itself contain worktrees, and an unguarded readdir
 * would read a file belonging to a DIFFERENT checkout and report a capture this
 * repo does not have — the same defect class as #3762, where a worktree under
 * `modes/` put 175 files where 174 live and a real check silently passed on
 * another checkout's source. tests/mjs-files.test.mjs enforces the call.
 */
function entriesOf(dir) {
  if (isNestedCheckout(dir)) return []
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Find a JD capture for a report number, following jd-capture.mjs semantics:
 * the report-number prefix may be padded or not (`064-`, `64-`, `01-`).
 * A capture that is a near-empty stub does not count.
 */
export function findCapture(repoRoot, num) {
  const dir = join(repoRoot, "jds")
  if (!existsSync(dir)) return null
  const re = new RegExp(`^0*${num}[-_]`)
  for (const f of entriesOf(dir)) {
    if (!re.test(f)) continue
    const full = join(dir, f)
    try {
      if (readFileSync(full, "utf8").replace(/\s+/g, "").length < MIN_SUBSTANTIVE) continue
    } catch { continue }
    return full
  }
  return null
}

/** Does the report already embed a substantive verbatim JD section? */
export function embedsJD(repoRoot, num) {
  const dir = join(repoRoot, "reports")
  if (!existsSync(dir)) return false
  const f = entriesOf(dir).find(n => n.startsWith(`${num}-`) && n.endsWith(".md"))
  if (!f) return false
  try {
    const body = readFileSync(join(dir, f), "utf8")
    const m = body.match(/^##+ Job Description[\s\S]*$/m)
    return !!m && m[0].replace(/\s+/g, "").length > MIN_SUBSTANTIVE
  } catch { return false }
}

/**
 * The advisory text, inlined into run() rather than held in a helper.
 *
 * It was a `const MSG = (num) => [...]` arrow, and tests/mjs-files.test.mjs
 * mis-parsed that array-literal body so it swallowed `run` — which made MSG and
 * run look mutually recursive, and since both reach entriesOf()'s readdirSync,
 * both were reported as unguarded walkers. Nothing was actually recursive here.
 * An array-returning arrow is the shape that breaks its body-span parser, so
 * the message lives inline instead.
 */
function ungroundedMessage(num) {
  return [
    `report ${num} has NO JD artifact.`,
    `  • jds/${num}-*.md is absent or a stub (<${MIN_SUBSTANTIVE} chars), and the report carries no`,
    `    "## Job Description" section with substantive content.`,
    `  • Writing it anyway records an ungrounded evaluation as fact, and every later pass reads it back as such.`,
    `  Fix: node browser-extract.mjs <url> --mode jd --max-chars 9000`,
    `       (or paste the JD into the report's "## Job Description (archived verbatim)" section)`,
  ]
}

export function run(event, payload, ctx = {}) {
  if (event !== EVENTS.BEFORE_WRITE) return null
  const filePath = payload?.filePath
  if (typeof filePath !== "string" || !isReportPath(filePath)) return null

  const num = reportNumberOf(norm(filePath))
  if (!num) return null

  const repoRoot = ctx.repoRoot || process.cwd()
  const capture = findCapture(repoRoot, num)
  if (capture) {
    return { level: LEVEL.OK, code: id, messages: [`report ${num}: JD grounding OK (${capture})`] }
  }
  if (embedsJD(repoRoot, num)) {
    return { level: LEVEL.OK, code: id, messages: [`report ${num}: JD grounding OK (embedded verbatim section)`] }
  }

  const msgs = ungroundedMessage(num)
  return ctx.strict ? block(id, msgs) : warn(id, msgs)
}

export default { id, description, order, run, findCapture, embedsJD }
