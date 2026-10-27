#!/usr/bin/env bash
# PINR: deploy main to the server in one command.
# Run on the Mac from the project:  bash engine/ops/deploy-air.sh [--dry-run] [--all]
#   --dry-run  show what would change and restart; change nothing
#   --all      restart every service, whatever changed
# What it does, and it stops LOUDLY at the first step that fails (nothing after it runs):
#   1. checks: origin is the private copy; local main is pushed (deploys only what GitHub has)
#   2. the server: backs up its private settings, fast-forwards to origin/main, puts back its own settings values except the
#      provider list (the repo's, by rule), re-marks the settings file as the server's own; the live settings file is
#      replaced in one rename and never holds the repo's values (the old swap stopped pinr-sqdlive at every deploy)
#   3. installs only what changed: control/ and imagehash/ packages; the site (npm ci + build) when pinr-live/ changed
#   4. restarts only what changed: engine Python or settings -> pinr-scanner (and the Mac workers are stopped first);
#      control/ -> pinr-control; livews/ -> pinr-trades; pinr-live/ -> one pinr-feed restart; chains/ or engine Python ->
#      pinr-chains (CHAINS, 249: it imports the scanner's gate, evidence and quiet code), once its unit is installed
#      (chains/install-chains.sh, run once)
#   5. checks: every restarted service is active; the server's and the Mac's engine stamps match; no "database is locked"
#      in the scanner's log since the restart
# One deploy at a time (two overlapped on 2026-10-25): a lock folder on the server, taken before anything
# changes and given back at the end, failed or not; a lock older than LOCK_STALE_MIN minutes is said and taken over.
# It never prints or copies a key; it never touches the server's .env.
set -Eeuo pipefail                                         # -E: the ERR trap also fires inside functions

AIR="${PINR_AIR:-user@your-server}"
KEY="${PINR_AIR_KEY:-$HOME/.ssh/pinr_server}"
ENGINE_REL="engine"
AIR_ROOT="~/pinr"
MAC_ROOT="${PINR_MAC_WORKER:-$HOME/pinr-worker}"
MAC_WORKERS="${PINR_MAC_WORKERS:-12}"                     # scoring workers started again on the Mac after an engine change
MAC_WAS=0                                                 # how many were running before the deploy stopped them
DRY=0; ALL=0; SITE_NOW=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --all) ALL=1 ;;
    --site-now) SITE_NOW=1 ;;
    *) echo "unknown option: $a (use --dry-run, --all or --site-now)" >&2; exit 2 ;;
  esac
done

STEP="starting"
LOCK="~/pinr-deploy.lock"; LOCK_STALE_MIN=30; HELD=0
# the team's W1 on 06b71f88: said once, by this shell (with -E the trap also runs in each command substitution)
trap '[ "${BASH_SUBSHELL:-0}" = 0 ] && { echo; echo "DEPLOY FAILED at: $STEP (nothing after this step ran)" >&2;
  [ "$MAC_WAS" = 0 ] || echo "The Mac workers were stopped: start them again once the server is right (cd $MAC_ROOT/$ENGINE_REL && caffeinate -i python3 scanner/mac_worker.py $MAC_WORKERS)" >&2; }' ERR
# the team's W2 on 06b71f88: give back only our own lock (one a later run took over after 30 minutes is that run's)
release() { if [ "$HELD" = 1 ]; then air "grep -qxF '$WHO' $LOCK/who 2>/dev/null && rm -rf $LOCK || true" || echo "could not give back the deploy lock on the server ($LOCK)" >&2; fi; }
trap release EXIT
step() { STEP="$1"; echo "== $1"; }
air() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$AIR" "$@"; }

step "1. the private copy and a pushed main"
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
ORIGIN="$(git remote get-url origin)"
case "$ORIGIN" in
  *"github.com/<owner>/<private-repo>"*) ;;
  *) echo "origin is $ORIGIN, not the private copy" >&2; false ;;
esac
git fetch -q origin
[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ] || { echo "local main is not the same as origin/main: push (or pull) first" >&2; false; }
NEW="$(git rev-parse origin/main)"
WHO="$(whoami)@$(hostname -s) $(date -u +%Y-%m-%dT%H:%M:%SZ) ${NEW:0:8} pid $$"
if [ "$DRY" = 1 ]; then
  air "cat $LOCK/who 2>/dev/null" | sed 's/^/a deploy is running now: /' || true
else
  step "the deploy lock on the server"
  GOT="$(air "if mkdir $LOCK 2>/dev/null; then echo '$WHO' > $LOCK/who; echo taken
    elif [ -n \"\$(find $LOCK -maxdepth 0 -mmin +$LOCK_STALE_MIN)\" ]; then echo \"stale: \$(cat $LOCK/who 2>/dev/null)\"; rm -rf $LOCK; mkdir $LOCK && echo '$WHO' > $LOCK/who && echo taken
    else echo \"held: \$(cat $LOCK/who 2>/dev/null)\"; fi")"
  [ -n "$GOT" ] || { echo "could not reach the server to take the deploy lock" >&2; false; }
  case "$GOT" in
    *taken) HELD=1; printf '%s\n' "$GOT" | grep '^stale' | sed 's/^/took over a lock older than '"$LOCK_STALE_MIN"' minutes: /' || true; echo "lock taken" ;;
    *) echo "another deploy is running (${GOT#held: }): wait for it, then run again" >&2; false ;;
  esac
fi
step "the server's commit"
OLD="$(air "cd $AIR_ROOT && git rev-parse HEAD")"
echo "Air at ${OLD:0:8}, origin/main at ${NEW:0:8}"
if [ "$OLD" = "$NEW" ] && [ "$ALL" = 0 ]; then echo "nothing to deploy"; exit 0; fi
git merge-base --is-ancestor "$OLD" "$NEW" || { echo "the server's commit is not an ancestor of origin/main (it would not fast-forward)" >&2; false; }

CHANGED="$(git diff --name-only "$OLD" "$NEW")"
has() { [ "$ALL" = 1 ] || grep -qE "$1" <<<"$CHANGED"; }   # no pipe: grep -q stops at its first match, and with pipefail a long list's
                                                       # printf then dies of SIGPIPE and the match read as none (2026-10-26: chains missed)
ENGINE_PY="^$ENGINE_REL/(scanner|stage2|stage3|stage4|feed|pinr-score)/.*\.py$|^$ENGINE_REL/scanner/settings\.json$|^$ENGINE_REL/control/routing-catalog\.json$"
R_SCANNER=0; R_CONTROL=0; R_TRADES=0; R_SITE=0; R_CHAINS=0; R_SQDLIVE=0; R_WSLOGS=0; R_EVMLIVE=0; CI_CONTROL=0; CI_IMAGEHASH=0
has "$ENGINE_PY" && R_SCANNER=1
has "^$ENGINE_REL/chains/" && R_CHAINS=1
[ "$R_SCANNER" = 1 ] && R_CHAINS=1
{ [ "$R_SCANNER" = 1 ] || has "^$ENGINE_REL/stage2/idl/"; } && R_SQDLIVE=1   # 257: pinr-sqdlive runs scanner/sqd*.py with the IDLs
{ [ "$R_CHAINS" = 1 ] || [ "$R_SQDLIVE" = 1 ]; } && R_EVMLIVE=1   # the BNB and Base live readers run chains/*.py with sqd_live's pusher
has "^$ENGINE_REL/control/" && R_CONTROL=1
has "^$ENGINE_REL/control/package" && CI_CONTROL=1
has "^$ENGINE_REL/imagehash/package" && CI_IMAGEHASH=1
has "^$ENGINE_REL/livews/" && R_TRADES=1
{ [ "$R_TRADES" = 1 ] || has "^$ENGINE_REL/stage2/idl/"; } && R_WSLOGS=1   # 257: pinr-wslogs runs livews/logs.mjs with the IDLs
has "^pinr-live/" && R_SITE=1
# the team 2026-10-25: at most one pinr-feed restart an hour (each restart reloads the feed's whole state and stalls the
# site). A site change within the hour is held: not built, not restarted, marked pending on the server, and the first deploy
# after the hour builds and restarts it (`--site-now` overrides).
air "test -f ~/pinr-feed-pending" && R_SITE=1
if [ "$R_SITE" = 1 ] && [ "$SITE_NOW" != 1 ]; then
  LAST=$(air "cat ~/pinr-feed-restarted 2>/dev/null || echo 0"); NOW=$(date +%s)
  if [ $((NOW - LAST)) -lt 3600 ]; then
    R_SITE=0; [ "$DRY" = 1 ] || air "touch ~/pinr-feed-pending"
    echo "site held: pinr-feed last restarted $(( (NOW - LAST) / 60 )) min ago; deploy again after $(date -r $((LAST + 3600)) +%H:%M) (or --site-now)"
  fi
fi
[ "$ALL" = 1 ] && { CI_CONTROL=1; CI_IMAGEHASH=1; }
echo "files changed: $(printf '%s\n' "$CHANGED" | grep -c . || true)"
echo "plan: scanner=$R_SCANNER (and the Mac workers) control=$R_CONTROL trades=$R_TRADES chains=$R_CHAINS sqdlive=$R_SQDLIVE evmlive=$R_EVMLIVE wslogs=$R_WSLOGS site=$R_SITE; installs: control=$CI_CONTROL imagehash=$CI_IMAGEHASH"
if [ "$DRY" = 1 ]; then echo "dry run: nothing changed"; exit 0; fi

if [ "$R_SCANNER" = 1 ]; then
  step "the Mac workers stopped (engine code changes)"
  running() { { pgrep -f "scanner/mac_worker.py" || true; } | wc -l | tr -d ' '; }   # none running is an answer, not a failure
  MAC_WAS="$(running)"                                   # started again at the end only when they were running (checklist 4)
  pkill -INT -f "scanner/mac_worker.py" || true
  for _ in $(seq 1 30); do [ "$(running)" = 0 ] && break; sleep 1; done
  if [ "$(running)" != 0 ]; then                         # a worker that ignores Ctrl-C (one an earlier deploy started in the
    echo "Mac workers ignored the stop request for 30 s: ending them"   # background before set -m below): end it, said so
    pkill -TERM -f "scanner/mac_worker.py" || true
    for _ in $(seq 1 15); do [ "$(running)" = 0 ] && break; sleep 1; done
  fi
  [ "$(running)" = 0 ] || { echo "Mac workers still running after 45 s" >&2; false; }
fi

step "2. the server: fast-forward, its own settings kept"
air "set -Eeuo pipefail
  cd $AIR_ROOT
  E=$ENGINE_REL
  F=\$E/scanner/settings.json
  mkdir -p ~/settings-backups
  B=~/settings-backups/settings.\$(date -u +%Y%m%dT%H%M%S).\$\$.json   # the team F1: time and process: no later run overwrites it
  cp \$F \$B
  T=\$F.deploy.\$\$                                        # the merged settings, renamed over the live file in one step
  restore() { rm -f \$T.repo; git reset -q -- \$F || true; cp \$B \$T && mv -f \$T \$F; git update-index --skip-worktree \$F; echo \"step 2 failed on the server: its own settings put back from \$B\" >&2; }
  trap restore ERR                                       # any line below failing: the server's settings back, marked its own, then stop
  git fetch -q origin
  # The live file never holds the repo's values (they say sqd_live off: pinr-sqdlive stopped at every deploy, 25-26 Oct).
  # The merged file is made from the new commit's copy in git, the index entry is set to that copy so the fast-forward
  # leaves the live file alone, and the merged file is renamed over it in one step.
  git show $NEW:\$F > \$T.repo
  python3 - \$T.repo \$B \$T <<'PY'
import json, sys
new = json.load(open(sys.argv[1])); air = json.load(open(sys.argv[2]))
for k, v in air.items():
    if k in ('solana_providers', '_about_solana_providers'):
        continue                                   # the provider list is the repo's, by rule
    if new.get(k) != v:
        new[k] = v
with open(sys.argv[3], 'w') as out:
    json.dump(new, out, indent=2); out.write('\n')
PY
  rm -f \$T.repo
  git update-index --no-skip-worktree \$F
  git update-index --cacheinfo \"\$(git ls-tree $NEW -- \$F | awk '{print \$1\",\"\$3}'),\$F\"
  git merge -q --ff-only $NEW                              # the commit checked on the Mac, not a newer one pushed since (2026-10-25)
  mv -f \$T \$F
  git update-index --skip-worktree \$F
  [ \"\$(git rev-parse HEAD)\" = \"$NEW\" ]
  trap - ERR"

step "3. installs"
if [ "$CI_CONTROL" = 1 ]; then air "cd $AIR_ROOT/$ENGINE_REL/control && npm ci --silent >/dev/null"; echo "control packages installed"; fi
if [ "$CI_IMAGEHASH" = 1 ]; then air "cd $AIR_ROOT/$ENGINE_REL/imagehash && npm ci --silent >/dev/null"; echo "imagehash packages installed"; fi
if [ "$R_SITE" = 1 ]; then
  air "cd $AIR_ROOT/pinr-live && npm ci --silent >/dev/null && { npm run build >/tmp/pinr-build.log 2>&1 || { tail -20 /tmp/pinr-build.log; false; }; }"
  echo "site built"
fi

step "4. restarts"
LOG_LINES="$(air "wc -l < $AIR_ROOT/$ENGINE_REL/scanner/scanner.log")"
USER_CTL='XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user'
if [ "$R_SCANNER" = 1 ]; then air "sudo -n /usr/bin/systemctl restart pinr-scanner"; echo "pinr-scanner restarted"; fi
if [ "$R_CONTROL" = 1 ]; then air "$USER_CTL restart pinr-control"; echo "pinr-control restarted"; fi
if [ "$R_TRADES" = 1 ]; then   # 257: one writer a coin; the curve feed is switched off (disabled), never started again here
  if air "$USER_CTL is-enabled --quiet pinr-trades 2>/dev/null"; then air "$USER_CTL restart pinr-trades"; echo "pinr-trades restarted"
  else R_TRADES=0; echo "pinr-trades disabled (the logs feed and SQD write the coins): not restarted"; fi
fi
if [ "$R_CHAINS" = 1 ]; then
  if air "$USER_CTL is-enabled --quiet pinr-chains 2>/dev/null"; then air "$USER_CTL restart pinr-chains"; echo "pinr-chains restarted"
  else R_CHAINS=0; echo "pinr-chains not installed yet (chains/install-chains.sh, once): not restarted"; fi
fi
if [ "$R_SQDLIVE" = 1 ]; then
  if air "$USER_CTL is-enabled --quiet pinr-sqdlive 2>/dev/null"; then air "$USER_CTL restart pinr-sqdlive"; echo "pinr-sqdlive restarted"
  else R_SQDLIVE=0; echo "pinr-sqdlive not installed yet: not restarted"; fi
fi
if [ "$R_EVMLIVE" = 1 ]; then
  if air "$USER_CTL is-enabled --quiet pinr-bnblive 2>/dev/null"; then air "$USER_CTL restart pinr-bnblive pinr-baselive"; echo "pinr-bnblive and pinr-baselive restarted"
  else R_EVMLIVE=0; echo "pinr-bnblive and pinr-baselive not installed yet (ops/systemd/install-evm-live.sh, once): not restarted"; fi
fi
if [ "$R_WSLOGS" = 1 ]; then
  if air "$USER_CTL is-enabled --quiet pinr-wslogs 2>/dev/null"; then air "$USER_CTL restart pinr-wslogs"; echo "pinr-wslogs restarted"
  else R_WSLOGS=0; echo "pinr-wslogs not installed yet: not restarted"; fi
fi
if [ "$R_SITE" = 1 ]; then air "sudo -n /usr/bin/systemctl restart pinr-feed && date +%s > ~/pinr-feed-restarted && rm -f ~/pinr-feed-pending"; echo "pinr-feed restarted (once)"; fi
sleep 8

step "5. checks"
# Checklist 4 (2026-10-25: pinr-sqdlive crashed 2 s after its restart, systemd started it again 10 s later, and the one-look
# check stopped the deploy there): each restarted service must be active and keep the same process for 10 s, within 90 s;
# a restart systemd made meanwhile is said, not hidden.
settle() {   # settle <unit> <system|user>
  local ctl="systemctl"; [ "$2" = user ] && ctl="XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user"
  air "bash -s" <<EOF
u=$1; n0=\$($ctl show -p NRestarts --value \$u)
for _ in \$(seq 1 9); do
  p=\$($ctl show -p MainPID --value \$u)
  if $ctl is-active --quiet \$u && [ "\$p" != 0 ]; then
    sleep 10
    if $ctl is-active --quiet \$u && [ "\$($ctl show -p MainPID --value \$u)" = "\$p" ]; then
      n=\$($ctl show -p NRestarts --value \$u); extra=""; [ "\$n" = "\$n0" ] || extra=" (systemd restarted it \$((n - n0)) time(s) while settling)"
      echo "\$u active and steady\$extra"; exit 0
    fi
  else
    sleep 10
  fi
done
echo "\$u not steady after 90 s: \$($ctl is-active \$u)" >&2; exit 1
EOF
}
if [ "$R_SCANNER" = 1 ]; then settle pinr-scanner system; fi
if [ "$R_CONTROL" = 1 ]; then settle pinr-control user; fi
if [ "$R_TRADES" = 1 ]; then settle pinr-trades user; fi
if [ "$R_CHAINS" = 1 ]; then settle pinr-chains user; fi
if [ "$R_SQDLIVE" = 1 ]; then settle pinr-sqdlive user; fi
if [ "$R_EVMLIVE" = 1 ]; then settle pinr-bnblive user; settle pinr-baselive user; fi
if [ "$R_WSLOGS" = 1 ]; then settle pinr-wslogs user; fi
feed_up() { air "curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/health" 2>/dev/null | grep -q 200; }
wait_until() {                                               # wait_until <seconds> <every> <command...>: true once it succeeds in time
  local limit="$1" every="$2" start="$SECONDS"; shift 2
  while true; do
    "$@" && { WAITED=$((SECONDS - start)); return 0; }
    [ $((SECONDS - start)) -ge "$limit" ] && { WAITED=$((SECONDS - start)); return 1; }
    sleep "$every"
  done
}
if [ "$R_SITE" = 1 ]; then                                  # SITE's note (line 4): the feed can take over a minute after a site build
  wait_until "${FEED_WAIT_S:-180}" 5 feed_up || { echo "pinr-feed does not answer after its restart (waited ${WAITED}s)" >&2; false; }
  echo "pinr-feed answering (after ${WAITED}s)"
fi
STAMP_PY="import sys; sys.path[:0] = ['scanner', 'stage2', 'stage3']; import scanner; print(scanner.engine_stamp())"
AIR_STAMP="$(air "cd $AIR_ROOT/$ENGINE_REL && python3 -c \"$STAMP_PY\"")"
if [ -d "$MAC_ROOT/.git" ]; then
  step "the Mac worker copy: pull and stamp"
  git -C "$MAC_ROOT" fetch -q origin && git -C "$MAC_ROOT" merge -q --ff-only "$NEW"   # the same commit as the server
  MAC_STAMP="$(cd "$MAC_ROOT/$ENGINE_REL" && python3 -c "$STAMP_PY")"
  [ "$AIR_STAMP" = "$MAC_STAMP" ] || { echo "engine stamps differ: Air ${AIR_STAMP:0:12}, Mac ${MAC_STAMP:0:12}" >&2; false; }
  echo "engine stamp ${AIR_STAMP:0:12} on the server and the Mac"
fi
if [ "$R_SCANNER" = 1 ]; then
  sleep 30                                               # a scoring pass or two before the log is read
  step "the scanner's log since the restart"
  LOCKS="$(air "tail -n +$((LOG_LINES + 1)) $AIR_ROOT/$ENGINE_REL/scanner/scanner.log | grep -c 'database is locked' || true")"
  [ "${LOCKS:-0}" = 0 ] || { echo "database is locked x$LOCKS since the restart" >&2; false; }
  echo "no 'database is locked' since the restart"
fi
if [ "$MAC_WAS" != 0 ]; then                              # checklist 4: no hand step left after a deploy
  step "the Mac workers started again"
  # the whole subshell's output goes to the log and `exec` leaves no shell behind: with the redirect on the worker alone, the
  # backgrounded shell kept this script's output pipe open, so `deploy-air.sh | tail` never returned (2026-10-25, 235678a3)
  # job control on while it starts: a background command in a script otherwise ignores Ctrl-C, and the next deploy's stop
  # request (SIGINT) would not reach it (2026-10-25: "Mac workers still running after 30 s")
  set -m
  ( cd "$MAC_ROOT/$ENGINE_REL" && exec nohup caffeinate -i python3 scanner/mac_worker.py "$MAC_WORKERS" ) \
    >> "$MAC_ROOT/$ENGINE_REL/scanner/mac_worker.log" 2>&1 < /dev/null &
  set +m
  sleep 5
  [ "$(running)" != 0 ] || { echo "the Mac workers did not start: see $MAC_ROOT/$ENGINE_REL/scanner/mac_worker.log" >&2; false; }
  echo "Mac workers started again ($MAC_WORKERS workers; log $MAC_ROOT/$ENGINE_REL/scanner/mac_worker.log)"
fi
trap - ERR
echo
echo "DEPLOYED ${NEW:0:8} to the server."
