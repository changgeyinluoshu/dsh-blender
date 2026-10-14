#!/usr/bin/env bash
# dsh-blender-studio installer (macOS / Linux).
#
# 1. Symlinks this repository into <Profile>/node_modules/dsh-blender-studio.
# 2. Adds or refreshes a managed block in <Profile>/cordis.patch.yml.
# 3. Installs the Blender add-on (skip with SKIP_ADDON=1).
#
# Usage:
#   ./install.sh
#   DSH_PROFILE_DIR="$HOME/.dsh-beta/profiles/desktop" ./install.sh
#   BLENDER_BRIDGE_PORT=9880 SKIP_ADDON=1 ./install.sh
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="dsh-blender-studio"
BEGIN="# >>> dsh-blender-studio managed block >>>"
END="# <<< dsh-blender-studio managed block <<<"

PORT="9880"
if [ -n "$BLENDER_BRIDGE_PORT" ]; then PORT="$BLENDER_BRIDGE_PORT"; fi

PROFILE=""
if [ -n "$DSH_PROFILE_DIR" ] && [ -d "$DSH_PROFILE_DIR" ]; then
  PROFILE="$DSH_PROFILE_DIR"
else
  for candidate in "$DSH_HOME/profiles/desktop" "$HOME/.dsh-beta/profiles/desktop" "$HOME/.dsh/profiles/desktop"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then PROFILE="$candidate"; break; fi
  done
fi
if [ -z "$PROFILE" ]; then
  echo "Cannot find a DSH profile. Set DSH_PROFILE_DIR to the profile folder and re-run." >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/lib/index.js" ]; then
  echo "Run this script from the plugin repository (lib/index.js not found under $REPO_ROOT)." >&2
  exit 1
fi

echo ""
echo "dsh-blender-studio installer"
echo "  repository : $REPO_ROOT"
echo "  profile    : $PROFILE"
echo ""

# --- 1. node_modules symlink -------------------------------------------------
NODE_MODULES="$PROFILE/node_modules"
mkdir -p "$NODE_MODULES"
LINK="$NODE_MODULES/$PLUGIN_NAME"
if [ -L "$LINK" ]; then rm -f "$LINK"; fi
if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
  if [ -f "$LINK/package.json" ] && grep -q "\"name\": \"$PLUGIN_NAME\"" "$LINK/package.json"; then
    rm -rf "$LINK"
  else
    echo "  [!] $LINK exists and is not this plugin - move it away first" >&2
    exit 1
  fi
fi
ln -s "$REPO_ROOT" "$LINK"
echo "  [OK] linked $LINK -> $REPO_ROOT"

# --- 2. cordis.patch.yml managed block --------------------------------------
PATCH_FILE="$PROFILE/cordis.patch.yml"
touch "$PATCH_FILE"
cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%Y%m%d-%H%M%S)-$PLUGIN_NAME"
BLOCK="$BEGIN
# Managed by install.sh - change it through the script, not by hand.
- insert:
    - id: blender-studio
      name: $PLUGIN_NAME
      config:
        enabled: true
        host: 127.0.0.1
        port: $PORT
$END"
TMP="$PATCH_FILE.tmp"
{
  skipping=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$BEGIN" ]; then skipping=1; continue; fi
    if [ "$line" = "$END" ]; then skipping=0; continue; fi
    if [ "$skipping" = "1" ]; then continue; fi
    printf '%s\n' "$line"
  done < "$PATCH_FILE"
  printf '\n%s\n' "$BLOCK"
} > "$TMP"
mv "$TMP" "$PATCH_FILE"
echo "  [OK] managed block written to cordis.patch.yml"

# --- 3. Blender add-on -------------------------------------------------------
if [ -z "$SKIP_ADDON" ]; then
  if [ -x "$REPO_ROOT/addon/install-addon.sh" ]; then
    "$REPO_ROOT/addon/install-addon.sh"
  else
    bash "$REPO_ROOT/addon/install-addon.sh"
  fi
fi

echo ""
echo "Done. Next steps:"
echo "  1. Restart DSH so the plugin loads."
echo "  2. In Blender: Edit > Preferences > Add-ons > enable \"DSH Blender Bridge\"."
echo "  3. In DSH ask for blender_status."
echo ""
