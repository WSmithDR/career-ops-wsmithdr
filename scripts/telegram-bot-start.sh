#!/usr/bin/env bash
# scripts/telegram-bot-start.sh — Inicia/detiene el bot de Telegram de career-ops.
#
# Uso:
#   ./scripts/telegram-bot-start.sh start   # lanza el bot en segundo plano (nohup)
#   ./scripts/telegram-bot-start.sh stop    # detiene el bot
#   ./scripts/telegram-bot-start.sh status  # ve si está corriendo
#   ./scripts/telegram-bot-start.sh logs    # ve los últimos logs
#
# Antes de la primera vez, edita config/telegram.env con tu token y chat_id.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/data/automation/telegram-bot.pid"
LOG_FILE="$ROOT_DIR/data/automation/telegram-bot.log"
ENV_FILE="$ROOT_DIR/config/telegram.env"
BOT_SCRIPT="$ROOT_DIR/scripts/telegram-bot.mjs"

# Cargar variables de entorno si existen
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

NVM_NODE_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$NVM_NODE_BIN" ]] && [[ ":$PATH:" != *":$NVM_NODE_BIN:"* ]]; then
  export PATH="$NVM_NODE_BIN:$PATH"
fi

case "${1:-}" in
  start)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "El bot ya está corriendo (PID $(cat "$PID_FILE"))."
      exit 0
    fi

    if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
      echo "Error: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID no están definidos."
      echo "  Edita $ENV_FILE o exporta las variables antes de iniciar."
      exit 1
    fi

    mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
    setsid nohup node "$BOT_SCRIPT" >> "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    echo "Bot iniciado (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
    ;;

  stop)
    if [[ ! -f "$PID_FILE" ]]; then
      echo "No hay PID guardado. El bot no parece estar corriendo."
      exit 0
    fi
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "Bot detenido (PID $PID)."
    else
      echo "El bot (PID $PID) ya no estaba corriendo."
    fi
    rm -f "$PID_FILE"
    ;;

  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Bot corriendo (PID $(cat "$PID_FILE"))."
    else
      echo "Bot detenido."
    fi
    ;;

  logs)
    if [[ -f "$LOG_FILE" ]]; then
      tail -n 50 "$LOG_FILE"
    else
      echo "Aún no hay logs."
    fi
    ;;

  *)
    echo "Uso: $0 {start|stop|status|logs}"
    ;;
esac
