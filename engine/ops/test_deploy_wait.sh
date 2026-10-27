#!/usr/bin/env bash
# Checks deploy-air.sh's wait for pinr-feed after a site restart (line 4, SITE's note of 26 Oct: "pinr-feed does not answer"
# printed although the feed answered within a minute). The script's own wait_until, cut from it, runs with a feed that
# answers late; `sleep` moves a simulated clock, so no real time passes. Run: bash ops/test_deploy_wait.sh [deploy-air.sh]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${1:-$HERE/deploy-air.sh}"
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "  ok   $2"; else FAIL=$((FAIL + 1)); echo "  FAIL $2"; fi; }
DEF="$(awk '/^wait_until\(\) \{/{p=1} p{print} p && /^}/{exit}' "$SCRIPT")"
[ -n "$DEF" ] || { echo "  FAIL wait_until is not in $SCRIPT"; echo "test_deploy_wait: 0/3 passed"; exit 1; }
eval "$DEF"
sleep() { SECONDS=$((SECONDS + $1)); }                     # the simulated clock
CALLS=0
late() { CALLS=$((CALLS + 1)); [ "$SECONDS" -ge "$ANSWERS_AT" ]; }

SECONDS=0; ANSWERS_AT=65; CALLS=0
wait_until 180 5 late; rc=$?
ok "$([ $rc = 0 ] && [ "$WAITED" -ge 65 ] && [ "$WAITED" -lt 75 ] && echo 0 || echo 1)" "a feed answering after 65 s is waited for (answered after ${WAITED}s, $CALLS probes)"
SECONDS=0; ANSWERS_AT=99999; CALLS=0
wait_until 180 5 late; rc=$?
ok "$([ $rc != 0 ] && [ "$WAITED" -ge 180 ] && [ "$WAITED" -lt 190 ] && echo 0 || echo 1)" "a feed that never answers fails after the full 180 s (${WAITED}s)"
SECONDS=0; ANSWERS_AT=0; CALLS=0
wait_until 180 5 late; rc=$?
ok "$([ $rc = 0 ] && [ "$CALLS" = 1 ] && echo 0 || echo 1)" "a feed already answering is not waited on ($CALLS probe)"
echo "test_deploy_wait: $PASS/$((PASS + FAIL)) passed"
[ "$FAIL" = 0 ]
