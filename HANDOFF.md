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
