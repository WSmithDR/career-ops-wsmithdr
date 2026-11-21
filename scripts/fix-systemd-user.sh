#!/usr/bin/env bash
# Corrige career-ops-scan.service para correr como el usuario wagner (no root).
# Ejecutar: bash scripts/fix-systemd-user.sh   (sin sudo, él pide sudo internamente)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"

# ── Encontrar node con el PATH del usuario ────────────────────────────
FOUND_NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$FOUND_NODE" ]; then
  FOUND_NODE="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$FOUND_NODE" ] || [ ! -x "$FOUND_NODE" ]; then
  echo "ERROR: No se encontró node. Ejecuta: which node"
  exit 1
fi
echo "==> Usuario: $USER_NAME"
echo "==> Node: $FOUND_NODE"

SVC_TMP="/tmp/career-ops-scan.service"

# ── Escribir el servicio con User=wagner y ruta absoluta de node ──────
cat > "$SVC_TMP" <<EOF
[Unit]
Description=career-ops automated job scanner
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
WorkingDirectory=$REPO_DIR
Environment=CAREER_OPS_ROOT=$REPO_DIR
ExecStart=$FOUND_NODE $REPO_DIR/scripts/auto-run.mjs
StandardOutput=append:$REPO_DIR/data/auto-run.log
StandardError=append:$REPO_DIR/data/auto-run-error.log

[Install]
WantedBy=multi-user.target
EOF

echo "==> Copiando servicio a /etc/systemd/system/ (necesita sudo)..."
sudo cp "$SVC_TMP" /etc/systemd/system/career-ops-scan.service
sudo cp "$REPO_DIR/config/career-ops-scan.timer" /etc/systemd/system/career-ops-scan.timer

echo "==> Recargando systemd..."
sudo systemctl daemon-reload

echo "==> Reiniciando el timer..."
sudo systemctl restart career-ops-scan.timer

echo
echo "==> Estado del timer:"
systemctl status career-ops-scan.timer --no-pager

echo
echo "==> Próximos disparos:"
systemctl list-timers career-ops-scan.timer --no-pager

echo
echo "==> Logs recientes del servicio:"
journalctl -u career-ops-scan.service --no-pager -n 5
