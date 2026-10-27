#!/bin/zsh
# PINR iPhone app checks: the rules scan, then the build and the automatic tests in the iOS Simulator.
# Usage: scripts/check.sh ["iPhone 18 Pro Max"]   (run from pinr-ios/). Prints one RESULT line at the end.
set -u
cd "${0:A:h}/.."
DEVICE="${1:-iPhone 18 Pro Max}"
fail=0

# 1. Rules scan over the app's own code:
#    no web view; the wallet never signs, sends, approves or switches network; no key in the app.
forbidden='WKWebView|UIWebView|SFSafariViewController|signTransaction|signAllTransactions|signMessage|sendTransaction|signAndSend|eth_sign|personal_sign|eth_sendTransaction|wallet_switchEthereumChain|approve\(|privateKey|secretKey|mnemonic|seedPhrase|apiKey|api_key|import ReownAppKit|import WalletConnect|WalletConnectSwift'
if hits=$(grep -rnE "$forbidden" PINR Config 2>/dev/null); then
  echo "RULES: FAIL"; echo "$hits"; fail=1
else
  echo "RULES: PASS (no web view, no signing or sending call, no key, no wallet-connection library)"
fi

# 2. Build and test (Debug, Simulator).
log="${TMPDIR:-/tmp}/pinr-ios-check.log"
xcodebuild test -project PINR.xcodeproj -scheme PINR -configuration Debug \
  -destination "platform=iOS Simulator,name=$DEVICE" -derivedDataPath build >"$log" 2>&1
code=$?
grep -E "Test run with|✘|error:|\*\* TEST" "$log" | tail -20
[[ $code -ne 0 ]] && fail=1

# 3. The release build must compile too (HTTPS-only feed address).
if xcodebuild build -project PINR.xcodeproj -scheme PINR -configuration Release \
     -destination "generic/platform=iOS Simulator" -derivedDataPath build CODE_SIGNING_ALLOWED=NO >>"$log" 2>&1; then
  echo "RELEASE BUILD: PASS"
  # 4. What the release app really carries: the feed at https://pinr.io, no transport exception
  #    (nothing read in the clear, not even this Mac), the privacy manifest, and the export-compliance answer.
  app="build/Build/Products/Release-iphonesimulator/PINR.app"
  pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$app/Info.plist" 2>/dev/null; }
  if [[ "$(pb PINRFeedURL)" == "https://pinr.io" ]] && ! pb NSAppTransportSecurity >/dev/null \
     && [[ "$(pb ITSAppUsesNonExemptEncryption)" == "false" ]] && [[ -f "$app/PrivacyInfo.xcprivacy" ]]; then
    echo "RELEASE APP: PASS (feed https://pinr.io, HTTPS only, privacy manifest, export compliance)"
  else
    echo "RELEASE APP: FAIL (feed '$(pb PINRFeedURL)'; check the transport exception, PrivacyInfo.xcprivacy, ITSAppUsesNonExemptEncryption)"; fail=1
  fi
else
  echo "RELEASE BUILD: FAIL (see $log)"; fail=1
fi

[[ $fail -eq 0 ]] && echo "RESULT: PASS" || echo "RESULT: FAIL (full log: $log)"
exit $fail
