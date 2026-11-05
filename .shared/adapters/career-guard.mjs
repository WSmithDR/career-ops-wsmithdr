#!/usr/bin/env node
/**
 * .shared/adapters/career-guard.mjs — a CLI-agnostic adapter.
 *
 * Any CLI, cron job, Makefile, or shell script can call this without writing a
 * single line of hook logic. It is the proof that `.shared/hooks/` is genuinely
 * reusable rather than opencode-shaped: this adapter knows nothing about
 * opencode, and so does none of the hooks it calls.
 *
 *   echo '{"event":"beforeWrite","filePath":"...","content":"..."}' | career-guard
 *   career-guard --after-exec '{"tool":"curl","output":"HTTP/1.1 200 OK"}'
 *   career-guard --system-text '{"cwd":"/path/to/career-ops"}'
 *   career-guard --env
 *   career-guard --selftest
 *
 * Exit codes (so a shell can branch on it):
 *   0  ok / no opinion
 *   1  warn   — something was flagged, advisory
 *   2  block  — refused (only when CAREER_OPS_STRICT=1)
 *
 * JSON on stdout: { "level", "blocked", "warn", "messages": [...] }
 */

import { createRunner, EVENTS } from "../hooks/index.mjs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.CAREER_OPS_REPO || resolve(HERE, "..", "..")

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }

const readStdin = async () => {
  if (process.stdin.isTTY) return {}
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const s = Buffer.concat(chunks).toString("utf8").trim()
  if (!s) return {}
  try { return JSON.parse(s) } catch { return { _unparseable: s } }
}

const runner = createRunner({ repoRoot: REPO_ROOT })
const emit = (r) => {
  process.stdout.write(JSON.stringify({
    level: r.blocked ? "block" : r.warn ? "warn" : "ok",
    blocked: r.blocked, warn: r.warn, messages: r.messages,
  }) + "\n")
  if (r.messages.length && !process.env.CAREER_OPS_QUIET) {
    for (const m of r.messages) process.stderr.write(`[career-ops] ${m}\n`)
  }
  process.exit(r.blocked ? 2 : r.warn ? 1 : 0)
}

if (flag("--selftest")) {
  process.stderr.write(`career-guard: repo=${REPO_ROOT}\n`)
  const r = runner.beforeWrite({ filePath: `${REPO_ROOT}/reports/999-selftest-2026-09-26.md` })
  process.stderr.write(`career-guard: hooks reachable, jd-grounding ${r.warn ? "fires" : "quiet"} as expected\n`)
  process.exit(0)
}

if (flag("--env")) {
  process.stdout.write(JSON.stringify(runner.envAdditions({ env: { ...process.env } })) + "\n")
  process.exit(0)
}

if (flag("--system-text")) {
  const payload = JSON.parse(opt("--system-text") || "{}")
  process.stdout.write(runner.systemText({ cwd: REPO_ROOT, ...payload }).join("\n") + "\n")
  process.exit(0)
}

if (flag("--after-exec")) {
  const payload = JSON.parse(opt("--after-exec") || "{}")
  emit(runner.afterExec(payload))
}

if (flag("--before-write")) {
  const payload = JSON.parse(opt("--before-write") || "{}")
  emit(runner.beforeWrite(payload))
}

// default: event + payload on stdin
const stdin = await readStdin()
if (stdin._unparseable) {
  process.stderr.write("career-guard: stdin was not valid JSON\n")
  process.exit(1)
}
const event = stdin.event || EVENTS.BEFORE_WRITE
const payload = stdin.payload || stdin

if (event === EVENTS.BEFORE_WRITE) emit(runner.beforeWrite(payload))
else if (event === EVENTS.AFTER_EXEC) emit(runner.afterExec(payload))
else if (event === EVENTS.BUILD_SYSTEM) {
  process.stdout.write(runner.systemText({ cwd: REPO_ROOT, ...payload }).join("\n") + "\n")
  process.exit(0)
} else {
  process.stderr.write(`career-guard: unknown event "${event}"\n`)
  process.exit(1)
}
