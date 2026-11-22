# apply-assist

Assisted application flow with explicit human confirmation.

## Usage

```
/apply-assist <report#|url>
```

Runs `pnpm run apply:assist -- <report#|url>`: opens a project-launched Playwright browser, prepares draft artifacts, prefills conservative fields, and **never submits automatically**. Submit click happens only if you type `SUBMIT` exactly.
