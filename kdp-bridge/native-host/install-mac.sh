#!/bin/sh
# Install native messaging access for the EXISTING Brave KDP Bridge extension.
# Usage: sh install-mac.sh <32-character-Brave-extension-id>
set -eu
ID="${1:-}"
case "$ID" in
  *[!a-p]*|'') echo 'Pass the 32-character extension ID shown in Brave extension Details.' >&2; exit 1 ;;
esac
if [ "${#ID}" -ne 32 ]; then echo 'Extension ID must have 32 characters.' >&2; exit 1; fi
PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then echo 'Python 3 is required.' >&2; exit 1; fi
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET="$HOME/Library/Application Support/KDP Brave Bridge"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# Brave on macOS resolves user native messaging hosts through Chrome\x27s
# NativeMessagingHosts directory (see brave_main_delegate.cc).
# Keep the earlier Brave-specific registration untouched for compatibility.
umask 077
mkdir -p "$TARGET/Publishing" "$MANIFEST"
chmod 700 "$TARGET/Publishing"
cp "$SOURCE/kdp_native_host.py" "$TARGET/kdp_native_host.py"
chmod 600 "$TARGET/kdp_native_host.py"
printf '#!/bin/sh\nexec "%s" "%s/kdp_native_host.py"\n' "$PYTHON" "$TARGET" > "$TARGET/launch-host.sh"
chmod 700 "$TARGET/launch-host.sh"
# Write only the native-host manifest. Existing Brave extension and pairing untouched.
printf '{"name":"com.kdp.brave_bridge","description":"Read-only desktop PDF staging for your private KDP bridge","path":"%s/launch-host.sh","type":"stdio","allowed_origins":["chrome-extension://%s/"]}\n' "$TARGET" "$ID" > "$MANIFEST/com.kdp.brave_bridge.json"
chmod 600 "$MANIFEST/com.kdp.brave_bridge.json"
echo 'Installed PDF staging helper for extension:' "$ID"
echo 'Reload your existing Brave KDP Bridge from brave://extensions (do not remove it).'
