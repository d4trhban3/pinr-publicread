#!/bin/sh
# switch the daily X scan on, as `pinr` on the server. Run ONLY after the operator has typed the yes and
# the daily dollar cap is set in scanner/settings.json (`x_api_daily_dollar_cap`). No sudo: a user timer.
# Undo: systemctl --user disable --now pinr-xscan.timer
set -e
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$HOME/.config/systemd/user"
cp pinr-xscan.service pinr-xscan.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pinr-xscan.timer
systemctl --user list-timers pinr-xscan.timer --no-pager
