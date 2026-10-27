#!/usr/bin/env bash
# PINR checklist 15: a copy of the evidence store kept off the server each day, on the operator's Mac, so the
# 2013 Air failing loses nothing. Run on the Mac:
#   bash engine/ops/backup-evidence.sh            one copy now
#   bash engine/ops/backup-evidence.sh --install  daily at 04:30 (launchd)
# What it copies, into ~/PINR-backups/evidence (PINR_BACKUP_DIR to change it):
#   - the databases (scanner/scanner.sqlite: the evidence table, the gate, the scores; scanner/pools.sqlite): the server makes
#     a consistent copy with SQLite's own backup (a reader in WAL mode: the scanner keeps writing meanwhile), the Mac pulls
#     it, checks it (PRAGMA quick_check) and keeps it as daily/<UTC date>/<name>.sqlite.gz, one a day;
#   - the files the site and PINRai read (frontend-feed/, index/pinrbot/, index/relay-readings/): mirrored into mirror/;
#   - PINRads applications and their pictures: mirrored too.
# It never deletes anything, here or on the server (rsync without --delete; old days are kept: deleting data needs the
# operator's yes). It never copies a key, the .env, the settings file or the caches (index/solana_cache.sqlite is a cache).
# Its last result is in LAST-RUN.txt beside the copies; it stops LOUDLY at the first step that fails, after trying each
# copy from the server up to TRIES times (26 Oct: one "Connection reset by peer" lost the day's copy): a failure also leaves
# FAILED-<UTC date>.txt beside the copies. The day's folder is written under a temporary name (daily/.<date>.partial) and
# takes its date only when everything is copied and checked, so a dated folder is never empty.
set -Eeuo pipefail
AIR="${PINR_AIR:-user@your-server}"
KEY="${PINR_AIR_KEY:-$HOME/.ssh/pinr_server}"
ENGINE_REL="engine"
DEST="${PINR_BACKUP_DIR:-$HOME/PINR-backups/evidence}"
LABEL="io.pinr.backup-evidence"
DBS="scanner/scanner.sqlite scanner/pools.sqlite"
FOLDERS="frontend-feed index/pinrbot index/relay-readings"
TRIES="${PINR_BACKUP_TRIES:-4}"
WAIT="${PINR_BACKUP_WAIT:-30}"            # seconds before the second try, doubled each time after
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
STEP="starting"
trap '[ "${BASH_SUBSHELL:-0}" = 0 ] && { echo "BACKUP FAILED at: $STEP" >&2; echo "$(date -u +%FT%TZ) FAILED at: $STEP" > "$DEST/LAST-RUN.txt" 2>/dev/null || true; echo "$(date -u +%FT%TZ) FAILED at: $STEP (see backup.log)" > "$DEST/FAILED-$(date -u +%F).txt" 2>/dev/null || true; }' ERR
step() { STEP="$1"; echo "== $1"; }
air() { ssh -i "$KEY" $SSH_OPTS "$AIR" "$@"; }
retry() {                                                    # the command, up to TRIES times; each failure said, then a wait
  local n=1 w="$WAIT"
  while true; do
    "$@" && return 0
    [ "$n" -ge "$TRIES" ] && { echo "failed $n times: $*" >&2; return 1; }
    echo "try $n failed; trying again in ${w}s" >&2
    sleep "$w"; n=$((n + 1)); w=$((w * 2))
  done
}
pull() { rsync -a -z --partial --timeout=120 "$@"; }         # --partial: a retried copy carries on from where it broke;
                                                             # --timeout: a link that goes silent ends the try (26 Oct: one hung 4 h)

if [ "${1:-}" = "--install" ]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/backup-evidence.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$DEST/backup.log</string>
  <key>StandardErrorPath</key><string>$DEST/backup.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed: $LABEL runs $HERE/backup-evidence.sh daily at 04:30 (a missed run happens at the next wake); log $DEST/backup.log"
  exit 0
fi
[ -z "${1:-}" ] || { echo "unknown option: $1 (use --install, or nothing)" >&2; exit 2; }

DAY="$(date -u +%F)"
WORK="$DEST/daily/.$DAY.partial"                              # the day's folder until everything is copied and checked
mkdir -p "$DEST/db-latest" "$WORK" "$DEST/mirror"
[ -d "$DEST/daily/$DAY" ] && cp -p "$DEST/daily/$DAY"/*.gz "$WORK"/ 2>/dev/null || true   # a day already kept: its copies stay first
echo "$(date -u +%FT%TZ) backup of the evidence store from $AIR into $DEST"

step "1. the server: a consistent copy of each database"
snapshot() { air "bash -s" <<EOF
set -euo pipefail
mkdir -p ~/pinr-backup
cd ~/pinr/$ENGINE_REL
for db in $DBS; do
  n=\$(basename \$db)
  sqlite3 "\$db" ".timeout 60000" ".backup '\$HOME/pinr-backup/\$n.tmp'"
  mv "\$HOME/pinr-backup/\$n.tmp" "\$HOME/pinr-backup/\$n"
  echo "\$n \$(stat -c %s "\$HOME/pinr-backup/\$n") bytes"
done
EOF
}
retry snapshot                                               # each try sends the script afresh

step "2. the databases to the Mac, checked"
for db in $DBS; do
  n="$(basename "$db")"
  retry pull -e "ssh -i $KEY $SSH_OPTS" "$AIR:pinr-backup/$n" "$DEST/db-latest/$n"
  ok="$(sqlite3 "$DEST/db-latest/$n" "PRAGMA quick_check" | head -1)"
  [ "$ok" = "ok" ] || { echo "$n failed its check: $ok" >&2; false; }
  if [ ! -s "$WORK/$n.gz" ]; then
    gzip -c "$DEST/db-latest/$n" > "$WORK/$n.gz.tmp" && mv "$WORK/$n.gz.tmp" "$WORK/$n.gz"
  fi
  echo "$n checked ok; kept as daily/$DAY/$n.gz"
done
ROWS="$(sqlite3 "$DEST/db-latest/scanner.sqlite" "SELECT COUNT(*) FROM evidence")"

step "3. the files the site and PINRai read"
for f in $FOLDERS; do
  mkdir -p "$DEST/mirror/$f"
  retry pull --exclude '*.tmp' --exclude '.claude/' -e "ssh -i $KEY $SSH_OPTS" "$AIR:pinr/$ENGINE_REL/$f/" "$DEST/mirror/$f/"
done

step "4. PINRads applications, when there are any"
if retry air "test -d ~/pinr/pinr-live/.data/ads"; then             # the site's site writes them there (git-ignored, never served); kept here
  mkdir -p "$DEST/mirror/pinrads"
  retry pull --exclude '*.tmp' -e "ssh -i $KEY $SSH_OPTS" "$AIR:pinr/pinr-live/.data/ads/" "$DEST/mirror/pinrads/"
else
  echo "none yet"
fi

step "5. the day's folder takes its date"
[ -s "$WORK/scanner.sqlite.gz" ] && [ -s "$WORK/pools.sqlite.gz" ] || { echo "the day's copies are not all there" >&2; false; }
if [ -d "$DEST/daily/$DAY" ]; then                            # an earlier run (or an empty folder an older version left) holds the date
  cp -p "$WORK"/*.gz "$DEST/daily/$DAY"/ && rm -rf "$WORK"    # this run's own temporary folder only
else
  mv "$WORK" "$DEST/daily/$DAY"
fi
rm -f "$DEST/FAILED-$DAY.txt"                                  # this run's own failure note, written by an earlier failed try today
trap - ERR
SIZE="$(du -sh "$DEST" | cut -f1)"
echo "$(date -u +%FT%TZ) OK: databases checked, $ROWS evidence rows, kept as daily/$DAY; files mirrored; $SIZE in all" | tee "$DEST/LAST-RUN.txt"
