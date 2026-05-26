#!/usr/bin/env bash
# Regenerate icons/icon{16,48,128}.png from icons/icon.svg.
# Requires macOS (uses qlmanage + sips). Run from repo root.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f icons/icon.svg ]; then
  echo "icons/icon.svg not found"; exit 1
fi

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

cp icons/icon.svg "$TMP/icon.svg"
qlmanage -t -s 512 -o "$TMP" "$TMP/icon.svg" > /dev/null 2>&1

SRC="$TMP/icon.svg.png"
[ -f "$SRC" ] || { echo "qlmanage did not produce $SRC"; exit 1; }

for SIZE in 16 48 128; do
  sips -z "$SIZE" "$SIZE" "$SRC" --out "icons/icon${SIZE}.png" > /dev/null
  echo "wrote icons/icon${SIZE}.png"
done
