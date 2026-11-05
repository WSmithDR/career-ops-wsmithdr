/**
 * model-select tests — run against the REAL opencode registry on disk.
 *
 * The point of these is the name-vs-cost distinction: a policy built on
 * `/free` in the model id would exclude `big-pickle`, which is in fact free.
 *
 * Run: node .shared/hooks/test-model-select.mjs
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isFree, costOf, flatten, score, pick, pickSmall } from "./model-select.mjs"

const REG = join(homedir(), ".cache/opencode/models.json")
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log(`  ok    ${l}`) } else { fail++; console.log(`  FAIL  ${l}`) } }
const section = s => console.log(`\n${s}`)

// ── synthetic: both cost shapes, and a name that lies ────────────────────────
section("1. cost shapes and lying names")
{
  ok(isFree({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }), "nested-cache all-zero is free")
  ok(isFree({ cost: { input: 0, output: 0, cache_read: 0 } }), "flat cache_read all-zero is free")
  ok(!isFree({ cost: { input: 0.5, output: 0, cache: { read: 0, write: 0 } } }), "any non-zero input is not free")
  ok(!isFree({ cost: { input: 0, output: 0, cache_read: 0, cache_write: 0.1 } }), "cache_write counts")
  ok(!isFree({ cost: { input: 0, output: 0, cache: { read: 0.02, write: 0 } } }), "nested cache.read counts")

  // The whole reason this module exists:
  ok(isFree({ id: "big-pickle", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
     "'big-pickle' is free despite no 'free' in the name")
  ok(!isFree({ id: "some-enterprise-model-free", cost: { input: 3, output: 15, cache: { read: 0, write: 0 } } }),
     "a model NAMED 'free' but priced is not free")

  // Fail closed on shapes we do not understand.
  ok(!isFree({ cost: "free" }), "string cost is not trusted")
  ok(!isFree({}), "absent cost is not free")
  ok(!isFree(null), "null model is not free")
  ok(costOf({ cost: { input: 1, output: 9, cache_read: 0 } }) === 9, "costOf reports the max component")
  ok(costOf({}) === null, "costOf null when unknown")
}

// ── registry parsing ─────────────────────────────────────────────────────────
section("2. registry parsing")
{
  const reg = {
    opencode: { models: {
      alpha: { id: "alpha", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 100000, output: 8000 }, capabilities: { reasoning: false, toolcall: true } },
      beta:  { id: "beta",  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 1000000, output: 131072 }, capabilities: { reasoning: true, toolcall: true } },
      gamma: { id: "gamma", cost: { input: 2, output: 8, cache: { read: 0, write: 0 } }, limit: { context: 2000000, output: 200000 }, capabilities: { reasoning: true, toolcall: true } },
    } },
    other: { models: { delta: { id: "delta", cost: { input: 0, output: 0, cache_read: 0 }, limit: { context: 500000, output: 50000 }, capabilities: { reasoning: true, toolcall: true } } } },
  }
  const all = flatten(reg)
  ok(all.length === 4, `flatten finds 4 models (got ${all.length})`)
  const zen = flatten(reg, { providerPrefix: "opencode" })
  ok(zen.length === 3, "providerPrefix filters")

  const r = pick(reg, { providerPrefix: "opencode" })
  ok(r.free.length === 2 && r.paid.length === 1, "2 free, 1 paid under the opencode prefix")
  ok(r.best?.id === "beta", "beta (1M ctx, reasoning) beats alpha")
  ok(r.paid[0].id === "gamma", "the expensive model is identified, not chosen")

  // A huge paid model must never win just because it is huge.
  ok(r.best?.id !== "gamma", "a 2M-context PAID model is not selected")
}

// ── requirement filtering ────────────────────────────────────────────────────
section("3. requirement filtering")
{
  const reg = { p: { models: {
    small: { id: "small", cost: { input: 0, output: 0, cache_read: 0 }, limit: { context: 80000, output: 4000 }, capabilities: { reasoning: false, toolcall: true } },
    big:   { id: "big",   cost: { input: 0, output: 0, cache_read: 0 }, limit: { context: 200000, output: 16000 }, capabilities: { reasoning: false, toolcall: true } },
  } } }
  ok(pick(reg, { minContext: 150000 }).best?.id === "big", "minContext excludes the small model")
  ok(pick(reg, { minContext: 900000 }).best === null, "unsatisfiable minContext returns null, not a wrong pick")
  ok(pick(reg, { requireReasoning: true }).best === null, "requireReasoning with no candidate returns null")
  ok(score({ id: "x", model: { limit: { context: 1000 }, capabilities: {} } }, { requireToolCalls: true }) === -1,
     "missing toolcall capability scores -1")
}

// ── the real registry ────────────────────────────────────────────────────────
if (existsSync(REG)) {
  section("4. real opencode registry")
  const reg = JSON.parse(readFileSync(REG, "utf8"))
  const zen = pick(reg, { providerPrefix: "opencode", requireToolCalls: true })

  ok(zen.free.length > 0, `${zen.free.length} free models in the opencode provider`)
  ok(zen.best !== null, `best free model resolved: ${zen.best?.key}`)
  ok(zen.best ? isFree(zen.best.model) : false, "the chosen model is verifiably free")

  // Every free model must have an all-zero cost, and no priced one may be free.
  ok(zen.free.every(e => isFree(e.model)), "every 'free' entry really is zero-cost")
  ok(zen.paid.every(e => !isFree(e.model)), "no priced entry is mislabelled free")

  // The name-based heuristic this replaces, measured on real data.
  const named = zen.free.filter(e => /free/i.test(e.id)).length
  ok(named < zen.free.length,
     `name heuristic misses ${zen.free.length - named} free model(s) that cost says are free`)

  const small = pickSmall(reg, { providerPrefix: "opencode" })
  ok(small.best !== null, `small/fast free model for background work: ${small.best?.key}`)

  const deep = pick(reg, { providerPrefix: "opencode", requireReasoning: true, minContext: 500000 })
  ok(deep.best !== null, `deep free reasoning model (>=500K ctx): ${deep.best?.key}`)
  ok(deep.best ? isFree(deep.best.model) : false, "deep pick is also free")

  // Paid models DO exist elsewhere in the registry — proof the filter is live.
  const anyPaid = flatten(reg).filter(e => !isFree(e.model))
  ok(anyPaid.length > 0, `${anyPaid.length} paid models exist in the full registry (filter is meaningful)`)
} else {
  section("4. real opencode registry")
  console.log("  SKIP  ~/.cache/opencode/models.json not present")
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
