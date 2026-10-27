#!/bin/sh
# install and start the websocket trades service as `pinr` on the server (a user unit; no sudo).
# Under a design decision this runs on the team's PASS and the merge. Undo: systemctl --user disable --now pinr-trades.service
set -e
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$HOME/.config/systemd/user"
cp pinr-trades.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pinr-trades.service
systemctl --user status pinr-trades.service --no-pager | sed -n 1,4p
