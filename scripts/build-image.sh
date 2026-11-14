#!/usr/bin/env bash
# Alpine Linux のルートファイルシステムを作り、v86 が読める形式（fs.json と平坦化したファイル群）に変換する。
# 出力先は build/images/。Docker と、zstandard モジュールの入った python3 が必要。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V86_COMMIT=315b2b0b758703ef0e6cc7b4088d6068f83f3c20
V86_SRC="$ROOT/.cache/v86"
PYTHON="${PYTHON:-python3}"

IMAGES="$ROOT/build/images"
OUT_TAR="$IMAGES/alpine-rootfs.tar"
OUT_FLAT="$IMAGES/alpine-rootfs-flat"
OUT_FSJSON="$IMAGES/alpine-fs.json"
CONTAINER_NAME=fix-broken-git-quiz-vm
IMAGE_NAME=fix-broken-git-quiz-vm

# 変換ツールと BIOS は、npm の v86 と同じ版の v86 リポジトリから取る。
if [ "$(git -C "$V86_SRC" rev-parse HEAD 2>/dev/null)" != "$V86_COMMIT" ]; then
  rm -rf "$V86_SRC"
  git init -q "$V86_SRC"
  git -C "$V86_SRC" fetch -q --depth 1 https://github.com/copy/v86 "$V86_COMMIT"
  git -C "$V86_SRC" checkout -q FETCH_HEAD
fi

rm -rf "$IMAGES"
mkdir -p "$OUT_FLAT" "$ROOT/build/bios"
cp "$V86_SRC/bios/seabios.bin" "$V86_SRC/bios/vgabios.bin" "$ROOT/build/bios/"

docker build "$ROOT/vm" --platform linux/386 --rm --tag "$IMAGE_NAME"
docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME" >/dev/null
docker export "$CONTAINER_NAME" -o "$OUT_TAR"
docker rm "$CONTAINER_NAME" >/dev/null

"$PYTHON" "$V86_SRC/tools/fs2json.py" --zstd --out "$OUT_FSJSON" "$OUT_TAR"
"$PYTHON" "$V86_SRC/tools/copy-to-sha256.py" --zstd "$OUT_TAR" "$OUT_FLAT"
rm "$OUT_TAR"

echo "作成: $OUT_FSJSON, $OUT_FLAT ($(du -sh "$OUT_FLAT" | cut -f1))"
