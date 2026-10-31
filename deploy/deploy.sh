#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/unibox.service <<EOF
[Unit]
Description=unibox — inbox aggregator (web UI + worker + WhatsApp)
After=network-online.target

[Service]
WorkingDirectory=$PWD
ExecStart=$(command -v node || echo "$HOME/.local/share/mise/installs/node/26.8.1/bin/node") $PWD/node_modules/tsx/dist/cli.mjs src/index.ts serve
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now unibox.service
sleep 2
systemctl --user --no-pager --lines=3 status unibox.service || true
echo "→ http://127.0.0.1:8124"
