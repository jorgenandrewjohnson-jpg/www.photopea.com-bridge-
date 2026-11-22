#!/bin/sh
# Update the existing unpacked Brave KDP extension and install the narrow
# read-only Desktop/Downloads PDF native host. Does not touch browser pairing.
# Usage: sh update-existing-mac.sh <extension-id>
set -eu
ID="${1:-}"
case "$ID" in *[!a-p]*|'') echo 'Provide the 32-character extension ID from brave://extensions.' >&2; exit 1 ;; esac
[ "${#ID}" -eq 32 ] || { echo 'Extension ID must be 32 characters.' >&2; exit 1; }
DEST="$HOME/Developer/kdp-browser-bridge/kdp-bridge/extension"
[ -f "$DEST/manifest.json" ] || { echo "Existing extension not found: $DEST" >&2; exit 1; }
RAW="https://raw.githubusercontent.com/jorgenandrewjohnson-jpg/www.photopea.com-bridge-/kdp-browser-bridge/kdp-bridge"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/extension" "$TMP/native-host" "$DEST"
for file in background.js content.js files.js manifest.json policy.js popup.js popup.html; do
  curl -fsSL --retry 3 "$RAW/extension/$file" -o "$TMP/extension/$file"
done
for file in kdp_native_host.py install-mac.sh; do
  curl -fsSL --retry 3 "$RAW/native-host/$file" -o "$TMP/native-host/$file"
done
grep -q '"version": "0.3.1"' "$TMP/extension/manifest.json" || { echo 'Unexpected extension version' >&2; exit 1; }
if command -v node >/dev/null 2>&1; then
  for file in background.js content.js files.js policy.js popup.js; do
    node --check "$TMP/extension/$file"
  done
fi
BACKUP="$DEST/backup-before-v0.3.1"
mkdir -p "$BACKUP"
for file in background.js content.js files.js manifest.json policy.js popup.js popup.html; do
  [ -f "$DEST/$file" ] && cp "$DEST/$file" "$BACKUP/$file"
  cp "$TMP/extension/$file" "$DEST/$file"
done
sh "$TMP/native-host/install-mac.sh" "$ID"
echo 'Updated the existing Brave extension and installed the read-only PDF helper.'
echo 'Open brave://extensions and RELOAD the existing KDP Bridge. Do not remove it.'
