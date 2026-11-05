/**
 * .opencode/plugin/career-ops.ts — opencode ADAPTER for the shared hooks.
 *
 * This file contains NO GUARD LOGIC. Every check lives in
 * `../../.shared/hooks/*.mjs`, is CLI-agnostic, and is unit-tested there. This
 * adapter's only job is to translate opencode's hook signatures into the
 * normalized contract in `.shared/hooks/contract.mjs`.
 *
 * opencode auto-discovers any *.ts in .opencode/plugin/ — including test files,
 * which then execute on every startup. Keep this directory to adapters only;
 * tests live in .opencode/test/.
 *
 * Sibling adapters, all sharing the same hooks:
 *   .shared/hooks/            the logic + contract
 *   .opencode/plugin/         this file
 *   .claude/hooks/            (Claude Code adapter — same runner, different events)
 *
 * Env:
 *   CAREER_OPS_STRICT=1   make `block` results actually block
 *   CAREER_OPS_VERBOSE=1  also surface passing (ok) results
 */

import type { Plugin } from "@opencode-ai/plugin"
import { createRunner } from "../../.shared/hooks/index.mjs"
import { pick, isFree, costOf, flatten } from "../../.shared/hooks/model-select.mjs"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Resolve the repo root from this file, not from process.cwd(): a headless
// `opencode run` may be invoked from anywhere, and the hooks need to find
// jds/, reports/ and config/ regardless.
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.CAREER_OPS_REPO || resolve(HERE, "..", "..")

const runner = createRunner({ repoRoot: REPO_ROOT })

/** Report each model key at most once per session, not once per message. */
const seenModels = new Set<string>()

const emit = (r: { messages: string[] }) => {
  for (const m of r.messages) process.stderr.write(`\n[career-ops] ${m}\n`)
}

/**
 * Cost data: the model registry opencode already caches on disk. Reading the
 * cache rather than parsing `opencode models --verbose` keeps this cheap, and
 * the cache is strictly richer on pricing (it carries both cost shapes).
 */
function readRegistry(): any | null {
  const p = join(homedir(), ".cache/opencode/models.json")
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, "utf8"))
  } catch { return null }
}


export default (async () => {
  return {
    // ── Free-model policy ───────────────────────────────────────────────────
    // Sets defaults ONLY where the user has not chosen. An explicit choice is
    // never overridden — it is reported, so a paid model is a decision rather
    // than an accident.
    // ── Free-model reporting ────────────────────────────────────────────────
    // Reads the model the session is ACTUALLY using — ground truth, needing no
    // availability guess. An earlier version assigned a default model from the
    // registry cache and picked `opencode-go/space-bunny-free`: free per the
    // cache, but that provider is not enabled here, and every session died with
    // "Unexpected server error". Two fixes were tried and rejected: shelling out
    // to `opencode models` (SIGTERM/ETIMEDOUT — a nested opencode contends with
    // the parent), and reading auth.json (does not exist). So: report, never
    // assign.
    //
    // `chat.params` rather than `chat.message`: the latter's `model` field is
    // OPTIONAL and came through undefined in practice, so the hook never fired.
    // `chat.params` types `model` and `provider` as required.
    "chat.params": async (input) => {
      const m: any = (input as any).model
      const prov: any = (input as any).provider
      const providerId = m?.providerID ?? prov?.id
      const modelId = m?.modelID ?? m?.id
      if (!providerId || !modelId) return
      const key = `${providerId}/${modelId}`
      if (seenModels.has(key)) return
      seenModels.add(key)

      const reg = readRegistry()
      const entry = reg ? findModel(reg, key) : null
      if (!entry) {
        process.stderr.write(`[career-ops model] ${key} — not in registry cache, cost unknown\n`)
        return
      }
      if (isFree(entry.model)) {
        process.stderr.write(
          `[career-ops model] ${key} — FREE (${entry.model.limit?.context ?? "?"} ctx, reasoning=${!!entry.model.capabilities?.reasoning})\n`,
        )
      } else {
        process.stderr.write(
          `[career-ops model] WARNING: ${key} is PAID — up to $${costOf(entry.model)}/Mtok.\n` +
          `  Free models on ${providerId}:\n` + alternatives(reg!, providerId, entry.model) + "\n",
        )
      }
    },

    // ── Small-model selection for background work ───────────────────────────
    // Unlike cfg.model, this hook RECEIVES the live provider, so its model list
    // is already filtered to what is enabled — no availability guess, and it
    // cannot select a model that will fail at call time. This is the safe place
    // to make an automatic choice.
    "experimental.provider.small_model": async (input, output) => {
      const provider: any = (input as any).provider
      const providerId = provider?.id
      if (!providerId) return
      const models = provider?.models
      if (!models || typeof models !== "object") return

      // Reuse the shared registry only for pricing; the CANDIDATE SET comes from
      // the live provider.
      const reg = readRegistry()
      const priced: any = {}
      for (const [id, m] of Object.entries<any>(models)) {
        const cached = reg ? findModel(reg, `${providerId}/${id}`) : null
        priced[id] = cached?.model ?? { ...m, cost: m.cost }
      }

      const best = pick({ [providerId]: { models: priced } }, { providerPrefix: providerId, requireToolCalls: true })
      if (!best.best) return
      const chosenId = best.best.id
      const live = (models as any)[chosenId]
      if (!live) return
      ;(output as any).model = live
      process.stderr.write(
        `[career-ops model] small_model(${providerId}) -> ${chosenId}` +
        ` (free, ${live.limit?.context ?? "?"} ctx)\n`,
      )
    },

    // opencode: before a tool runs → normalized BEFORE_WRITE
    "tool.execute.before": async (input, output) => {
      const tool = String(input.tool || "").toLowerCase()
      if (!/write|edit|patch|multiedit/.test(tool)) return

      const args = (output as any).args || {}
      const filePath: string | undefined = args.filePath ?? args.path ?? args.file
      if (typeof filePath !== "string") return

      const r = runner.beforeWrite({ filePath, content: args.content ?? args.newString ?? "" })
      if (r.blocked) throw new Error(`[career-ops] BLOCKED — ${r.messages.join("\n")}`)
      emit(r)
    },

    // opencode: after a tool runs → normalized AFTER_EXEC
    "tool.execute.after": async (input, output) => {
      const r = runner.afterExec({
        tool: String(input.tool || ""),
        output: String((output as any).output ?? ""),
        args: (input as any).args,
      })
      emit(r)
    },

    // opencode: system prompt assembly → normalized BUILD_SYSTEM
    "experimental.chat.system.transform": async (input, output) => {
      const extra = runner.systemText({
        cwd: REPO_ROOT,
        systemText: (output.system || []).join("\n"),
        prompt: input?.sessionID,
      })
      if (extra.length) output.system.push(...extra)
    },

    // opencode: child-process env → normalized BUILD_ENV
    "shell.env": async (_input, output) => {
      Object.assign((output as any).env, runner.envAdditions({ env: (output as any).env }))
    },
  }
}) satisfies Plugin

/** Free alternatives on the same provider, best first — shown when a model is paid. */
function alternatives(reg: any, providerId: string, current: any): string {
  const free = pick(reg, { providerPrefix: providerId, requireToolCalls: true })
  const lines = free.ranked.slice(0, 4).map((e: any) =>
    `    - ${e.key} ($${costOf(e.model)}/Mtok, ${e.model.limit?.context ?? "?"} ctx)`,
  )
  return lines.length ? lines.join("\n") : "    (no free model on this provider in the registry cache)"
}

/** Look up a `provider/model` key in the registry. */
function findModel(reg: any, key: string) {
  const [provider, ...rest] = String(key).split("/")
  const id = rest.join("/")
  const bucket = reg?.[provider]
  if (!bucket) return null
  const models = bucket.models ?? bucket
  return models?.[id] ? { provider, id, model: models[id] } : null
}
