/**
 * .shared/hooks/content-feed.mjs
 *
 * GUARD: a marketing blog's RSS feed is not a job feed.
 *
 * THE FAILURE THIS PREVENTS
 * The platform harvester classified a board as PROVIDER_WORTHY purely because
 * it served RSS. On inspection, focoempleo.com's 16 feed items were all
 * editorial articles ("Cómo los sistemas ATS eliminan tu CV antes de que lo
 * vea un humano") whose links resolved to `/blog/undefined/` — a broken CMS
 * template path. A provider written against that feed would read zero jobs
 * while looking like a wired, healthy source.
 *
 * The tell is in the URLs: `/blog/`, `/article/`, `/news/`, `/insights/`,
 * `/undefined`. Genuine posting feeds link to job-shaped paths.
 *
 * This hook also encodes the more general lesson as a reusable classifier,
 * `judgeFeed()`, so a harvester or a future provider can share one definition
 * of "is this a feed of jobs?" instead of each re-deciding it.
 *
 * Pure: no side effects, no CLI imports.
 */

import { EVENTS, ORDER, LEVEL, warn, ok } from "./contract.mjs"

export const id = "content-feed"
export const description = "Catch blog/marketing feeds misread as job feeds"
export const order = ORDER[EVENTS.AFTER_EXEC]

const CONTENT_PATH = /\/(blog|article|articles|news|insights|noticias|articulos|guia|guides|tips|opinion|entrevistas|webinar|cursos?)\//i
const BROKEN_PATH = /\/undefined\/|\/null\/|\/NaN\//i
const JOB_PATH = /(^|[\/_-])(job|jobs|vacante|vacantes|empleo|empleos|oferta|ofertas|role|roles|position|positions|opening|openings|posting|postings|career|careers)[\/_-]/i
const JOB_WORDS = /\b(vacante|vacantes|empleo|empleos|oferta|ofertas|we.?re hiring|we are hiring|seeking|hiring|open position|openings?|vacancy|vacancies|contratamos|buscamos|requerimos|postula)\b/i
const CONTENT_WORDS = /\b(blog|noticias|news|art[ií]culo|article|gu[ií]a|guide|consejos|tips|entrevista|entrevistas|webinar|capacitaci[oó]n|curso|cursos|opinión|opinion)\b/i

/** Tools whose output is feed/platform-probe evidence. */
const FEED_TOOLS = /harvest|probe|feed|rss|atom|discover|platform|board/i

/**
 * Judge whether a set of feed items represents job postings.
 *
 * @param {Array<{link?:string,title?:string}>} items
 * @returns {{verdict:"JOB_FEED"|"MIXED_FEED"|"CONTENT_FEED"|"EMPTY", ratio:number, jobish:number, sample:number}}
 */
export function judgeFeed(items) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { verdict: "EMPTY", ratio: 0, jobish: 0, sample: 0 }
  const sample = list.slice(0, 12)
  let jobish = 0
  for (const it of sample) {
    const link = String(it?.link ?? it?.url ?? "")
    const title = String(it?.title ?? "")
    const linkJob = JOB_PATH.test(link) && !BROKEN_PATH.test(link)
    const textJob = JOB_WORDS.test(title) && !CONTENT_WORDS.test(title)
    if (linkJob || textJob) jobish++
  }
  const ratio = jobish / sample.length
  const verdict = ratio >= 0.5 ? "JOB_FEED" : ratio >= 0.25 ? "MIXED_FEED" : "CONTENT_FEED"
  return { verdict, ratio, jobish, sample: sample.length }
}

/** Extract feed items from raw XML/Atom text (used by a harvester or a test). */
export function parseFeedItems(xml) {
  const s = String(xml || "")
  const out = []
  for (const m of s.matchAll(/<(item|entry)>([\s\S]*?)<\/\1>/g)) {
    const body = m[2]
    const link = ((body.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]
      || (body.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "").trim()
    const title = ((body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "").trim()
    if (link || title) out.push({ link, title })
  }
  return out
}

export function run(event, payload, ctx = {}) {
  if (event !== EVENTS.AFTER_EXEC) return null
  const tool = String(payload?.tool || "")
  if (!FEED_TOOLS.test(tool)) return null
  const output = typeof payload?.output === "string" ? payload.output : String(payload?.output ?? "")
  if (!output.trim()) return null

  const claimsProvider = /PROVIDER_WORTHY|provider[- ]worthy|\bRSS\b|rss\.xml|atom\.xml|feed found|items?\b/i.test(output)
  if (!claimsProvider) return null

  const hasContentPaths = CONTENT_PATH.test(output)
  const hasBrokenPaths = BROKEN_PATH.test(output)

  if (hasContentPaths || hasBrokenPaths) {
    return warn(id,
      `feed shape looks like CONTENT, not jobs.`,
      hasBrokenPaths ? `  It links to a broken CMS path (/undefined/, /null/, /NaN/) — that template renders no job records.` : `  Its links sit under /blog/, /article/ or /news/.`,
      `  Report this board as NO_FEED_FOUND, not PROVIDER_WORTHY — a content feed yields zero jobs`,
      `  while looking like a healthy wired source. Use judgeFeed() to classify it instead.`,
    )
  }
  return ok(id, `${tool}: feed output has job-shaped links and no content paths.`)
}

export default { id, description, order, run, judgeFeed, parseFeedItems }
