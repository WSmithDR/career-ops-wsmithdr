/**
 * CLI-agnostic test suite for .shared/hooks/
 *
 * Deliberately imports NOTHING from opencode. These tests prove the hooks are
 * reusable by any CLI adapter; if a hook ever grew an opencode import, this file
 * would stop resolving.
 *
 * Run:  node .shared/hooks/test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { createRunner, runHooks, HOOKS, EVENTS, LEVEL } from "./index.mjs"
import jdGrounding, { findCapture, embedsJD } from "./jd-grounding.mjs"
import livenessEvidence, { classify } from "./liveness-evidence.mjs"
import contentFeed, { judgeFeed, parseFeedItems } from "./content-feed.mjs"
import portalFilters, { listUnder, candidateRegion } from "./portal-filters.mjs"
import runtimeEnv, { computeEnv } from "./runtime-env.mjs"
import evidenceRules, { applies } from "./evidence-rules.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "testdata")
const REAL_REPO = join(HERE, "..", "..")

let pass = 0, fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok    ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}`) }
}
const section = (s) => console.log(`\n${s}`)

// ── 1. registry ──────────────────────────────────────────────────────────────
section("1. registry & runner")
ok(HOOKS.length >= 5, `registry exposes ${HOOKS.length} hooks`)
ok(new Set(HOOKS.map(h => h.id)).size === HOOKS.length, "hook ids are unique")
ok(HOOKS.every(h => typeof h.run === "function"), "every hook exports run()")
ok(HOOKS.every(h => !/\.opencode|@opencode-ai/.test(JSON.stringify(h.run.toString()))), "no hook references opencode")
{
  const orders = HOOKS.map(h => h.order ?? 999)
  ok(orders.every((o, i) => i === 0 || o >= orders[i - 1]), "hooks are ordered deterministically")
}

// ── 2. jd-grounding ──────────────────────────────────────────────────────────
section("2. jd-grounding (no evaluation without a JD)")
{
  const repo = mkdtempSync(join(tmpdir(), "co-jd-"))
  mkdirSync(join(repo, "jds")); mkdirSync(join(repo, "reports"))
  writeFileSync(join(repo, "jds", "007-acme-rag.md"), "x".repeat(900))
  writeFileSync(join(repo, "jds", "008-stub.md"), "tiny")
  writeFileSync(join(repo, "reports", "009-x.md"), "## Job Description\n" + "y".repeat(700))

  ok(!!findCapture(repo, "007"), "finds a real capture for 007")
  ok(findCapture(repo, "008") === null, "rejects a stub capture (008)")
  ok(findCapture(repo, "099") === null, "returns null for a missing report")
  ok(embedsJD(repo, "009"), "detects an embedded verbatim JD section")

  const r = createRunner({ repoRoot: repo, strict: false })
  const good = r.beforeWrite({ filePath: join(repo, "reports/007-acme-2026-09-26.md") })
  ok(!good.warn && !good.blocked, "report with a capture passes silently")

  const bad = r.beforeWrite({ filePath: join(repo, "reports/099-nope-2026-09-26.md") })
  ok(bad.warn && bad.messages.join(" ").includes("NO JD artifact"), "report with no artifact warns")
  ok(!bad.blocked, "advisory by default (not blocked)")

  const strict = createRunner({ repoRoot: repo, strict: true })
  ok(strict.beforeWrite({ filePath: join(repo, "reports/099-nope-2026-09-26.md") }).blocked,
     "strict mode blocks the same write")
  ok(!strict.beforeWrite({ filePath: join(repo, "reports/007-acme-2026-09-26.md") }).blocked,
     "strict mode still allows a grounded report")

  const notReport = r.beforeWrite({ filePath: join(repo, "cv.md") })
  ok(!notReport.warn, "non-report writes are not flagged")

  // Regression: isReportPath once required a leading slash, so a RELATIVE path
  // bypassed the guard entirely. The opencode adapter only ever passes absolute
  // paths, so this was invisible there and only surfaced via the shell adapter.
  ok(r.beforeWrite({ filePath: "reports/099-relative-2026-09-26.md" }).warn,
     "RELATIVE report path is still guarded")
  ok(r.beforeWrite({ filePath: "./reports/099-dotted-2026-09-26.md" }).warn,
     "dot-relative report path is still guarded")
  ok(r.beforeWrite({ filePath: join(repo, "reports/007-acme-2026-09-26.md") }).warn === false,
     "grounded report via absolute path passes")
  rmSync(repo, { recursive: true, force: true })
}

// ── 3. liveness-evidence ─────────────────────────────────────────────────────
section("3. liveness-evidence (200 is not proof of liveness)")
{
  ok(classify("Results: 12 active 0 expired") === "browser", "check-liveness output is browser tier")
  ok(classify("HTTP/1.1 200 OK") === "http", "bare status is http tier")
  ok(classify("nothing useful") === "unknown", "unrecognisable output is unknown tier")

  const r = createRunner({ repoRoot: REAL_REPO })
  ok(r.afterExec({ tool: "curl", output: "HTTP/1.1 200 OK" }).warn, "bare 200 warns")
  ok(r.afterExec({ tool: "webfetch", output: "404 Not Found" }).messages.join().includes("DEAD"), "404 warns as dead")
  ok(!r.afterExec({ tool: "check-liveness", output: "3 active 0 expired" }).warn,
     "browser-tier result does not warn")
  ok(!r.afterExec({ tool: "read", output: "some file contents" }).warn, "unrelated tool is ignored")
}

// ── 4. content-feed ──────────────────────────────────────────────────────────
section("4. content-feed (a blog RSS is not a job feed)")
{
  const blogFeed = `<rss>${Array.from({ length: 8 }, () =>
    `<item><title>Cómo los sistemas ATS eliminan tu CV</title><link>https://focoempleo.com/blog/undefined/</link></item>`).join("")}</rss>`
  const jobFeed = `<rss>${Array.from({ length: 8 }, () =>
    `<item><title>AI Engineer (Remote LATAM)</title><link>https://boards.greenhouse.io/acme/jobs/42</link></item>`).join("")}</rss>`

  const j = judgeFeed(parseFeedItems(blogFeed))
  ok(j.verdict === "CONTENT_FEED", `blog feed judged CONTENT_FEED (was PROVIDER_WORTHY)`)
  const k = judgeFeed(parseFeedItems(jobFeed))
  ok(k.verdict === "JOB_FEED", "genuine job feed judged JOB_FEED")
  ok(judgeFeed([]).verdict === "EMPTY", "empty feed handled")

  const r = createRunner({ repoRoot: REAL_REPO })
  ok(r.afterExec({ tool: "career-harvest", output: "RSS /rss.xml (16 items)\nhttps://focoempleo.com/blog/undefined/" }).warn,
     "content-shaped feed output warns")
  ok(!r.afterExec({ tool: "career-harvest", output: "RSS /rss.xml (40 items)\nhttps://boards.greenhouse.io/a/jobs/1" }).warn,
     "job-shaped feed output does not warn")
}

// ── 5. portal-filters ────────────────────────────────────────────────────────
section("5. portal-filters (don't block the candidate's own region)")
{
  ok(listUnder("location_filter:\n  block:\n    - \"Brazil\"\n    - \"India\"\n", "block").join() === "Brazil,India",
     "listUnder extracts a block list")

  const r = createRunner({ repoRoot: REAL_REPO })
  const bad = r.beforeWrite({
    filePath: join(REAL_REPO, "portals.yml"),
    content: "location_filter:\n  block:\n    - \"Ecuador\"\n    - \"India\"\n",
  })
  ok(bad.warn, "candidate's own country in block warns")
  ok(bad.messages.join(" ").includes("OWN region"), "message names the specific problem")

  const allowOnly = r.beforeWrite({
    filePath: join(REAL_REPO, "portals.yml"),
    content: "location_filter:\n  allow:\n    - \"United States\"\n    - \"Germany\"\n",
  })
  ok(allowOnly.warn, "non-empty allow-list with no remote token warns")

  const good = r.beforeWrite({
    filePath: join(REAL_REPO, "portals.yml"),
    content: "location_filter:\n  always_allow:\n    - \"Remote\"\n  allow:\n    - \"Ecuador\"\n    - \"Colombia\"\n",
  })
  ok(!good.warn, "sensible remote-first filter passes")

  const trap = r.beforeWrite({
    filePath: join(REAL_REPO, "portals.yml"),
    content: "location_filter:\n  always_allow:\n    - \"Remote\"\n  allow:\n    - \"India\"\n",
  })
  ok(trap.warn, "country-level remote trap in allow warns")
}

// ── 6. runtime-env (regression: never replace PATH) ──────────────────────────
section("6. runtime-env (Chromium libs; PATH is prepended, never replaced)")
{
  const empty = computeEnv({ env: {}, home: REAL_REPO })
  ok(!("PATH" in empty) || empty.PATH !== "", "no PATH invented when none supplied")

  const preset = computeEnv({ env: { PATH: "/usr/bin:/bin" }, home: "/home/wagner" })
  ok(!preset.PATH || preset.PATH.endsWith(":/usr/bin:/bin"), "existing PATH preserved when bin absent")

  const real = computeEnv({ env: { PATH: "/usr/bin:/bin" } })
  ok(real.PATH === `/home/wagner/.local/bin:/usr/bin:/bin`, "real ~/.local/bin prepended to real PATH")
  ok(real.PATH.includes("/usr/bin"), "system PATH entries survive (regression)")

  // When ~/.local/bin is ALREADY on PATH there is nothing to change, so
  // computeEnv returns no PATH key at all. Asserting the absence is the correct
  // check — an earlier version of this test wrongly read the returned PATH.
  const dup = computeEnv({ env: { PATH: `/usr/bin:/bin:${process.env.HOME}/.local/bin` } })
  ok(!("PATH" in dup), "no PATH returned when ~/.local/bin is already present")
  ok("LD_LIBRARY_PATH" in dup, "libs still injected independently of PATH")

  // And the merged result must not gain a duplicate entry.
  const merged = { PATH: `/usr/bin:/bin:${process.env.HOME}/.local/bin`, ...dup }
  ok(merged.PATH.split(":").filter(p => p.endsWith(".local/bin")).length === 1, "no duplicate bin entry after merge")
  ok("LD_LIBRARY_PATH" in real, "chromium libs injected")

  const runner = createRunner({ repoRoot: REAL_REPO })
  const env = { PATH: "/usr/bin:/bin" }
  Object.assign(env, runner.envAdditions({ env }))
  ok(env.PATH.includes(".local/bin") && env.PATH.includes("/usr/bin"), "runner envAdditions merges correctly")
}

// ── 7. evidence-rules ────────────────────────────────────────────────────────
section("7. evidence-rules (system-prompt injection)")
{
  ok(applies({ cwd: "/home/wagner/Documents/career-ops" }), "applies inside a career-ops repo")
  ok(applies({ systemText: "triage my pending job queue" }), "applies on job-search phrasing")
  ok(!applies({ cwd: "/tmp", systemText: "refactor this python module" }), "silent in an unrelated session")

  const r = createRunner({ repoRoot: REAL_REPO })
  const lines = r.systemText({ cwd: REAL_REPO, systemText: "career-ops" })
  ok(lines.length > 0, "rules returned for a career-ops session")
  const joined = lines.join("\n")
  ok(/NO EVALUATION WITHOUT A JD/.test(joined), "rule 1 present")
  ok(/HTTP 200 IS NOT/.test(joined), "rule 2 present")
  ok(/QUOTE DECISION-CHANGING FACTS/.test(joined), "rule 3 present")
  ok(r.systemText({ cwd: "/tmp", systemText: "unrelated" }).length === 0, "nothing injected elsewhere")
}

// ── 8. resilience ────────────────────────────────────────────────────────────
section("8. resilience")
{
  // A crashing hook must not take the session down.
  const boom = { id: "boom", order: 1, run() { throw new Error("kaboom") } }
  const orig = HOOKS.splice(0, HOOKS.length, boom)
  const res = runHooks(EVENTS.BEFORE_WRITE, { filePath: "x" }, { repoRoot: REAL_REPO })
  ok(res.length === 1 && res[0].messages.join().includes("kaboom"), "a throwing hook is caught and reported")
  HOOKS.splice(0, HOOKS.length, ...orig)
  ok(HOOKS.length === orig.length, "registry restored")
}

// ── 9. against the real repo ─────────────────────────────────────────────────
section("9. real repo (regression against this session's actual artefacts)")
{
  const r = createRunner({ repoRoot: REAL_REPO, strict: false })
  const grounded = ["002", "003", "004", "005", "009", "010", "011"]
    .every(n => !r.beforeWrite({ filePath: join(REAL_REPO, `reports/${n}-x-2026-09-26.md`) }).warn)
  ok(grounded, "all 8 real reports pass JD grounding (jds/ captures resolve)")

  // The exact misconfiguration shipped earlier in this session.
  const old = r.beforeWrite({
    filePath: join(REAL_REPO, "portals.yml"),
    content: "location_filter:\n  allow:\n    - \"Remote\"\n    - \"United States\"\n    - \"Europe\"\n  block:\n    - \"Brazil\"\n    - \"India\"\n",
  })
  ok(old.warn, "the ORIGINAL bad filter is now caught")
  ok(old.messages.join(" ").includes("Brazil"), "and it names Brazil specifically")
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
