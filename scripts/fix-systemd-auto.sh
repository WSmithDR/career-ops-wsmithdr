#!/usr/bin/env bash
# Encuentra node automáticamente (incluso con sudo) y instala el timer de systemd.
# Ejecutar: sudo bash scripts/fix-systemd-auto.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Buscar node en todas las ubicaciones comunes ──────────────────────
NODE_PATH=""
for cand in \
  "$(command -v node 2>/dev/null || true)" \
  "$HOME/.nvm/versions/node/*/bin/node" \
  /usr/bin/node \
  /usr/local/bin/node \
  /opt/node/bin/node \
; do
  if [ -n "$cand" ] && [ -x "$cand" ] 2>/dev/null; then
    NODE_PATH="$cand"
    break
  fi
done

# Si sigue vacío, probar con ls en nvm
if [ -z "$NODE_PATH" ]; then
  NODE_PATH="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  echo "ERROR: No se encontró node en ninguna ubicación común."
  echo "Intenta ejecutar: which node"
  exit 1
fi

echo "==> Node encontrado en: $NODE_PATH"

SVC_SRC="$REPO_DIR/config/career-ops-scan.service"

# ── Escribir el servicio con la ruta absoluta de node ─────────────────
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
sudo cp "$SVC_SRC" "/etc/systemd/system/career-ops-scan.service"
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
