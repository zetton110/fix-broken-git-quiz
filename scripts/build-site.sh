#!/usr/bin/env bash
# 公開するファイル一式を dist/ に集める。先に build-image.sh と build-state.mjs を実行しておくこと。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

for f in build/images/alpine-fs.json build/images/alpine-state.bin.zst build/bios/seabios.bin node_modules/v86/build/libv86.js; do
  [ -e "$ROOT/$f" ] || { echo "$f がありません。npm install と npm run build:image、npm run build:state を先に実行してください。" >&2; exit 1; }
done

rm -rf "$DIST"
mkdir -p "$DIST/vendor"
cp -R "$ROOT/site/." "$DIST/"
cp -R "$ROOT/build/images" "$ROOT/build/bios" "$DIST/"
cp "$ROOT/node_modules/v86/build/libv86.js" "$ROOT/node_modules/v86/build/v86.wasm" "$DIST/vendor/"
cp "$ROOT/node_modules/@xterm/xterm/lib/xterm.js" "$ROOT/node_modules/@xterm/xterm/css/xterm.css" "$DIST/vendor/"
cp "$ROOT/node_modules/pako/dist/pako_inflate.min.js" "$DIST/vendor/pako_inflate.js"
touch "$DIST/.nojekyll"

echo "作成: $DIST ($(du -sh "$DIST" | cut -f1))"
