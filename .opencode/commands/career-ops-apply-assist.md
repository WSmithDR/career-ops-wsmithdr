---
name: career-ops-apply-assist
description: Assisted apply flow: opens project-launched browser, prefills drafts, requires explicit human SUBMIT confirmation before any submit click.
---

# career-ops-apply-assist

Use when the user wants real assisted application filling without auto-submit.

## Usage

```bash
node scripts/apply-assist.mjs <report#|url>
# or
pnpm run apply:assist -- <report#|url>
```

## Safety

- Launches Playwright via `apply-scope.mjs` only (no CDP/attach to personal browser).
- Prepares local draft artifacts via `automation/prepare-application.mjs`.
- Prefills conservative fields and attaches CV when a file field is detected.
- **Never auto-submits.** Submit click happens only after the human types exact `SUBMIT`.
- Writes traceability to `output/applications/{NNN}/manifest.json`.
