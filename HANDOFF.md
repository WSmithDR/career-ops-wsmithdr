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

## Estado de la sesión (2026-11-22)

- ✅ **#1 Robustez `apply-assist.mjs`**: commiteado en `689525b2`. Iframes mismos-origen, widgets React-select con teclado real y re-detección, checkboxes/radios legales sin auto-check, barrido iterativo de requeridos por paso (estilo Workday), re-chequeo de seguridad justo antes del click. Sintaxis OK, tests 6/6 pasan.
- ✅ **#4 Calidad evaluación automática**: commiteado en `8064ac44`. `--with-llm` / `CAREER_OPS_EVAL_LLM=1` con fallback a heurística, guard de costo/rate-limit, criterio de promoción a Blocks A-G confiables, `--summary` JSON. Default sin cambios.
- ✅ **#5 Backlog cola 199**: commiteado en `a9c2989c`. `--queue-only` salta scan/eval/merge/notify; `--queue-limit N` cap real por run; reintentos (máx 3) con `nextAttemptAt`; dead-letter para items que agotan reintentos; `--max-cost` y `costSoFar`; resumen de run. Fix de import `readdirSync`.
- ✅ **Trazabilidad canónica manifest↔tracker**: commiteado en `a60ca696`. Módulo `lib/apply-trace.mjs` con contrato único (`source: telegram|cli|web|unknown`, timestamp, draftPrepared/confirmed/submittedByHuman/submittedAt/finalUrl, timeline). `apply-assist` usa source='cli'; bot Telegram usa source='telegram' y `/sent` marca `Applied` solo con `isVerifiedSubmit()`, si no queda `Evaluated`. Tests 6/6 + bot test pasan.

## Pendiente para próxima sesión (continuar aquí)

1. **Integración web UI apply asistido**: exponer flujo equivalente al CLI con misma regla no-auto-submit y confirmación explícita visible; sin envío oculto. Reusar `lib/apply-trace.mjs` (source='web') y `apply-scope.mjs`.
2. **Regresión / higiene**: correr suites apply/web/automation más amplias antes de commit. No incluir artefactos/data no relacionados en el commit.
