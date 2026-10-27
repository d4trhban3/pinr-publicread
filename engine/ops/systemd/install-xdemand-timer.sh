#!/bin/sh
# switch the X check on demand on, as `pinr` on the server. Run ONLY after the operator has typed the yes in
# the team chat, `x_demand` is "on" and his small daily dollar cap is in scanner/settings.json (`x_demand_daily_dollar_cap`).
# No sudo: a user timer. The daily timer (pinr-xscan) stays off.
# Undo: systemctl --user disable --now pinr-xdemand.timer
set -e
cd "$(dirname "$0")"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$HOME/.config/systemd/user"
cp pinr-xdemand.service pinr-xdemand.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now pinr-xdemand.timer
systemctl --user list-timers pinr-xdemand.timer --no-pager
