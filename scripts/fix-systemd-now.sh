#!/usr/bin/env bash
# Corrige definitamente career-ops-scan.service con User=wagner y ruta de node.
# Ejecutar: bash scripts/fix-systemd-now.sh   (sin sudo, él pide sudo internamente)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"

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

SVC_DST="/etc/systemd/system/career-ops-scan.service"

# Escribir directamente el archivo instalado con sudo tee
echo "==> Escribiendo servicio en $SVC_DST (con User=$USER_NAME)..."
sudo tee "$SVC_DST" > /dev/null <<EOF
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

# También copiar el timer
echo "==> Copiando timer..."
sudo cp "$REPO_DIR/config/career-ops-scan.timer" /etc/systemd/system/career-ops-scan.timer

echo "==> Recargando systemd..."
sudo systemctl daemon-reload

echo "==> Deteniendo servicio anterior si existe..."
sudo systemctl stop career-ops-scan.service 2>/dev/null || true

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
