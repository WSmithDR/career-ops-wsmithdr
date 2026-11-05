/**
 * .shared/hooks/model-select.mjs
 *
 * CHOOSE MODELS BY COST, NOT BY NAME.
 *
 * THE PROBLEM THIS SOLVES
 * OpenCode Zen's free-tier models do not share a naming convention:
 *
 *   opencode/big-pickle                        ← free, but says nothing
 *   opencode/space-bunny-free                  ← free, says "free"
 *   opencode/ling-3.0-flash-fin-free           ← free, says "free"
 *
 * So a `/free` in the model id is a coincidence, not a contract, and any policy
 * built on it silently excludes `big-pickle` while trusting a name that a paid
 * model could equally carry. The AUTHORITATIVE signal is the numeric `cost`
 * block in the model registry: a model is free when every component is 0.
 *
 * TWO COST SHAPES EXIST, and both are in play:
 *   { input, output, cache: { read, write } }   ← `opencode models --verbose`
 *   { input, output, cache_read }               ← ~/.cache/opencode/models.json
 *                                              (models.dev format)
 * Reading only one of them would mark half the catalogue wrong, so both are
 * handled and any UNRECOGNISED shape is treated as "cost unknown" → NOT free.
 * Failing closed matters here: assuming a paid model is free spends the user's
 * money, while assuming a free model is paid only picks a different model.
 *
 * Pure: takes a registry, returns decisions. No filesystem, no network, no CLI.
 */

import { EVENTS, ORDER } from "./contract.mjs"

export const id = "model-select"
export const description = "Pick models by measured cost, never by name convention"
export const order = ORDER[EVENTS.BUILD_ENV] + 5

/** Free Zen models are exactly zero on every priced component. */
export function isFree(model) {
  if (!model || typeof model !== "object") return false
  const c = model.cost
  if (c == null) return false

  // Shape A: nested cache
  if (c.cache && typeof c.cache === "object") {
    const parts = [c.input, c.output, c.cache?.read, c.cache?.write]
    if (parts.some(p => typeof p !== "number")) return false
    return parts.every(p => p === 0)
  }
  // Shape B: flat cache_read (models.dev). cache_write is optional.
  const parts = [c.input, c.output, c.cache_read, c.cache_write].filter(p => p !== undefined)
  if (!parts.length) return false
  if (parts.some(p => typeof p !== "number")) return false
  return parts.every(p => p === 0)
}

/** Cheapest non-zero component — for surfacing "this one costs money". */
export function costOf(model) {
  const c = model?.cost
  if (!c) return null
  const nums = [
    c.input, c.output,
    c.cache?.read, c.cache?.write,
    c.cache_read, c.cache_write,
  ].filter(n => typeof n === "number")
  return nums.length ? Math.max(...nums) : null
}

/**
 * Flatten a models.dev / opencode registry into `[{ provider, id, model }]`.
 * Accepts either shape: `{ providerId: { models: {...} } }` or
 * `{ providerId: { modelId: {...} } }`.
 */
export function flatten(registry, { providerPrefix } = {}) {
  const out = []
  if (!registry || typeof registry !== "object") return out
  for (const [providerId, value] of Object.entries(registry)) {
    if (providerPrefix && !providerId.startsWith(providerPrefix)) continue
    const models = (value && typeof value === "object" && value.models && typeof value.models === "object")
      ? value.models
      : (value && typeof value === "object" ? value : {})
    for (const [id, model] of Object.entries(models)) {
      if (!model || typeof model !== "object") continue
      if (model.id === undefined && !model.cost && !model.limit) continue // provider metadata, not a model
      out.push({
        provider: providerId,
        id: model.id || id,
        key: `${providerId}/${model.id || id}`,
        name: model.name || id,
        model,
      })
    }
  }
  return out
}

/**
 * Score a candidate against task requirements. Higher is better.
 * Exported separately so the weighting is inspectable and testable.
 */
export function score(entry, req = {}) {
  const m = entry.model || {}
  const cap = m.capabilities
  const ctx = m.limit?.context ?? 0
  const outTok = m.limit?.output ?? 0
  const reasoning = cap?.reasoning ?? m.reasoning ?? false
  const toolcall = cap?.toolcall ?? m.tool_call ?? false

  if (req.requireReasoning && !reasoning) return -1
  if (req.requireToolCalls && !toolcall) return -1
  if (req.minContext && ctx < req.minContext) return -1
  if (req.minOutput && outTok < req.minOutput) return -1

  // Normalised capability score, so a 1M-context model outranks a 200K one for
  // whole-repo work while a small-context model can still win when speed matters.
  let s = Math.log10(ctx + 10) * 10
  s += Math.log10(outTok + 10) * 4
  if (reasoning) s += 8
  if (toolcall) s += 4
  // Prefer flash/large-output models only as a tiebreak; never override context.
  if (req.preferFast && /flash|lightning|mimo|mini/i.test(entry.id)) s += 6
  return s
}

/**
 * Choose the best model satisfying `req`, restricted to free ones.
 *
 * @param {object} registry
 * @param {{providerPrefix?:string, requireReasoning?:boolean, requireToolCalls?:boolean,
 *          minContext?:number, minOutput?:number, preferFast?:boolean}} req
 * @returns {{best:object|null, free:object[], ranked:object[], paid:object[]}}
 */
export function pick(registry, req = {}) {
  const all = flatten(registry, req)
  const free = all.filter(e => isFree(e.model))
  const paid = all.filter(e => !isFree(e.model))

  const ranked = free
    .map(e => ({ ...e, score: score(e, req) }))
    .filter(e => e.score >= 0)
    .sort((a, b) => b.score - a.score)

  return { best: ranked[0] || null, free, ranked, paid }
}

/** Recommend a small/fast free model for background work (triage, summaries). */
export function pickSmall(registry, req = {}) {
  const r = pick(registry, { requireToolCalls: true, preferFast: true, ...req })
  if (r.best) return r
  return pick(registry, { preferFast: true, ...req })
}

export function run() { return null } // consumed directly by adapters, not event-driven

export default { id, description, order, isFree, costOf, flatten, score, pick, pickSmall, run }
