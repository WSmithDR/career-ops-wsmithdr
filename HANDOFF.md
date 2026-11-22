# HANDOFF — Automatizaciones career-ops

## Estado actual (2026-11-21)

### Automatizaciones instaladas y funcionando

**1. Crontab clásico (`automation/`)** — 6 jobs, paths corregidos al repo real (`career-ops-wsmithdr`):
- `scan` — 07:17 Lun–Vie (zero tokens, appends a `data/pipeline.md`)
- `triage` — 07:41 Lun–Vie (rankea pendientes en `data/shortlist.md`, 1 prompt pequeño)
- `recheck` — 08:12 Lun (liveness browser de URLs recientes)
- `harvest` — 08:46 Lun (probe de nuevas plataformas)
- `selftest` — 09:03 Lun (guards `.shared/hooks`)
- `heartbeat` — 09:30 Lun–Vie (escribe `data/automation/alert.md` si algo falta)

**2. Crontab `auto-run.mjs`** — cada 6 horas (`0 */6 * * *`):
- Ejecuta `scan.mjs`, evalúa pendientes del pipeline, `merge-tracker.mjs`, `hook-learn-negative-keywords.mjs`

**3. Timer systemd** — activo (`active (waiting)`), cada 6 horas:
- Corre como usuario `wagner` con `node` de nvm
- Dispara `scripts/auto-run.mjs`

### Hook de sesión
- `~/.bashrc` ejecuta `scripts/install-automation.mjs` al iniciar sesión (idempotente, instala lo que falta sin sudo)
- Script de reparación manual: `scripts/fix-systemd-now.sh` (si el timer de systemd se rompe de nuevo)

### Archivos relevantes
- `automation/README.md` — documentación de los 6 jobs cron
- `automation/automation.env` — PATH + LD_LIBRARY_PATH para cron
- `scripts/install-automation.mjs` — hook de instalación automática
- `scripts/auto-run.mjs` — flujo completo (scan → evaluar → merge → aprender keywords)
- `scripts/scheduler-status.mjs` — estado del programador (`node scripts/scheduler-status.mjs`)
- `config/career-ops-crontab.txt` — plantilla de crontab (cada 6 h)
- `config/career-ops-scan.service` / `.timer` — unidades systemd
- `data/automation/status.tsv` — ledger de ejecuciones
- `data/automation/alert.md` — existe solo si hay algo roto (heartbeat lo escribe/borra)

### Datos actuales
- `data/pipeline.md` — ofertas nuevas escaneadas (pendientes de evaluar)
- `data/shortlist.md` — último triage (137–245 entries según fechas)
- `data/applications.md` — tracker (se actualiza con `merge-tracker.mjs` o `set-status.mjs`)
- `data/scan-history.tsv` — historial de escaneos

---

## Telegram (implementado)

### Qué hay
- `scripts/notify-new-shortlist.mjs` — envía shortlist por Telegram con delta por defecto (estado en `data/automation/telegram-notified.json`). Flags: `--all`, `--section <name>`, `--force`, `--dry-run`.
- `scripts/telegram-bot.mjs` — bot long polling. `/apply N` prepara borrador local (`automation/prepare-application.mjs`) cuando hay reporte asociado y marca `Evaluated` con nota "draft prepared, not submitted"; **nunca envía ni hace submit**. `/cv N` genera PDF por `--report=NNN` cuando encuentra el reporte de la oferta.
- `scripts/telegram-bot-start.sh` — `start|stop|status|logs`; PID en `data/automation/telegram-bot.pid`, log en `data/automation/telegram-bot.log`.
- `scripts/setup-telegram-bot.sh` — setup one-shot (gitignored, secretos).
- `scripts/auto-run.mjs` — paso 6 notifica shortlist por Telegram si hay credenciales (delta por defecto).

### Configuración
- `config/telegram.env` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (gitignored).
- `config/telegram.example.env` — plantilla sin secretos.

### Autoarranque en boot
- Crontab `@reboot` ejecuta `scripts/telegram-bot-start.sh start`.

### Notas
- **Ética/regla de sistema**: ninguna automatización envía postulaciones. `/apply` prepara borradores locales; el humano revisa y hace submit.
- Verificar: `scripts/telegram-bot-start.sh status`, `scripts/telegram-bot-start.sh logs`.

## Actualización 2026-11-22

- **`/apply N` por defecto genera solo el CV adaptado** (`generate-pdf.mjs --report=N`); la preparación completa (CV + carta + borrador de email) se pide con `/apply N --full` o `automation/prepare-application.mjs N`.
- **`/list` incluye descripción + score + fit del reporte** (excerpt del JD archivado en el reporte, la línea "Fit reasoning" y la "Recommendation") cuando existe reporte para la oferta.
- **Auto-run notifica shortlist por Telegram** (credenciales cargadas desde `config/telegram.env` desde `scripts/auto-run.mjs`; notifica al siguiente run de cron cada 6 h).
- **`scripts/telegram-bot-start.sh`** encuentra node sin nvm en PATH (mismo truco que usa `automation/automation.env`) y lanza el bot con `setsid` para que sobreviva entre sesiones.
- **Rotación de modelos en `openrouter-runner.mjs`**: al recibir 429 "free-models-per-day" ya no se detiene en el primer modelo con cuota agotada: se itera al siguiente modelo del grupo free y solo se detiene cuando no hay ninguno disponible (`QuotaExhaustedError`: "All N active models reported exhausted daily quota"). Si el 429 trae reset info (`Retry-After` o campos `retry_at`/`reset_at`/`next_reset_at`/`quota_reset_at`/`available_at` del body), se registra la hora de restauración en `data/model-quota-state.json`; los modelos con reset futuro se excluyen de la rotación hasta entonces y, al recuperarse, la entrada se borra.
- **Otras mejoras de rotación (por discutir — sesión nueva)**: 1) `modelIndex` no persiste entre runs — cada cron empieza por el modelo de mayor prioridad; rotar el inicio o recordar el último usado. 2) Mientras rota, un modelo blacklisted a mitad del bucle puede volver a salirse por el `active` fijo. 3) Triage (`career-triage`): un único intento de `opencode run` — sin reintentos; el modelo fijado (`CAREER_OPS_MODEL`) también rota por diseño.

---

## Actualización 2026-11-21

- **#4 Alertas/cron**: se eliminó bloque crontab legacy (`~/Documents/career-ops`) y quedó solo el bloque `career-ops-wsmithdr` + auto-run + reboot bot. `automation/heartbeat` ya reporta healthy y se removió `data/automation/alert.md` viejo.
- **#3 Delta Telegram**: `notify-new-shortlist.mjs` guarda ofertas notificadas en `data/automation/telegram-notified.json`; por defecto no reenvía.
- **#2 CV por oferta**: `/cv N` resuelve reporte por URL (`find.mjs`) y usa `generate-pdf.mjs --report=NNN`; si no hay reporte, pide evaluar primero.
- **#1 Apply por Telegram**: `/apply N` ya no marca Applied. Prepara borrador local con `automation/prepare-application.mjs` cuando hay reporte, marca `Evaluated` con nota explícita de no-submit, y responde que el humano debe revisar/enviar.

## Pendiente / próximos pasos
1. **Aplicación real asistida (con confirmación humana):** flujo completo para adjuntar PDF/carta y abrir cliente de correo o completar formulario, pero con confirmación explícita antes de cualquier Send/Submit.
2. **Mejorar calidad de evaluación automática:** `scripts/evaluate-url.mjs` usa heurística simple; integrar modo `oferta`/auto-pipeline real para reportes con Blocks A-G confiables.
3. **Cola auto-run grande:** 199 tareas pendientes en `data/auto-queue.json`; revisar priorización/cadencia para evitar backlog.
4. **Trazabilidad:** registrar en tracker/notas qué borradores fueron preparados por Telegram y su estado humano (enviado/no enviado).

---

**Comando para verificar estado:** `node scripts/scheduler-status.mjs` o `systemctl status career-ops-scan.timer`
**Bot Telegram:** `scripts/telegram-bot-start.sh status`
**Logs bot:** `scripts/telegram-bot-start.sh logs`

## Próxima sesión (segura, sin auto-submit)

- **Objetivo acordado:** implementar "apply asistido real" con confirmación explícita humana antes de cualquier Send/Submit. No modificar `AGENTS.md` para auto-postular: la regla ética se mantiene.
- **Alcance seguro:**
  - Abrir formulario en Playwright lanzado por el proyecto (`apply-scope.mjs`/reglas de apply).
  - Prellenar campos y adjuntos desde artefactos existentes (`output/applications/{NNN}/`, CV/cover/report).
  - Mostrar resumen de lo que se va a enviar y pedir confirmación final explícita.
  - Solo si el usuario confirma explícitamente, permitir la acción de envío/submit; si no confirma, no hacer nada.
  - Registrar trazabilidad: borrador preparado, confirmado/no confirmado, enviado/no enviado (solo por confirmación humana).
- **Restricciones no negociables:** nunca auto-submit, nunca enviar email por SMTP/API oculto, nunca usar CDP/browser ajeno, nunca inferir envío por abrir mailto/generar PDF.

## Actualización 2026-11-21 (apply asistido)

- **Nuevo**: `scripts/apply-assist.mjs` (`pnpm run apply:assist <report#|url>`). Abre formulario en Playwright lanzado por el proyecto (`apply-scope.mjs`), prepara borradores con `automation/prepare-application.mjs`, precarga campos conservadores (nombre/email/teléfono/ubicación/links/CV si encuentra archivo), muestra resumen y **nunca hace submit automático**.
- **Confirmación humana explícita**: solo si el usuario escribe exactamente `SUBMIT`, el script hace click en el botón de envío detectado. Cualquier otra entrada deja estado draft-only.
- **Safety checks**: antes de permitir submit, bloquea si no detecta submit, si hay submit ambiguo, si quedan campos `required` sin llenar, o si detecta controles `Next/Continue` (multi-step) — en esos casos queda `blocked-for-safety` y no hace click. Revalida safety justo antes del click.
- **Trazabilidad**: `output/applications/{NNN}/manifest.json` registra `draft-prepared`, `prefill-completed`, `safetyCheck`, confirmación/declinación, y estados finales (`submitted-by-human-confirmation`, `draft-only-not-submitted`, `blocked-for-safety`, etc.). En modo `--json` no pregunta ni envía; retorna `ready-for-confirmation` o `blocked-for-safety`.
- **Telegram/bot**: `/apply` sigue draft-only y sugiere `node scripts/apply-assist.mjs N`; `/assist N` da instrucciones locales con confirmación humana explícita. `/sent N` y `/notsent N` escriben manifest; `/sent` solo marca `Applied` si hay evidencia verificada de submit en manifest, si no queda registro humano no verificado y tracker en `Evaluated`.
- **CLI apply**: `node scripts/apply.mjs <...> --assist` delega a `apply-assist.mjs`; `--mark-applied` actualiza tracker solo tras confirmación `SUBMIT` y click.
- **Tests**: `tests/apply-assist.test.mjs` cubre draft-only, confirmación exacta `SUBMIT`, `--json` ready-for-confirmation, submit no detectado, required unfilled, y multi-step/next bloqueado. `tests/telegram-bot-apply-assist.test.mjs` cubre comando `/assist` y guardrail no-submit.

## Estado de la sesión 6 (2026-11-22)

Sesión 6 retomó Fase A y completó la Fase B web UI. Todas Fase A + trazabilidad commiteadas. Web UI validada (typecheck ok), rutas nuevas sin commitear.

### A. Fase A + trazabilidad — ✅ COMPLETADAS (commiteadas)

- **Robustez apply-assist** (`689525b2`): iframes mismos-origen (detección/relleno), React-select/comboBox char-by-char con re-detección, checkboxes/radios legales sin auto-check (candidate-decision), barrido iterativo de requeridos por paso (estilo Workday). Re-chequeo de seguridad justo antes del click.
  - Verificación: `node --check scripts/apply-assist.mjs`, `node scripts/check-syntax.mjs scripts/apply-assist.mjs` (ok), `timeout 180 node --test tests/apply-assist.test.mjs` → 6/6 PASS (login interactive N/A en CI).
- **Trazabilidad canonical manifest↔tracker** (`a60ca696`): `lib/apply-trace.mjs` — módulo con contrato único: `writeTraceRecord(manifestPath,{source:'telegram'|'cli'|'web'|'unknown', event, draftPrepared, confirmed, submittedByHuman, submittedAt, finalUrl, verified, details})`; `isVerifiedSubmit(manifest)` → manifest.humanConfirmation.submittedByHuman===true O manifest.finalStatus==='submitted-by-human-confirmation'; `trackerDecision(source,verified,day)` → {status:Applied,note,on} si verified, sino {status:Evaluated,note}; `normalizeSource`.
  - `apply-assist.mjs` usa source='cli' (hardcodeado en call-sites) y no tiene flags --source/--confirm.
  - `telegram-bot.mjs`: `/sent` y `/notsent` usan writeTraceRecord source='telegram'; `/sent` marca Applied solo si isVerifiedSubmit(manifest), si no queda registro humano no verificado en tracker (Evaluated). Se eliminó writeManifestRecord (uso dupeado de writeTraceRecord).
  - Tests: `tests/apply-assist.test.mjs` 6/6 PASS; `tests/telegram-bot-apply-assist.test.mjs` 1/1 PASS.

### B. Fase B web UI — ✅ COMPLETADA (commiteada en `37000cc4`)

Rutas nuevas (typecheck ok: `npm run typecheck` en web/ PASS):
- `web/src/app/api/apply/assist/route.ts`: POST {reportNum} → `runAssist([num,"--json","--no-generate","--no-open-draft","--source","web"])` → JSON {finalStatus, safety, requiredMissing, submitCandidate, counts, selections, manifestPath}. Delegación directa al core: `rootScript("apply-assist")` + `resolveCodeRoot` + `execFile`, `@/lib/career-ops.ts`, `@/lib/json-body`.
- `web/src/app/api/apply/assist/confirm/route.ts`: POST {reportNum, confirm} → solo si confirm === "SUBMIT" → `runAssist([num,"--json","--mark-applied","--source","web","--confirm","SUBMIT"])`. 400 si confirm !== "SUBMIT". Regla no-auto-submit: el submit solo con confirmación literal SUBMIT + safety.checks.

Note: `lib/apply-trace.mjs` y `scripts/apply-assist.mjs` tienen cambios de esta session 6 DESCOMITADOS: export `normalizeSource` (lib/apply-trace.mjs), flags `--source` (default 'cli') y `--confirm SUBMIT` + uso en main() (scripts/apply-assist.mjs). Commitear: `git add lib/apply-trace.mjs scripts/apply-assist.mjs && git commit -m "feat(apply): export normalizeSource; apply-assist --source + --confirm SUBMIT support"`.

### Pending

En sesión nueva:

1. Commit pending: `git add lib/apply-trace.mjs scripts/apply-assist.mjs && git commit -m "..."` (precede la Fin de session 6 exitosa).
2. Regresión/higiene: `node update-system.mjs check` (silently), `node doctor.mjs --json`, `node scripts/check-syntax.mjs`, suites apply/web/automation. Correr suites antes de commit final.
3. Update-check notificar user si `node update-system.mjs check` devuelve status update-available.
4. Confirmar `git status` clean antes de declarar fin de session.
5. Confirmar antes de commitear: summary final ó retro (learning proposal if user corrects).

---

## Estado de la sesión 7 (2026-11-22)

### Update v1.39.0 → v1.40.0 — ✅ APLICADO

- Commit `0d187361` "chore: auto-update system files to v1.40.0" (454 paths). El update había notificado antes: "dashboard binary rebuild skipped -- run `npm run build:dashboard` manually".
- Go instalado user-local sin sudo: `~/go-toolchain` (Go 1.26.11 — cumple el `go 1.26.0` de `dashboard/go.mod`). Para sesiones futuras: `export PATH="$HOME/go-toolchain/bin:$PATH"`.
- Dashboard build: `npm run build:dashboard` → exit 0, generó `dashboard/career-dashboard` (6.7 MB, ELF x86-64).

### Regresión sesión 7 — ✅ TODAS GREEN

- `node update-system.mjs check` → `{"status":"up-to-date","local":"1.40.0","remote":"1.40.0"}`.
- `node scripts/check-syntax.mjs` → 2225 archivos OK (el update agregó .mjs).
- `node --test tests/apply-assist.test.mjs` → 6/6 PASS. Nota: una ejecución poco después del update mostró "7 tests / 6 pass / 1 fail" (el conteo varió entre re-ejecuciones: archivos del update todavía escribiéndose); tres re-ejecuciones posteriores estables: 6/6 PASS.
- `node --test tests/telegram-bot-apply-assist.test.mjs` → 1/1 PASS.
- `npm run typecheck` (web/) → PASS.
- `node scripts/scheduler-status.mjs` → timer activo; cola 10 ejecutadas, 10 OK, 0 fallidas; límite alcanzado (`--queue-limit`), 170 restantes en `data/auto-queue.json`.
- `node doctor.mjs --json` → sin onboarding, sin faltantes. Warning pre-existente: `cv.md` sin entradas `### Company — Location` (advisory; archivo user-layer — sin tocar).
- `git status`: tree clean (nada por commitear).

### Pendiente (continuación en nueva sesión)

1. **Aplicación real asistida** — ✅ DONE (sesión 6): draft-only garantizado por los tests (6/6 + 1/1).
2. **Mejorar calidad de evaluación automática** — `scripts/evaluate-url.mjs` usa heurística simple; integrar modo `oferta`/auto-pipeline real para reportes con Blocks A-G confiables.
3. **Cola auto-run grande** — ~199 tareas en `data/auto-queue.json`; según scheduler-status, 170 restantes + límite alcanzado. Revisar priorización/cadencia.
4. **Trazabilidad** — registrar en tracker/notes qué borradores fueron preparados por Telegram y su estado humano (enviado/no enviado).
5. **Quizás retro** — validar aprendizajes de sesión 6 del apply-asistido (ej. confirmar-submit exacto está bien; no invadir en el terreno humano).

---

## Estado de la sesión 8 (2026-11-22)

### Regresión del update v1.40.0 — ✅ REPARADA (commit `05588697`)

- **Root cause:** el update (`0d187361`) reescribió `scan-dayforce.mjs`, `scan-ats-full.mjs`, `coverage-check.mjs`, `filter-audit.mjs` y los tests nuevos (`same-job-write-dedup.test.mjs` +293, `scan-ats-full-dedup-key.test.mjs` +9, `content-filter-traits.test.mjs` +536, `board-truncation.test.mjs` +164) para importar de `scan.mjs` exports que esta rama nunca provee: `seenJobKey`, `scanHistoryPolicy`, `buildContentFilterOrExit`, `buildTitleGate`, `matchContentTraits`, `compileContentTraits`, `foldContentText`, `computePartialStreaks`.
- **Portado de la rama equivalente (`a0e4f0af`):**
  - `scan.mjs`: exporta `seenJobKey` (= `canonicalJobKey(url) || normalizeUrlForDedup(url)`) y `scanHistoryPolicy`; re-exporta `compileContentTraits`/`foldContentText` desde `title-keywords.mjs`; `buildContentFilter` reemplazado por la versión nueva (`min_match`, `rescue_title_misses`, reglas de traits); portados `matchContentTraits`/`buildContentFilterOrExit`/`buildTitleGate`; internos de dedup pasados de `normalizeUrlForDedup` a `seenJobKey`; `appendToPipeline`/`appendToScanHistory` con dedup por same-job write (`sameJobWriteKey`, `keysInPipeline`, `keysInScanHistory`, `offersMissingFromPipeline`, `offersMissingFromHistory`).
  - `check-liveness.mjs`: `planExpiredHistoryRows` recibe `seenJobKey`; `recordExpiredVerdicts` devuelve filas que realmente llegaron (`appendToScanHistory`).

### Regresión suite — ✅ TODAS GREEN

- Batch `node --test`: apply 17/17; scan batch (same-job-write-dedup, liveness-record-expired, scan-recheck-policy-siblings, scan-recheck-pipeline-repin, scan-history-headerless-first-row, scan-listing-fingerprint, scan-url-dedup, scan-ats-full-dedup-key, scan-dedup-language, check-liveness-status-flag) 37/37; scan-ats-full family 5/5.
- `node scripts/check-syntax.mjs` → 2225 archivos OK.
- `npm run typecheck` (web/) → PASS.
- `node doctor.mjs --json`, `node scripts/scheduler-status.mjs`, `node update-system.mjs check` (up-to-date) → OK.
- Antes (sesión 7): `apply-scope` fallaba 1/8, `same-job-write-dedup` 5/8, `liveness-record-expired` 1/21, `scan-recheck-policy-siblings` 1 fail — todo green ahora.

### Pendiente (continuación en nueva sesión) — sin cambios

1. **Aplicación real asistida** — ✅ DONE (sesión 6).
2. **Mejorar calidad de evaluación automática** — ✅ DONE (sesión 9): `auto-run.mjs` pasa `--with-llm` a `evaluate-url` en cola; `evaluate-url` loguea `✅ Bloques A–G promovidos a confiables` cuando `agPromotion.met`.
3. **Cola auto-run grande** — ✅ REPARADA (sesión 9): root cause EACCES en `data/auto-queue.json` (root-owned); validación: 199→175 pendientes, 24 completed. Ver "Estado de la sesión 9".
4. **Trazabilidad** — ✅ IMPLEMENTADO (sesión 9): notas duraderas en tracker/notes de `/apply`, `/sent`, `/notsent`.
5. **Quizás retro** — ✅ VALIDADO (sesión 9): re-ejecutados tests apply-assist + telegram (verificación final).

## Estado de la sesión 9 (2026-11-22)

### Ítem 3 — Cola auto-run grande — ✅ REPARADO + VALIDADO

- **Root cause:** `data/auto-queue.json` era propiedad de root; auto-run corre como wagner → `saveQueue` fallaba: log "⚠ No se pudo guardar cola ... EACCES: permission denied". La cola nunca se guardaba: log de la última run decía "170 restantes" pero el archivo quedaba con 199 desde 2026-11-21.
- **Fix:** `mv data/auto-queue.json.tmp data/auto-queue.json` — recupera la copia normalizada (propiedad wagner). Ahora `saveQueue` escribe sin EACCES.
- **Validación:**
  - `node scripts/auto-run.mjs --queue-only --queue-limit 0` → sin warning de guardado; mtime del archivo actualizado; `pending: 199`.
  - `node scripts/auto-run.mjs --queue-only --queue-limit 5` → "5 ejecutadas, 5 OK, 19 omitidas (ya evaluadas), 175 restantes"; cola persistida: `pending: 175, completed: 24, failed: 0`.
  - `node scripts/scheduler-status.mjs` → antes del fix crasheaba (`t.created` undefined en entradas normalizadas) — arreglado en scripts/scheduler-status.mjs:42.
- **Revisión de priorización/cadencia:** drain actual ≈ 10/run (límite 10/6h). Con ~175 pendientes ≈ 18 runs ≈ 5 días (sin nuevas adiciones). Patrón por run: 19 omitidos "ya evaluadas" (sentinels `NNN-RESERVED.md`) + hasta 10 reales.
  - Opciones a considerar: subir `--queue-limit` (ej. 30/6h ≈ +200/día); o aceptar el ritmo actual.

### Ítem 4 — Trazabilidad Telegram — ✅ IMPLEMENTADO

- `/apply N` → nota duradera en tracker/notes: `telegram-draft: prepared {day} report=N manifest=output/applications/N/manifest.json status=draft-only` (set-status idempotente, append "; "); fallo registrado via `err()`.
- `/sent N` → `trackerDecision('telegram', verified, day)`: verificado → `Applied` + `human-send: sent {day} source=telegram verified-manifest`; sin evidencia → `Evaluated` + `human-send: reported-sent-unverified {day} source=telegram`.
- `/notsent N` → `human-send: not-sent {day} source=telegram`.
- Observación: el tracker tenía 0 notas de "telegram"/0 "human-send" (nunca duraderas) — con estos cambios el registro es duradero. Evidencia de trazabilidad del CLI/web sigue en manifests de `output/applications/` (lib/apply-trace.mjs).

### Ítem 2 — Calidad de evaluación automática — ✅ WIREADO

- `scripts/auto-run.mjs` processQueue: tareas `evaluate` pasan `--with-llm` a `scripts/evaluate-url.mjs` cuando `CAREER_OPS_EVAL_LLM=1` (paridad con step 2 de main()).
- `scripts/evaluate-url.mjs`: al promocionar bloques A–G confiables (criterion `AG_CRITERION`) loguea `✅ Bloques A–G promovidos a confiables: {company} — {role} (score X, legitimidad Y)`; JSON de salida exponía ya `agPromotion`.

### Ítem 5 — Quizás retro — ✅ VALIDADO (sin cambios)

- No hubo correcciones de usuario esta sesión. Tests de apply-assist (6/6) y telegram-bot-apply-assist (1/1) re-ejecutados en verificación final.

### Próximos pasos sugeridos (opcionales)

1. Subir `--queue-limit` (ej. 30/6h) y editar `config/career-ops-scan.timer`/crontab según cómo quiera el backlog drain. — ✅ HECHO (sesión 10, commit `9fd77b1e`, merge a `main`, worktree eliminado)
2. `node scripts/scheduler-status.mjs` periódicamente; re-lanzar `--queue-only` para validar drains. — ✅ re-lanzado (sesión 10); validación periódica operativa: timer cada 6h
3. Quizás: backfill — marcar rows que ya tienen `telegram-draft`-relevant history si se descubre en la auditoría de tracker. — ✅ audí: 0 matches en `data/applications.md` → nada que backfill

---

## Estado de la sesión 10 (2026-11-22)

### Cola auto-run + drains — ✅ COMPLETADOS (commit `9fd77b1e` en `main`)

- **Sube default de `--queue-limit` a 30** (handoff sesión 9 sugería 30/6h): worktree `queue-limit-30` → commit `9fd77b1e` → mergeado a `main`; worktree y rama eliminados.
- **Validación de drains** (`node scripts/auto-run.mjs --queue-only` en `main`): 30 ejecutadas, 30 OK, 0 reintentadas, 0 carta(s) muerta(s), 6 omitidas ("ya evaluadas"), 98 restantes. Cola: **165 → 98 pendientes** (`node scripts/scheduler-status.mjs` → "Pendientes: 98").
- **Backfill trazabilidad**: auditoría de `data/applications.md` → 0 notas de `telegram-draft`/`human-send`/`draft prepared` → nada que backfill sin actividad reciente.
- Estado final: `main` @ `9fd77b1e`, `git status` limpio.

## Estado de la sesión 11 (2026-11-22)

### Regresión/higiene del turno — ✅ COMPLETADOS

- `node doctor.mjs --json` → sin onboarding, sin faltantes (warning pre-existente del cv.md sin `### Company — Location` — advisory; archivo user-layer — sin tocar).
- `node update-system.mjs check` → up-to-date (`1.40.0`). Nada que reportar.
- `node scripts/check-syntax.mjs` → 2225 archivos OK.
- `node --test tests/openrouter-runner-validation.test.mjs` → 28/28 PASS.
  - El test `callOpenRouter immediately halts when free-models-per-day quota is hit` era de comportamiento viejo (abortaba en el primer 429). Renombrado a `callOpenRouter tries every free model when free-models-per-day quota is hit, then throws QuotaExhaustedError` con `modelAttempts === 3`.
  - Agregado nuevo test `callOpenRouter rotates to the next free model when one hits quota exhaustion`: primer modelo quota-fails → segundo éxito; `attempted === ['google/model-a:free', 'qwen/model-b:free']`.
- `node --test tests/openrouter-runner-429-reset.test.mjs tests/telegram-bot-apply-assist.test.mjs` → 6/6 PASS.
- `node scripts/scheduler-status.mjs` → re-lanzado; validación periódica operativa sigue en el timer de 6h.

### Pendiente (continuación en sesión nueva) — sin cambios

1. **Commit de sesión 12** — cambios sin commitear: `openrouter-runner.mjs`, `automation/career-triage`, `HANDOFF.md` (sesión 12 continuó los ítems de sesión 11: commit de sesión 11 ya hecho en `186ddc5e`).
2. **Confirmar `git status` limpio** antes de declarar fin de sesión — sesión 12 no limpia por el ítem 1.

### Ítems "por discutir — sesión nueva" — todos implementados (sesión 12)

1) `modelIndex` no persiste entre runs — ✅ implementado: `openrouter-runner.mjs` carga `modelIndex` de `data/model-index.json` al importar y lo guarda (`saveModelIndex`) en el éxito de la rotación. Verificación manual: data root temporal, `data/model-index.json` = `{index: 1}` → el siguiente run deja el primer pick en `b:free` (active[1]).
2) Blacklist a mitad del bucle re-aparece por `active` fijo — ✅ implementado: `excludeFromActive(model)` + `attempt--` en los paths de blacklist (403 y 429 auto-blacklist); loop top con `if (active.length === 0) break;`; `active` ahora `let`. Verificación manual: `a:free` → 403 → SKIP blacklisted → picker rota a `b:free` (el sucesor); `a:free` no se vuelve a intentar (attempts: 0).
3) Triage (`career-triage`): un solo intento de `opencode run` sin reintentos — ✅ restructureado el tail con un comentario explícito de single-attempt + fallo inmediato. El pinned model rota por diseño — ✅ implementado: el catch del pinned path del openrouter-runner (CAREER_OPS_MODEL) ya no lanza; loguea `FAILED (...) — pinned model unavailable, rotating to free models` y cae al rotation free-model.

## Estado de la sesión 12 (2026-11-22)

### Sesión 12 — ✅ MISMAS MEJORAS DE ROTACIÓN IMPLEMENTADAS (sin commitear)

- **1) Persistencia de `modelIndex`** (`openrouter-runner.mjs`): `data/model-index.json` (`loadPersistedModelIndex`/`saveModelIndex`); `modelIndex = loadPersistedModelIndex()` al cargar el módulo; guardado en el éxito de la rotación (`saveModelIndex(modelIndex)` después de `modelIndex = (modelIndex + attempt + 1) % active.length`). Verificación manual (`/tmp/opencode/mi-load.mjs`, `mi-verify.mjs`): `{index: 1}` persistido → siguiente run del modelo — first pick `b:free`; fallo de un modelo y rotación a su sucesor sin reintentarlo.
- **2) Exclusión de blacklist a mitad de bucle** (`openrouter-runner.mjs`): `excludeFromActive(model)` (splice en `active`) + `attempt--` en los paths de blacklist (403 y 429 auto-blacklist ≥3); guard `if (active.length === 0) break;` al inicio del loop; `active` pasó a `let`. Verificación manual: `a:free` 403 → SKIP blacklisted → pick `b:free` (sucesor); `a:free` attempts 0.
- **3a) Triage single attempt** (`automation/career-triage`): comentario explícito de single-attempt + fallo inmediato (`exit 1`); sin bucles de reintentos.
- **3b) Pinned model rota por diseño** (`openrouter-runner.mjs`): el catch del pinned path (CAREER_OPS_MODEL) ya no lanza; loguea `FAILED (${e.message}) — pinned model unavailable, rotating to free models` y cae al rotation free-model.
- **Regresión/higiene del turno** — ✅ COMPLETADOS:
  - `node --check openrouter-runner.mjs` y `bash -n automation/career-triage` OK.
  - `node scripts/check-syntax.mjs` → 2225 archivos OK.
  - Suites: `openrouter-runner-validation` 28/28; `openrouter-runner-429-reset` + `telegram-bot-apply-assist` 6/6; `openrouter-no-tools-prompt` + `openrouter-wait-for-jd` + `openrouter-runner-data-root` + `user-layer-scripts-data-root` 33/33; `minimax-requests` + `openrouter-runner-model-timeout` + `openrouter-runner-exit-status` + `telegram-bot-apply-assist` (en batch) 37/37.
  - `node update-system.mjs check` → up-to-date (`1.40.0`).
  - `node doctor.mjs --json` → sin onboarding, sin faltantes (warning pre-existente del cv.md sin `### Company — Location` — advisory; archivo user-layer — sin tocar).
- `node scripts/scheduler-status.mjs` → validación periódica sigue en el timer de 6h.

### Pendiente (continuación en sesión nueva) — sin cambios

1. **Commit de sesión 12** — `git add openrouter-runner.mjs automation/career-triage HANDOFF.md` + commit. La sesión 6 pidió confirmar antes de commitear → summary final presentado acá; confirmar con el usuario antes de commitear.
2. **Confirmar `git status` limpio** antes de declarar fin de sesión.


