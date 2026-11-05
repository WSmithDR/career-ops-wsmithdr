# `.shared/hooks/` — CLI-agnostic guard logic

One file per hook. No CLI imports, no `process.stdout` writes, no side effects.
Each hook is a pure function:

```js
hook(event, payload, ctx) -> HookResult | null
```

`null` means "no opinion" — the common case, so a quiet hook costs nothing.

## Layout

| File | Purpose |
|---|---|
| `contract.mjs` | Event names, levels, shared helpers. Read this first. |
| `jd-grounding.mjs` | No evaluation report without a real JD artifact |
| `liveness-evidence.mjs` | HTTP 200 is not proof a posting is open |
| `content-feed.mjs` | A blog's RSS is not a job feed (`judgeFeed()`) |
| `portal-filters.mjs` | Don't filter out the candidate's own market |
| `runtime-env.mjs` | Chromium libs + `~/.local/bin` for headless sessions |
| `evidence-rules.mjs` | Injects evidence discipline into the system prompt |
| `model-select.mjs` | Pick models by measured cost, never by name |
| `index.mjs` | Registry + `createRunner()`. The only import an adapter needs. |
| `test.mjs` | 58 tests. CLI-agnostic — imports nothing from any CLI. |
| `test-model-select.mjs` | 32 tests, run against the real registry cache. |

## Adapters

An adapter translates one CLI's events into the normalized contract. It contains
no guard logic.

- `.opencode/plugin/career-ops.ts` — opencode (auto-discovered)
- `.shared/adapters/career-guard.mjs` — any CLI / cron / shell

```bash
# shell, cron, Makefile, any agent
node .shared/adapters/career-guard.mjs --before-write '{"filePath":"reports/042-x.md"}'
node .shared/adapters/career-guard.mjs --after-exec  '{"tool":"curl","output":"HTTP/1.1 200 OK"}'
node .shared/adapters/career-guard.mjs --system-text '{"cwd":"'"$PWD"'"}'
node .shared/adapters/career-guard.mjs --selftest
# exit 0 ok · 1 warn · 2 block
```

## Writing a new hook

1. Create `.shared/hooks/<name>.mjs` — import from `./contract.mjs` only.
2. `return null` unless you have something to say.
3. Register it in `index.mjs`. No adapter edits needed.
4. Add tests to `test.mjs`.

## Rules learned the hard way

- **Never declare a hook key twice in one object.** The second silently
  overwrote the first, disabling the JD guard while the file still looked
  correct.
- **Never put TypeScript syntax in a `.mjs`.** Node runs these directly.
- **Never use `\Z` as an end-of-string anchor** — that is Perl/Python. In
  JavaScript it matches a literal `Z`, so the function returned `[]` for every
  input, silently.
- **Prepend to `PATH`, never replace it.** Assigning a bare directory left
  headless shells with only `~/.local/bin`; every command failed with
  `node: command not found`.
- **Propagate `level` explicitly** in the runner. A typo made every result
  arrive with `level: undefined`, so `.warn` was permanently `false` — the
  guards fired and still reported nothing.
- **Handle relative paths.** opencode passes absolute paths, so a leading-slash
  assumption passed its tests and then silently no-op'd under a shell adapter.
- **Never auto-assign a model from the registry cache.** The cache is a global
  catalogue, not an availability list. It offered `opencode-go/space-bunny-free`
  (free, but that provider is not enabled) and every session died with
  "Unexpected server error". Availability and cost are different questions:
  cost from the cache, availability from the live provider handed to
  `experimental.provider.small_model`, or don't answer at all. Observe the model
  in use via `chat.params` — never guess one.
- **`chat.message`'s `model` field is optional and may be undefined.** Use
  `chat.params`, where `model` and `provider` are required.
- **`opencode/plugin/` auto-loads every `.ts`.** A test file there ran on every
  startup and called `process.exit()`. Tests belong in `.opencode/test/`.

## Env

- `CAREER_OPS_STRICT=1` — `block` results actually block (default: advisory)
- `CAREER_OPS_VERBOSE=1` — also surface passing results
- `CAREER_OPS_REPO` — repo root (default: two levels above this directory)
