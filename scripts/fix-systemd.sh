#!/usr/bin/env bash
# Arregla e instala el timer de systemd de career-ops.
# Ejecutar: sudo bash scripts/fix-systemd.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_SRC="$REPO_DIR/config/career-ops-scan.service"
TMR_SRC="$REPO_DIR/config/career-ops-scan.timer"
SVC_DST="/etc/systemd/system/career-ops-scan.service"
TMR_DST="/etc/systemd/system/career-ops-scan.timer"

echo "==> Copiando unidades de systemd..."
sudo cp "$SVC_SRC" "$SVC_DST"
sudo cp "$TMR_SRC" "$TMR_DST"

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
