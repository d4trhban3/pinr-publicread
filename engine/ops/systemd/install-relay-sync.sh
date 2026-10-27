#!/bin/sh
# switch the relay readings sync on, as `pinr` on the server. Run ONLY after the operator has typed the yes in
# the team chat. Free (no API call); no sudo: a user timer. Undo: systemctl --user disable --now pinr-relay-sync.timer
set -e
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$HOME/.config/systemd/user"
cp pinr-relay-sync.service pinr-relay-sync.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pinr-relay-sync.timer
systemctl --user list-timers pinr-relay-sync.timer --no-pager
