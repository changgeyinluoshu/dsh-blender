#!/usr/bin/env bash
# Remove the DSH Blender Bridge add-on from Blender's user add-on folders (macOS / Linux).
set -eo pipefail

ADDON_NAME="dsh_blender_bridge"
REMOVED=0

remove_from() {
  local target="$1/$ADDON_NAME"
  if [ -d "$target" ]; then
    rm -rf "$target"
    echo "  [OK] removed $target"
    REMOVED=1
  fi
}

if [ -n "$ADDONS_DIR" ]; then
  remove_from "$ADDONS_DIR"
else
  case "$(uname -s)" in
    Darwin) ROOTS="$HOME/Library/Application Support/Blender" ;;
    *) ROOTS="$HOME/.config/blender $HOME/.var/app/org.blender.Blender/config/blender" ;;
  esac
  for root in $ROOTS; do
    if [ ! -d "$root" ]; then continue; fi
    for version in "$root"/*; do
      if [ -d "$version" ]; then remove_from "$version/scripts/addons"; fi
    done
  done
fi

if [ "$REMOVED" = "0" ]; then echo "  [!] no installed add-on found"; fi
