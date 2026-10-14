#!/usr/bin/env bash
# Remove dsh-blender-studio from a DSH profile (macOS / Linux).
#   ./uninstall.sh              # plugin only
#   REMOVE_ADDON=1 ./uninstall.sh   # also remove the Blender add-on
set -eo pipefail

PLUGIN_NAME="dsh-blender-studio"
BEGIN="# >>> dsh-blender-studio managed block >>>"
END="# <<< dsh-blender-studio managed block <<<"

PROFILE=""
if [ -n "$DSH_PROFILE_DIR" ] && [ -d "$DSH_PROFILE_DIR" ]; then
  PROFILE="$DSH_PROFILE_DIR"
else
  for candidate in "$DSH_HOME/profiles/desktop" "$HOME/.dsh-beta/profiles/desktop" "$HOME/.dsh/profiles/desktop"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then PROFILE="$candidate"; break; fi
  done
fi
if [ -z "$PROFILE" ]; then
  echo "Cannot find a DSH profile. Set DSH_PROFILE_DIR and re-run." >&2
  exit 1
fi

echo ""
echo "Removing $PLUGIN_NAME from $PROFILE"

PATCH_FILE="$PROFILE/cordis.patch.yml"
if [ -f "$PATCH_FILE" ]; then
  if grep -q "$BEGIN" "$PATCH_FILE"; then
    cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%Y%m%d-%H%M%S)-$PLUGIN_NAME-remove"
    TMP="$PATCH_FILE.tmp"
    {
      skipping=0
      while IFS= read -r line || [ -n "$line" ]; do
        if [ "$line" = "$BEGIN" ]; then skipping=1; continue; fi
        if [ "$line" = "$END" ]; then skipping=0; continue; fi
        if [ "$skipping" = "1" ]; then continue; fi
        printf '%s\n' "$line"
      done < "$PATCH_FILE"
    } > "$TMP"
    mv "$TMP" "$PATCH_FILE"
    echo "  [OK] managed block removed"
  else
    echo "  [!] no managed block found"
  fi
fi

LINK="$PROFILE/node_modules/$PLUGIN_NAME"
if [ -L "$LINK" ] || [ -d "$LINK" ]; then
  rm -rf "$LINK"
  echo "  [OK] removed $LINK"
else
  echo "  [!] node_modules link not present"
fi

if [ -n "$REMOVE_ADDON" ]; then
  bash "$(cd "$(dirname "$0")" && pwd)/addon/uninstall-addon.sh"
fi

echo ""
echo "Restart DSH to unload the plugin."
