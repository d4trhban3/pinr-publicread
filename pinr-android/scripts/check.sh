#!/bin/zsh
# PINR Android app checks: the rules scan, the automatic tests, the debug build, and the release build with what it
# really carries. Usage: scripts/check.sh   (run from anywhere). Prints one RESULT line at the end.
set -u
cd "${0:A:h}/.."
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
fail=0

# 1. Rules scan over the app's own code: no web view; no wallet connection,
#    signing or sending; no key in the app.
forbidden='WebView|CustomTabs|signTransaction|signAllTransactions|signMessage|sendTransaction|signAndSend|eth_sign|personal_sign|eth_sendTransaction|wallet_switchEthereumChain|privateKey|secretKey|mnemonic|seedPhrase|apiKey|api_key|walletconnect|reown|solana-mobile|mobilewalletadapter|web3'
if hits=$(grep -rniE "$forbidden" app/src gradle/libs.versions.toml app/build.gradle.kts 2>/dev/null); then
  echo "RULES: FAIL"; echo "$hits"; fail=1
else
  echo "RULES: PASS (no web view, no wallet library, no signing or sending call, no key)"
fi

# 2. Automatic tests and both builds.
log="${TMPDIR:-/tmp}/pinr-android-check.log"
./gradlew --console=plain testDebugUnitTest assembleDebug assembleRelease >"$log" 2>&1
code=$?
results=(app/build/test-results/testDebugUnitTest/*.xml(N))
if (( ${#results} )); then
  python3 -I - "${results[@]}" <<'PY'
import sys, xml.etree.ElementTree as ET
t = f = 0
for p in sys.argv[1:]:
    r = ET.parse(p).getroot(); t += int(r.get("tests")); f += int(r.get("failures")) + int(r.get("errors"))
print(f"TESTS: {t - f} of {t} passed in {len(sys.argv) - 1} suites")
PY
else
  echo "TESTS: none ran"; fail=1
fi
grep -E "FAILED|BUILD (SUCCESSFUL|FAILED)|^e: " "$log" | tail -10
[[ $code -ne 0 ]] && fail=1

# 3. What the release app really carries: the feed at https://pinr.io, no plain http anywhere.
#    The release build shortens resource file names, so the network rules file is found by its resource name.
apk=app/build/outputs/apk/release/app-release-unsigned.apk
bc=app/build/generated/source/buildConfig/release/io/pinr/app/BuildConfig.java
aapt="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)aapt2"
if [[ -f "$apk" ]] && grep -q 'FEED_URL = "https://pinr.io"' "$bc" && grep -q 'HTTPS_ONLY = true' "$bc" \
   && nscfile=$("$aapt" dump resources "$apk" | grep -A1 "xml/network_security_config" | grep -oE "res/[^ ]+\.xml") \
   && nsc=$("$aapt" dump xmltree "$apk" --file "$nscfile" 2>/dev/null) \
   && ! grep -q "domain-config" <<<"$nsc" && grep -q "cleartextTrafficPermitted.*false" <<<"$nsc"; then
  echo "RELEASE APP: PASS (feed https://pinr.io, no plain http allowed)"
else
  echo "RELEASE APP: FAIL (check $bc and the release network_security_config)"; fail=1
fi

[[ $fail -eq 0 ]] && echo "RESULT: PASS" || echo "RESULT: FAIL (full log: $log)"
exit $fail
