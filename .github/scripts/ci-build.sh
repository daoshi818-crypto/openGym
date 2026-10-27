#!/usr/bin/env bash
# openGym fork: cloud build (GitHub Actions runner).
# OPENGYM_KS is one secret holding "<base64 keystore>::<password>".
set -euo pipefail

KS_B64="${OPENGYM_KS%%::*}"
KS_PASS="${OPENGYM_KS##*::}"

echo "== 1/3 mobile bundle =="
cd frontend
npm ci
VITE_MOBILE=1 npx vite build
node ../scripts/catalogue/stage-media.mjs dist
npx cap sync
node scripts/check-mobile-bundle.mjs
cd ..

echo "== 2/3 release APK =="
cd frontend/android
./gradlew assembleRelease --console=plain
cd ../..

echo "== 3/3 zipalign + sign (v1+v2+v3) =="
printf '%s' "$KS_B64" | base64 -d > /tmp/opengym.keystore
BT=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)
"$BT/zipalign" -f -p 4 frontend/android/app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
"$BT/apksigner" sign \
  --ks /tmp/opengym.keystore --ks-key-alias opengym \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out openGym.apk aligned.apk
"$BT/apksigner" verify --print-certs -v openGym.apk
sha256sum openGym.apk | cut -d' ' -f1 > openGym.apk.sha256
echo "APP_VERSION=$(node -p "require('./frontend/package.json').version")" >> "$GITHUB_ENV"
ls -la openGym.apk
