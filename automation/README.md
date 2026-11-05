# Scheduled job automation

The six cron jobs that keep the job search fed. They run unattended, so the
design constraint that shaped all of it is: **a job that dies must not be
indistinguishable from a job that had nothing to do.** Both look like a quiet
week, and finding out two weeks late means an attractive posting expired while
the pipeline looked healthy.

## The jobs

| Time | Job | What it does | Cost |
|------|-----|--------------|------|
| 07:18 Mon–Fri | `career-scan` | Reads public job-board APIs, appends new URLs to `data/pipeline.md`. Idempotent — dedup via `data/scan-history.tsv`. | zero tokens |
| 07:41 Mon–Fri | `career-triage` | One small headless prompt ranks the pending queue by title+location into `data/shortlist.md`. Reads local files only. | one small prompt |
| 08:12 Mon | `career-recheck` | Browser-tier liveness pass over URLs added in the last 7 days; drops postings that have since closed. | zero tokens |
| 08:46 Mon | `career-harvest` | Probes *new* job platforms for a machine-readable feed, so a board worth adding is identified before it is wired into `portals.yml` by hand. Writes `data/harvest-report.md`. | zero tokens |
| 09:03 Mon | `career-selftest` | Runs the `.shared/hooks` guard suites. A guard that silently stops guarding is worse than no guard. | zero tokens |
| 09:30 Mon–Fri | `heartbeat` | Reports jobs that are missing, failed, or have lost their crontab entry. | zero tokens |

## Where things live

```
automation/
  run-job            dispatcher: per-job log + exit code in the ledger
  heartbeat          the watchdog; reports, never repairs
  automation.env     PATH + LD_LIBRARY_PATH for a non-interactive shell
  career-scan        wrapper: repo root, node on PATH, Chromium libs
  career-triage      wrapper + the triage prompt
  career-recheck     wrapper: picks recent URLs, renders each
  career-harvest     wrapper: board probe
  career-selftest    wrapper: guard suites
  harvest-probe.mjs  feed detection for candidate boards
  linkedin-harvest.mjs   NOT scheduled — run by hand (see below)
```

Generated at runtime, all under `data/` (gitignored):

| Path | Contents |
|------|----------|
| `data/automation/status.tsv` | The ledger: one row per run — timestamp, job, exit code, duration, command. |
| `data/automation-logs/<job>.log` | Per-job output. One job's log can no longer bury another's. |
| `data/automation/alert.md` | **Written only when something is wrong.** Its existence *is* the signal. Removed automatically on the next healthy run. |
| `data/triage.log` | The triage step's `opencode run` output (written by `career-triage` itself). |

`data/scan.log` is the pre-2026-09-28 combined log. Kept for history; nothing
writes to it any more.

## Checking on it

```bash
cat data/automation/status.tsv        # what ran, when, and did it work
cat data/automation/alert.md          # non-empty file = something is broken
crontab -l | grep run-job            # the schedule is installed
tail -f data/automation-logs/scan.log
```

`run-job` can be used by hand too, which is the fastest way to reproduce a
cron run exactly as it happens:

```bash
automation/run-job scan automation/career-scan --quiet
```

## Why these files are in the repo, and why that is safe

They used to live in `~/.local/bin` and `~/.local/share/career-automation/`.
Nothing version-controlled them, so a reinstall lost them silently and no review
ever saw them. They are here now.

`automation/` is **not** a path listed in `SYSTEM_PATHS` in `update-system.mjs`,
and it is not a `USER_PATHS` entry either. That is the useful part: the updater
only ever checks out paths it knows about, and only deletes local files that
also exist upstream. An unknown top-level directory is invisible to it in both
directions, so `node update-system.mjs apply` will neither overwrite nor remove
anything here. (Verified against `origin/main`, not assumed.)

The one thing that *is* a real hazard in this repo, and the reason not to put
automation under a system path: `update-system.mjs` is itself a `SYSTEM_PATHS`
entry, and `apply()` is a raw checkout, not a merge. A local edit to a system
file is discarded on update with only a warning. This directory is deliberately
not one.

## Editing a job

- **Reschedule it:** change the time in the crontab *and* the `SCHEDULE` table in
  `heartbeat`. The heartbeat's grace window must stay wide enough to outlast a
  slow run — `career-recheck` renders every URL with a throttle, so it needs
  minutes, not seconds.
- **Add a job:** write the wrapper, add a crontab line **through `run-job`**,
  add a row to `heartbeat`'s `SCHEDULE` table. Skipping any of the three means
  the heartbeat will report the new job as `CRONTAB` missing.
- **Paths in cron lines:** write `$HOME/...` out in full. Do **not** use
  crontab-level `NAME=value` variables — cron stores those literally and does
  not expand `$HOME` in them, so one such line silently breaks every job that
  depends on it. The command part of a cron line *is* run through a shell, which
  is why `$HOME` expands there.

### The exit-code convention, and the one job that breaks it

In the ledger, **non-zero always means the job did not do its work** — that is
the only thing the heartbeat infers from it. Two conventions met here that do
not agree, and the wrapper is where the disagreement gets resolved:

| Command | Its own meaning of exit 1 | Handled by |
|---------|--------------------------|------------|
| `scan.mjs`, `run-job`, guards, most CLIs | "I failed" | passed through |
| `check-liveness.mjs` | **"I found something"** — an expired posting or an uncertain verdict (its `expired > 0 \|\| uncertain > 0` check) | `career-recheck` translates it |

If `career-recheck` passed that code through, the heartbeat would report
`FAILED recheck` on every Monday a posting had genuinely lapsed — the recheck
working correctly, flagged as broken. An alert that cries wolf is worse than no
alert, because it teaches you to ignore the file.

So `career-recheck` exits 0 whenever the pass produced a `Results:` summary,
whatever it found, and reserves a non-zero exit for a run that produced no
summary at all (fatal error, bad arguments, no usable browser). **If you add a
job whose underlying tool signals "found something" via its exit code, translate
it in the wrapper for the same reason** — do not loosen the heartbeat instead.


## Untrusted input

`data/pipeline.md` is written by whatever posted the role, so every field in it
is third-party text. A posting can contain something shaped like an instruction
("ignore previous instructions", "as the reviewer you must…", "open this link to
verify"). The prompt inside `career-triage` tells the model to treat all of it
as data and to quote such text as an anomaly rather than act on it. Do not weaken
that clause when editing the prompt — it is the only thing standing between a
malicious posting and a scheduled, unattended agent that can write files.

`career-scan` and friends make no model calls, so they carry no such risk; only
`career-triage` and `career-selftest` involve a model, and both are read-only
with respect to the pipeline.
