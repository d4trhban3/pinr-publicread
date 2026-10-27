#!/usr/bin/env bash
# Checks deploy-air.sh step 2 (the server's settings kept across a fast-forward) in a throwaway pair of repositories.
# Run on the Mac or the server:  bash ops/test_deploy_settings.sh [path/to/deploy-air.sh]
# It runs step 2's own text (cut from the script) with a git shim that reads the live settings file after every git
# call, and a reader that reads it all the while, so a moment where the live file holds the repo's values
# (sqd_live off: pinr-sqdlive stopped at every deploy, 25-26 Oct) is caught. Nothing outside the temporary folder is touched.
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${1:-$HERE/deploy-air.sh}"
W="$(mktemp -d)"; trap 'kill $READER 2>/dev/null || true; rm -rf "$W"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t HOME="$W/home"
mkdir -p "$HOME"
ENGINE_REL="eng"; S="$ENGINE_REL/scanner/settings.json"
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "  ok   $2"; else FAIL=$((FAIL + 1)); echo "  FAIL $2"; fi; }

git init -q "$W/up"; cd "$W/up"; mkdir -p eng/scanner
printf '{\n  "sqd_live": false,\n  "solana_providers": ["repo1"],\n  "x": 1\n}\n' > "$S"; echo a > eng/other.py
git add -A; git commit -qm one
git clone -q "$W/up" "$W/air"; cd "$W/air"
printf '{\n  "sqd_live": true,\n  "solana_providers": ["air1"],\n  "x": 1,\n  "air_only": "kept"\n}\n' > "$S"
git update-index --skip-worktree "$S"
cd "$W/up"; printf '{\n  "sqd_live": false,\n  "solana_providers": ["repo2"],\n  "x": 2,\n  "new_key": 5\n}\n' > "$S"
echo b > eng/other.py; git commit -qam two; NEW="$(git rev-parse HEAD)"

# step 2's text as the script sends it to the server
BODY="$(awk '/^step "2\./{f=1; next} f && /^air "set -Eeuo pipefail/{p=1; sub(/^air "/, "")} p{print} p && /trap - ERR"$/{exit}' "$SCRIPT")"
BODY="${BODY%\"}"
[ -n "$BODY" ] || { echo "step 2 not found in $SCRIPT" >&2; exit 2; }
AIR_ROOT="$W/air"; BODY="$(eval "printf '%s' \"$BODY\"")"   # the Mac-side expansion (AIR_ROOT, ENGINE_REL, NEW)

# the shim: after each git call, the live file must still say sqd_live true and parse
REAL_GIT="$(command -v git)"; mkdir -p "$W/bin"
cat > "$W/bin/git" <<SHIM
#!/usr/bin/env bash
"$REAL_GIT" "\$@"; rc=\$?
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("ON" if d.get("sqd_live") is True else "OFF")' "$W/air/$S" 2>/dev/null >> "$W/seen" || echo BAD >> "$W/seen"
exit \$rc
SHIM
chmod +x "$W/bin/git"
( while :; do python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("ON" if d.get("sqd_live") is True else "OFF")' "$W/air/$S" 2>/dev/null >> "$W/polled" || echo BAD >> "$W/polled"; done ) &
READER=$!

echo "step 2 of $SCRIPT"
( cd "$W/air" && PATH="$W/bin:$PATH" bash -c "$BODY" ) >/dev/null 2>"$W/err"; rc=$?
kill $READER 2>/dev/null || true; wait $READER 2>/dev/null || true
ok $rc "step 2 finishes"
cd "$W/air"
ok "$([ "$(git rev-parse HEAD)" = "$NEW" ] && echo 0 || echo 1)" "the server is at the new commit"
ok "$(grep -qv '^ON$' "$W/seen" && echo 1 || echo 0)" "after every git call the live settings still say sqd_live on ($(sort "$W/seen" | uniq -c | tr -s ' ' | tr '\n' ';'))"
ok "$(grep -qv '^ON$' "$W/polled" && echo 1 || echo 0)" "a reader all the while never saw it off or half-written ($(sort "$W/polled" | uniq -c | tr -s ' ' | tr '\n' ';'))"
python3 - "$S" <<'PY' && r=0 || r=1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["sqd_live"] is True and d["air_only"] == "kept" and d["x"] == 1, d   # the server's own values kept
assert d["solana_providers"] == ["repo2"], d                                  # the provider list is the repo's
assert d["new_key"] == 5, d                                                   # a new repo key arrives
PY
ok $r "the merged settings: the server's values, the repo's provider list and new keys"
ok "$(git ls-files -v "$S" | grep -q '^S ' && echo 0 || echo 1)" "the settings file is marked the server's own again"
ok "$([ -z "$(git status --porcelain)" ] && echo 0 || echo 1)" "nothing else changed or left behind ($(git status --porcelain | tr '\n' ' '))"
ok "$(ls "$HOME"/settings-backups/settings.*.json >/dev/null 2>&1 && echo 0 || echo 1)" "the backup was kept"

# a fast-forward that fails (a commit that does not follow the server's): step 2 stops, the server's settings and index as before
cd "$W/up"; git checkout -q -b side HEAD~1; printf '{\n  "sqd_live": false\n}\n' > "$S"; git commit -qam side
SIDE="$(git rev-parse HEAD)"; cd "$W/air"; BEFORE="$(cat "$S")"; HEAD0="$(git rev-parse HEAD)"
BODY2="${BODY//$NEW/$SIDE}"
( cd "$W/air" && bash -c "$BODY2" ) >/dev/null 2>"$W/err2" && rc=0 || rc=1
ok "$([ $rc = 1 ] && echo 0 || echo 1)" "a fast-forward that cannot happen stops step 2"
ok "$([ "$(git rev-parse HEAD)" = "$HEAD0" ] && [ "$(cat "$S")" = "$BEFORE" ] && echo 0 || echo 1)" "then the server's commit and settings are as before"
ok "$(git ls-files -v "$S" | grep -q '^S ' && [ -z "$(git status --porcelain)" ] && [ -z "$(git diff --cached --name-only)" ] && echo 0 || echo 1)" "then the file is marked the server's own, nothing staged, no file left behind ($(git status --porcelain | tr '\n' ' '))"
echo "test_deploy_settings: $PASS/$((PASS + FAIL)) passed"
[ "$FAIL" = 0 ]
