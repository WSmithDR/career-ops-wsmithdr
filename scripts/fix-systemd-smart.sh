#!/usr/bin/env bash
# Instala el timer de systemd de career-ops detectando node automáticamente.
# Ejecutar: bash scripts/fix-systemd-smart.sh   (sin sudo, él solo lo pide si hace falta)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Si ya somos root, usar NODE_PATH del environment ──────────────────
if [ "$EUID" -eq 0 ]; then
  NODE_PATH="${NODE_PATH:-}"
  if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
    echo "ERROR: NODE_PATH no definido al ejecutar como root."
    echo "Ejecuta sin sudo primero: bash scripts/fix-systemd-smart.sh"
    exit 1
  fi
else
  # ── No somos root: encontrar node con el PATH del usuario ──────────
  FOUND_NODE="$(command -v node 2>/dev/null || true)"
  if [ -z "$FOUND_NODE" ]; then
    FOUND_NODE="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  fi
  if [ -z "$FOUND_NODE" ] || [ ! -x "$FOUND_NODE" ]; then
    echo "ERROR: No se encontró node en tu PATH ni en ~/.nvm"
    echo "Ejecuta: which node"
    exit 1
  fi
  echo "==> Node encontrado en: $FOUND_NODE"
  echo "==> Re-ejecutando con sudo para instalar el timer..."
  sudo NODE_PATH="$FOUND_NODE" bash "$0" "$@"
  exit $?
fi

# ── Desde aquí somos root, NODE_PATH está definido ────────────────────
echo "==> Usando node en: $NODE_PATH"

SVC_SRC="$REPO_DIR/config/career-ops-scan.service"

cat > "$SVC_SRC" <<EOF
[Unit]
Description=career-ops automated job scanner
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
Environment=CAREER_OPS_ROOT=$REPO_DIR
ExecStart=$NODE_PATH $REPO_DIR/scripts/auto-run.mjs
StandardOutput=append:$REPO_DIR/data/auto-run.log
StandardError=append:$REPO_DIR/data/auto-run-error.log

[Install]
WantedBy=multi-user.target
EOF

echo "==> Copiando unidades de systemd..."
cp "$SVC_SRC" "/etc/systemd/system/career-ops-scan.service"
cp "$REPO_DIR/config/career-ops-scan.timer" /etc/systemd/system/career-ops-scan.timer

echo "==> Recargando systemd..."
systemctl daemon-reload

echo "==> Reiniciando el timer..."
systemctl restart career-ops-scan.timer

echo
echo "==> Estado del timer:"
systemctl status career-ops-scan.timer --no-pager

echo
echo "==> Próximos disparos:"
systemctl list-timers career-ops-scan.timer --no-pager

echo
echo "==> Logs recientes del servicio:"
journalctl -u career-ops-scan.service --no-pager -n 5
