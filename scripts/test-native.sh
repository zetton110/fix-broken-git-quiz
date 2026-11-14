#!/usr/bin/env bash
# 出題スクリプトをVMの外で検査する。
# 各問題について「壊した直後は未クリア」「解答例の各行を実行し終えるとクリア」
# 「解答例の途中ではクリアにならない」を確かめる。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HOME="$(mktemp -d)"
trap 'rm -rf "$HOME"' EXIT
cp "$ROOT/vm/home/gitconfig" "$HOME/.gitconfig"
. "$ROOT/vm/rootfs/usr/local/lib/quiz/quiz.sh"

fail=0
for n in $(seq 1 "$QUIZ_COUNT"); do
  quiz "$n" >/dev/null || { echo "NG  問題$n: 準備に失敗"; fail=1; continue; }
  if __quiz_check "$n" >/dev/null 2>&1; then
    echo "NG  問題$n: 壊した直後なのにクリア判定になった"; fail=1; continue
  fi
  reason="$(__quiz_check "$n" 2>&1)"
  mapfile -t lines < "$ROOT/tests/solutions/$n.sh"
  last=$((${#lines[@]} - 1))
  early=0
  for i in "${!lines[@]}"; do
    eval "${lines[$i]}" >/dev/null 2>&1
    if [ "$i" -lt "$last" ] && __quiz_check "$n" >/dev/null 2>&1; then early=1; fi
  done
  out="$(__quiz_prompt)"
  if [ "$early" = 1 ]; then
    echo "NG  問題$n: 解答例の途中でクリア判定になった"; fail=1
  elif __quiz_check "$n" >/dev/null 2>&1 && [[ "$out" == *"quiz;goal;$n"* ]]; then
    echo "OK  問題${n}（壊した直後の判定: ${reason}）"
  else
    echo "NG  問題$n: 解答例を実行してもクリアにならない: $(__quiz_check "$n" 2>&1)"; fail=1
  fi
done
exit "$fail"
