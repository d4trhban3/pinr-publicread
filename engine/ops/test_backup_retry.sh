#!/usr/bin/env bash
# Checks ops/backup-evidence.sh against a link that breaks (line 15, 26 Oct: one "Connection reset by peer" lost the day's
# copy): the real script runs with stand-in ssh and rsync on its PATH, in a throwaway folder; nothing reaches the server.
# Run on the Mac:  bash ops/test_backup_retry.sh [path/to/backup-evidence.sh]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${1:-$HERE/backup-evidence.sh}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "  ok   $2"; else FAIL=$((FAIL + 1)); echo "  FAIL $2"; fi; }
DAY="$(date -u +%F)"
# a small real database to copy (the script checks it with PRAGMA quick_check and counts its evidence rows)
sqlite3 "$W/src.sqlite" "CREATE TABLE evidence (x); INSERT INTO evidence VALUES (1), (2);"

fake() {   # $1: how many rsync calls fail before they work (99: always)
  mkdir -p "$W/bin"; echo 0 > "$W/rsync.n"
  cat > "$W/bin/ssh" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null                                    # the script sent on stdin
case "$*" in *"test -d"*) exit 1 ;; esac           # no PINRads folder
echo "scanner.sqlite 100 bytes"; exit 0
EOF
  cat > "$W/bin/rsync" <<EOF
#!/usr/bin/env bash
n=\$(cat "$W/rsync.n"); echo \$((n + 1)) > "$W/rsync.n"; echo "\$*" >> "$W/rsync.args"
[ \$n -lt $1 ] && { echo "Connection reset by peer" >&2; exit 12; }
dst="\${@: -1}"
case "\$dst" in */) mkdir -p "\$dst" ;; *) cp "$W/src.sqlite" "\$dst" ;; esac
exit 0
EOF
  chmod +x "$W/bin/ssh" "$W/bin/rsync"
}
run() { PATH="$W/bin:$PATH" PINR_BACKUP_DIR="$W/dest" PINR_BACKUP_WAIT=0 PINR_BACKUP_TRIES=4 PINR_AIR_KEY=/dev/null bash "$SCRIPT" > "$W/out" 2>&1 < /dev/null; }
# (stdin from /dev/null: the stand-in ssh reads its stdin to the end, and a check runner's open pipe kept it waiting 900 s)

echo "a link that breaks twice, then holds"
rm -rf "$W/dest"; fake 2; run; rc=$?
ok $rc "the backup finishes ($(tail -1 "$W/out" | cut -c1-60))"
ok "$([ -s "$W/dest/daily/$DAY/scanner.sqlite.gz" ] && [ -s "$W/dest/daily/$DAY/pools.sqlite.gz" ] && echo 0 || echo 1)" "the day's folder holds both copies"
ok "$(ls -a "$W/dest/daily" | grep -q partial && echo 1 || echo 0)" "no temporary folder left"
ok "$(grep -q "^.*OK: databases checked" "$W/dest/LAST-RUN.txt" && echo 0 || echo 1)" "LAST-RUN says OK"
ok "$([ "$(grep -c "try . failed" "$W/out")" -ge 2 ] && echo 0 || echo 1)" "each failed try is said ($(grep -c "try . failed" "$W/out"))"
ok "$(grep -v -q -- "--timeout=" "$W/rsync.args" && echo 1 || echo 0)" "every copy gives up on a silent link (rsync --timeout)"

echo "a link that stays broken"
rm -rf "$W/dest"; fake 99; run; rc=$?
ok "$([ $rc != 0 ] && echo 0 || echo 1)" "the backup stops"
ok "$([ -e "$W/dest/daily/$DAY" ] && echo 1 || echo 0)" "no dated folder (never an empty one)"
ok "$(grep -q "FAILED at: 2. the databases" "$W/dest/LAST-RUN.txt" && [ -s "$W/dest/FAILED-$DAY.txt" ] && echo 0 || echo 1)" "LAST-RUN and FAILED-$DAY.txt say where it failed"
ok "$([ "$(cat "$W/rsync.n")" = 4 ] && echo 0 || echo 1)" "the copy was tried 4 times ($(cat "$W/rsync.n"))"
echo "test_backup_retry: $PASS/$((PASS + FAIL)) passed"
[ "$FAIL" = 0 ]
