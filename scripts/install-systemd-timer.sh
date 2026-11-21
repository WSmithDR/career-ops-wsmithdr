#!/usr/bin/env bash
# Instala el timer de systemd de career-ops (scan cada 6 horas).
# Requiere sudo. Ejecuta: bash scripts/install-systemd-timer.sh
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

echo "==> Habilitando e iniciando el timer..."
sudo systemctl enable --now career-ops-scan.timer

echo
echo "==> Listo. Verifica con:"
echo "   systemctl status career-ops-scan.timer --no-pager"
echo "   systemctl list-timers career-ops-scan.timer --no-pager"
echo "   journalctl -u career-ops-scan.service -f"
