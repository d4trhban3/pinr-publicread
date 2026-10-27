#!/bin/zsh
# The relay loop: answers collected every minute; a new request as soon as the last is answered (5 coins, most popular first).
# Stops when this chat's session ends. Log lines worth reading start with REQUEST-, RESPONSE-, PUSH or ERROR.
cd "${0:A:h}/../../.." || exit 1
export COMMS_CLONE
R=pinrbot/grok-relay/auto/relay.py
last=0
while true; do
  python3 $R collect 2>&1 || echo "ERROR collect failed"
  open=$(python3 -c "import json;s=json.load(open('pinrbot/grok-relay/auto/state.json'));print(sum(1 for r in s['requests'].values() if not r.get('answered_at')))")
  if (( $(date +%s) - last >= 60 )) && (( open < 1 )); then
    python3 $R request --n 5 2>&1 || echo "ERROR request failed"
    last=$(date +%s)
  fi
  sleep 60
done
