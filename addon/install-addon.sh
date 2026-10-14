#!/usr/bin/env bash
# Install the bundled Blender add-on into Blender's user add-on folder (macOS / Linux).
set -eo pipefail

ADDON_NAME="dsh_blender_bridge"
SOURCE="$(cd "$(dirname "$0")" && pwd)/$ADDON_NAME"
BLENDER_PATH="$DSH_BLENDER_EXECUTABLE"
ADDONS_DIR_OVERRIDE="$ADDONS_DIR"
ENABLE_FLAG="$ENABLE"

echo ""
echo "DSH Blender Bridge - add-on installer"

find_blender() {
  if [ -n "$BLENDER_PATH" ] && [ -x "$BLENDER_PATH" ]; then echo "$BLENDER_PATH"; return; fi
  if command -v blender >/dev/null 2>&1; then command -v blender; return; fi
  for candidate in /Applications/Blender.app/Contents/MacOS/Blender /usr/bin/blender /usr/local/bin/blender /snap/bin/blender /var/lib/flatpak/exports/bin/org.blender.Blender; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  echo ""
}

short_version() {
  local exe="$1"
  if [ -z "$exe" ]; then echo ""; return; fi
  "$exe" --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+\.[0-9]+' | head -n 1
}

newest_dir() {
  ls -1 "$1" 2>/dev/null | sort -Vr | head -n 1
}

resolve_addons_dir() {
  local short="$1"
  if [ -n "$ADDONS_DIR_OVERRIDE" ]; then echo "$ADDONS_DIR_OVERRIDE"; return; fi
  local roots=""
  case "$(uname -s)" in
    Darwin) roots="$HOME/Library/Application Support/Blender" ;;
    *) roots="$HOME/.config/blender $HOME/.var/app/org.blender.Blender/config/blender" ;;
  esac
  for root in $roots; do
    if [ ! -d "$root" ]; then continue; fi
    if [ -n "$short" ] && [ -d "$root/$short" ]; then echo "$root/$short/scripts/addons"; return; fi
    local latest=""
    latest="$(newest_dir "$root")"
    if [ -n "$latest" ]; then echo "$root/$latest/scripts/addons"; return; fi
  done
  if [ -n "$short" ]; then
    local first=""
    first="$(echo "$roots" | awk '{print $1}')"
    echo "$first/$short/scripts/addons"
    return
  fi
  echo ""
}

EXE="$(find_blender)"
SHORT=""
if [ -n "$EXE" ]; then SHORT="$(short_version "$EXE")"; fi
if [ -n "$EXE" ]; then echo "  blender : $EXE (version $SHORT)"; else echo "  [!] Blender executable not found - using the newest user add-on folder"; fi

if [ ! -d "$SOURCE" ]; then echo "  [!] add-on sources not found: $SOURCE" >&2; exit 1; fi

TARGET="$(resolve_addons_dir "$SHORT")"
if [ -z "$TARGET" ]; then echo "  [!] cannot work out the add-on folder - set ADDONS_DIR" >&2; exit 1; fi

mkdir -p "$TARGET"
rm -rf "$TARGET/$ADDON_NAME"
cp -R "$SOURCE" "$TARGET/$ADDON_NAME"
find "$TARGET/$ADDON_NAME" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$TARGET/$ADDON_NAME" -name '*.pyc' -type f -delete 2>/dev/null || true
echo "  [OK] add-on installed: $TARGET/$ADDON_NAME"

if [ "$ENABLE_FLAG" = "1" ] && [ -n "$EXE" ]; then
  if "$EXE" --background --python-expr "import addon_utils,bpy;addon_utils.enable('$ADDON_NAME',default_set=True);bpy.ops.wm.save_userpref();print('DSH_ADDON_ENABLED')" 2>&1 | grep -q DSH_ADDON_ENABLED; then
    echo "  [OK] add-on enabled in Blender user preferences"
  else
    echo "  [!] could not confirm the automatic enable - tick it manually in Blender"
  fi
fi

echo ""
echo "Next: open Blender > Edit > Preferences > Add-ons, enable \"DSH Blender Bridge\"."
echo "The bridge then listens on 127.0.0.1:9880 (status in the 3D viewport sidebar, DSH tab)."
