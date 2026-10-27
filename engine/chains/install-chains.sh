#!/bin/sh
# install and start the Base/BNB service as `pinr` on the server (a user unit; no sudo).
# Run once on first install. Later deploys restart it (ops/deploy-air.sh).
# Undo: systemctl --user disable --now pinr-chains.service
set -e
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$HOME/.config/systemd/user"
cp pinr-chains.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pinr-chains.service
systemctl --user status pinr-chains.service --no-pager | sed -n 1,4p
