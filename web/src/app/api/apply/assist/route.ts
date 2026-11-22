import { execFile } from "node:child_process";
import fs from "node:fs";
import { rootScript } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { readJsonObject } from "@/lib/json-body";

// Fase B, item #2 (handoff): integración web UI apply asistido. Invoca
// scripts/apply-assist.mjs (el core, mismo path del CLI) con --json y
// --source web; nunca hace submit. La ruta confirm/ lanza el flujo con
// confirmación explícita (--confirm SUBMIT).
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

function assistantArgs(reportNum: string, extra: string[]): string[] {
  // --no-generate/--no-open-draft kept as in CLI so the assist route stays pure (no artifact writes beyond the manifest);
  // the manual apply flow (modes/apply.md) still covers fully automatic preparation.
  return [reportNum, "--json", "--no-generate", "--no-open-draft", "--source", "web", ...extra];
}

function okArgs(reportNum: string): string[] {
  return assistantArgs(reportNum, []);
}

export async function POST(req: Request) {
  const body = await readJsonObject<{ reportNum?: unknown; report?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const reportNum = String((body.reportNum ?? body.report ?? "")).trim();
  if (!/^\d{1,3}$/.test(reportNum)) {
    return Response.json({ error: "reportNum required" }, { status: 400 });
  }
  const padded = reportNum.padStart(3, "0");
  const { code, stdout, stderr, timedOut, spawnFailed } = await runAssist(okArgs(padded));
  if (spawnFailed) return Response.json({ error: "apply-assist could not run" }, { status: 500 });
  if (timedOut) return Response.json({ error: "apply-assist timed out" }, { status: 504, headers: { "Retry-After": "5" } });
  const parsed = parseTailJson(stdout);
  if (!parsed) {
    return Response.json({ error: "apply-assist returned no result", code, stderr: stderr.slice(0, 300) }, { status: 500 });
  }
  return Response.json(parsed);
}
