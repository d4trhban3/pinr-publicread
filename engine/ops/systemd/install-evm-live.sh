#!/bin/sh
# The operator's order, 26 Oct: install and start the BNB and Base live readers as `pinr` on the server (user units; no sudo),
# once, after the merge; deploy-air.sh restarts them after that. Undo: systemctl --user disable --now pinr-bnblive pinr-baselive
set -e
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$HOME/.config/systemd/user"
cp pinr-bnblive.service pinr-baselive.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pinr-bnblive.service pinr-baselive.service
systemctl --user status pinr-bnblive.service pinr-baselive.service --no-pager | grep -E 'Loaded|Active'
