import { execFile } from "node:child_process";
import fs from "node:fs";
import { rootScript } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { readJsonObject } from "@/lib/json-body";

// Fase B, item #2 (handoff): apply asistido desde la web. This is the ONLY
// route in the web apply flow that can confirm a submit: it calls the core
// apply-assist.mjs with --confirm SUBMIT, and it refuses any other value. The
// rule "nothing is ever submitted automatically" (web/AGENTS.md) holds because
// the web calls the core, and the core submits only on the exact typed
// confirmation word plus safety checks — identical contract to the CLI.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 320;

function parseTailJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  const idx = trimmed.lastIndexOf("{");
  if (idx === -1) return null;
  try {
    return JSON.parse(trimmed.slice(idx));
  } catch {
    return null;
  }
}

function runAssist(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
}> {
  const script = rootScript("apply-assist");
  if (!fs.existsSync(script)) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "apply-assist script missing", timedOut: false, spawnFailed: true });
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd: resolveCodeRoot(process.cwd(), process.env),
        timeout: 280_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const timedOut = e?.killed === true;
        const code = typeof e?.code === "number" ? e.code : e ? -1 : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "", timedOut, spawnFailed: !timedOut && code === -1 });
      },
    );
  });
}

export async function POST(req: Request) {
  const body = await readJsonObject<{ reportNum?: unknown; confirm?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const reportNum = String((body.reportNum ?? "")).trim();
  const confirm = String((body.confirm ?? "")).trim();
  if (!/^\d{1,3}$/.test(reportNum)) {
    return Response.json({ error: "reportNum required" }, { status: 400 });
  }
  // Only the exact confirm word reaches the core; anything else keeps it draft-only.
  if (confirm !== "SUBMIT") {
    return Response.json({ error: "must send confirm: SUBMIT" }, { status: 400 });
  }
  const padded = reportNum.padStart(3, "0");
  const { code, stdout, stderr, timedOut, spawnFailed } = await runAssist(
    [padded, "--json", "--mark-applied", "--source", "web", "--confirm", "SUBMIT"],
  );
  if (spawnFailed) return Response.json({ error: "apply-assist could not run" }, { status: 500 });
  if (timedOut) return Response.json({ error: "apply-assist timed out" }, { status: 504, headers: { "Retry-After": "5" } });
  const parsed = parseTailJson(stdout);
  if (!parsed) {
    return Response.json({ error: "apply-assist returned no result", code, stderr: stderr.slice(0, 300) }, { status: 500 });
  }
  return Response.json(parsed);
}
