/**
 * .shared/hooks/contract.mjs — the CLI-agnostic hook contract.
 *
 * WHY THIS FILE EXISTS
 * The guard logic behind these checks is useful to more than one AI CLI
 * (opencode, Claude Code, Codex, …), but every CLI names its events, its hook
 * signatures, and its configuration differently. Re-implementing the checks per
 * CLI guarantees they drift apart — and a check that drifts is worse than no
 * check, because it looks like protection.
 *
 * So: the LOGIC lives here, in plain ESM with no CLI imports, and each CLI gets
 * a thin adapter that translates its own events into these calls.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * Every hook is a pure function:
 *
 *     hook(event, payload, ctx) -> HookResult | null
 *
 *   event    string   a normalized event name (see EVENTS below), NOT a
 *                      CLI-specific name. Adapters map their own names here.
 *   payload  object   normalized, already-extracted data. Adapters do the
 *                      shape-munging so hooks stay trivially testable.
 *   ctx      object   { repoRoot, strict, log }
 *
 *   returns  null     when the hook has no opinion (the common case — a hook
 *                      that stays quiet costs nothing and stays out of the way)
 *            HookResult when it wants to say something
 *
 * HookResult:
 *   { level: "ok" | "warn" | "block", code: string, messages: string[] }
 *
 *   "warn"  — advisory; the adapter should surface it and continue
 *   "block" — the adapter SHOULD refuse the action, but only when ctx.strict
 *             is set. Every hook is advisory by default: a guard that silently
 *             refuses work is worse than a wrong report a human can see.
 *
 * ── Why pure ────────────────────────────────────────────────────────────────
 * No process.stdout/stderr writes (the adapter does that), no process.env
 * reads (passed in via ctx), no imports from any CLI package, no filesystem
 * writes. Reading files is allowed and is injected via ctx.repoRoot so tests
 * can point at a fixture. This is what makes the hooks reusable across CLIs and
 * unit-testable without spawning anything.
 */

/** Normalized event names. Adapters translate; hooks only ever see these. */
export const EVENTS = {
  /** About to create/modify a file. payload: { filePath, content, operation } */
  BEFORE_WRITE: "beforeWrite",
  /** A command/tool finished. payload: { tool, output, args } */
  AFTER_EXEC: "afterExec",
  /** Assemble the system prompt. payload: { systemText, cwd } → string[] */
  BUILD_SYSTEM: "buildSystem",
  /** Build the child-process environment. payload: { env } → env additions */
  BUILD_ENV: "buildEnv",
}

/** Ordering weight for BEFORE_WRITE hooks — lower runs first. */
export const ORDER = {
  [EVENTS.BEFORE_WRITE]: 10,
  [EVENTS.AFTER_EXEC]: 20,
  [EVENTS.BUILD_SYSTEM]: 30,
  [EVENTS.BUILD_ENV]: 40,
}

export const LEVEL = { OK: "ok", WARN: "warn", BLOCK: "block" }

/** Build a warn result. */
export const warn = (code, ...messages) => ({ level: LEVEL.WARN, code, messages: messages.flat() })

/** Build a block result. */
export const block = (code, ...messages) => ({ level: LEVEL.BLOCK, code, messages: messages.flat() })

/** Build an ok result (explicitly checked and fine — worth logging, unlike null). */
export const ok = (code, ...messages) => ({ level: LEVEL.OK, code, messages: messages.flat() })

/** Normalize a path for comparison. */
export const norm = (p) => String(p || "").replace(/\\/g, "/")

/** Extract the report number from `reports/003-foo-2026-09-26.md` or `jds/003-x.md`. */
export function reportNumberOf(filePath) {
  const m = norm(filePath).match(/(?:^|\/)(?:reports\/)?(\d{1,3})[-_]/)
  return m ? m[1].padStart(3, "0") : null
}

/**
 * True when the path looks like a career-ops evaluation report.
 *
 * Matches RELATIVE paths too. The original pattern required a leading `/`
 * (`/\/reports\//`), so `reports/404-ghost.md` — a perfectly normal path from a
 * shell adapter or a cron script — was silently treated as "not a report" and
 * the JD-grounding guard never fired. opencode always passes absolute paths,
 * which is exactly why the opencode-side tests passed while the shell adapter
 * quietly did nothing.
 */
export const isReportPath = (p) => /(?:^|\/)reports\/\d{1,3}-[^/]*\.md$/.test(norm(p))
