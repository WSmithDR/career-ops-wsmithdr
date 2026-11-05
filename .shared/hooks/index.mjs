/**
 * .shared/hooks/index.mjs — hook registry and shared runner.
 *
 * This is the only thing a CLI adapter needs to import. An adapter translates
 * its own events into normalized calls and delegates everything else here, so
 * adding a hook is a one-line change in this file plus a new module — no edits
 * in any adapter.
 *
 * ── Adding a CLI adapter ────────────────────────────────────────────────────
 *   import { createRunner } from "<repo>/.shared/hooks/index.mjs"
 *   const runner = createRunner({ repoRoot: process.cwd() })
 *
 *   // before writing a file:
 *   const r = runner.beforeWrite({ filePath, content })
 *   if (r.blocked) throw new Error(r.messages.join("\n"))
 *   if (r.messages.length) console.error(r.messages.join("\n"))
 *
 *   // after a command:
 *   runner.afterExec({ tool, output, args })
 *
 *   // system prompt assembly:
 *   const extra = runner.systemText({ cwd, systemText })
 *
 * `strict` decides whether a `block` result actually blocks. Default false: a
 * guard that silently refuses work is worse than a visible wrong answer.
 */

import { EVENTS, ORDER, LEVEL } from "./contract.mjs"
import jdGrounding from "./jd-grounding.mjs"
import livenessEvidence from "./liveness-evidence.mjs"
import contentFeed from "./content-feed.mjs"
import portalFilters from "./portal-filters.mjs"
import evidenceRules from "./evidence-rules.mjs"
import runtimeEnv from "./runtime-env.mjs"

export { EVENTS, ORDER, LEVEL } from "./contract.mjs"
export * from "./contract.mjs"

/** The registry. Order is stable so output is deterministic run to run. */
export const HOOKS = [
  jdGrounding,
  portalFilters,
  livenessEvidence,
  contentFeed,
  runtimeEnv,
  evidenceRules,
].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

export const hookIds = () => HOOKS.map(h => h.id)

/**
 * Run every hook for an event.
 * @returns {Array<{id:string, level:string, messages:string[]}>}
 */
export function runHooks(event, payload, ctx = {}) {
  const out = []
  for (const h of HOOKS) {
    let res
    try {
      res = h.run?.(event, payload, ctx)
    } catch (e) {
      // A crashing guard must never take down the session.
      out.push({ id: h.id, level: LEVEL.WARN, messages: [`hook ${h.id} threw: ${e?.message || e}`] })
      continue
    }
    if (!res) continue
    if (typeof res === "string") {
      out.push({ id: h.id, level: LEVEL.OK, code: h.id, messages: [res] })
      continue
    }
    out.push({
      id: h.id,
      // `level` MUST be carried through. An earlier version wrote
      // `id: res.level ?? h.id` here, so every result arrived with `level`
      // undefined and `.warn` was permanently false — the guards fired, printed
      // their messages, and still reported "nothing to see".
      level: res.level ?? LEVEL.WARN,
      code: res.code ?? h.id,
      messages: res.messages ?? [],
    })
  }
  return out
}

/**
 * Create a runner bound to a repo root and strictness.
 * Adapters should use this rather than calling runHooks directly.
 */
export function createRunner({ repoRoot = process.cwd(), strict = process.env.CAREER_OPS_STRICT === "1" } = {}) {
  const ctx = { repoRoot, strict }

  const collect = (event, payload) => {
    const results = runHooks(event, payload, ctx)
    // ok-level results are informational only — surfaced under verbose.
    const notable = results.filter(r => r.level !== LEVEL.OK || process.env.CAREER_OPS_VERBOSE === "1")
    return {
      results,
      blocked: strict && results.some(r => r.level === LEVEL.BLOCK),
      messages: notable.flatMap(r => r.messages),
      warn: notable.some(r => r.level === LEVEL.WARN),
    }
  }

  return {
    ctx,
    /** @param {{filePath:string, content?:string, operation?:string}} payload */
    beforeWrite: (payload) => collect(EVENTS.BEFORE_WRITE, payload),
    /** @param {{tool:string, output:string, args?:any}} payload */
    afterExec: (payload) => collect(EVENTS.AFTER_EXEC, payload),
    /** @returns {string[]} extra system-prompt lines to append */
    systemText: (payload) =>
      runHooks(EVENTS.BUILD_SYSTEM, payload, ctx)
        .map(r => (typeof r === "string" ? r : r.messages?.join("\n") || ""))
        .filter(Boolean),
    /**
     * @returns {Record<string,string>} env vars to merge into the child env.
     * BUILD_ENV hooks return [{key,value}] rather than message results, so they
     * are dispatched directly rather than through collect().
     */
    envAdditions: (payload) => {
      const out = {}
      for (const h of HOOKS) {
        let res
        try { res = h.run?.(EVENTS.BUILD_ENV, payload, ctx) } catch { continue }
        if (!res) continue
        const pairs = Array.isArray(res) ? res : [res]
        for (const p of pairs) {
          if (p && typeof p.key === "string" && typeof p.value === "string") out[p.key] = p.value
        }
      }
      return out
    },
  }
}

export default { HOOKS, hookIds, runHooks, createRunner, EVENTS, ORDER, LEVEL }
