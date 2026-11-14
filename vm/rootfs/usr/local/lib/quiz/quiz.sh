# 壊れたGitリポジトリを直す問題集: VM内のシェルに読み込む関数群
# bash から source して使う。ページとの通信は OSC 777 のエスケープシーケンスで行う。

QUIZ_HEAD=434dcb3f0533968183d0d695054f100fefc42291
QUIZ_COUNT=10
QUIZ_CURRENT=""
QUIZ_DONE=""

# ページ側（xterm.js の OSC ハンドラ）に状態を通知する。端末には表示されない。
__quiz_osc() { printf '\033]777;quiz;%s\007' "$1"; }

__quiz_title() {
  case "$1" in
    1) echo "別のGitプロセスが動いていると言われる" ;;
    2) echo "設定ファイルの1行目が不正だと言われる" ;;
    3) echo "作業ツリーの中で実行しろと言われる" ;;
    4) echo "リポジトリとして認識されない" ;;
    5) echo "indexファイルが壊れていると言われる" ;;
    6) echo "コミットしたはずなのに「No commits yet」と表示される" ;;
    7) echo "コミット済みのファイルの内容を表示できない" ;;
    8) echo "履歴は見えるのに状態を表示できない" ;;
    9) echo "HEADが不正なオブジェクトだと言われる" ;;
    10) echo "最新のコミットそのものが読めない" ;;
  esac
}

# 最初に試すコマンド
__quiz_first() {
  case "$1" in
    1) echo "git add README.md" ;;
    7) echo "git show HEAD:app.py" ;;
    *) echo "git status" ;;
  esac
}

# 壊す前のリポジトリを作る。作者名と日時を固定しているので、ハッシュ値は毎回同じになる。
__quiz_base() (
  set -e
  export GIT_AUTHOR_NAME="Taro" GIT_AUTHOR_EMAIL="taro@example.com"
  export GIT_COMMITTER_NAME="Taro" GIT_COMMITTER_EMAIL="taro@example.com"
  export GIT_AUTHOR_DATE="2026-11-01T10:00:00+09:00"
  export GIT_COMMITTER_DATE="2026-11-01T10:00:00+09:00"
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

  rm -rf "$1"
  git init -q -b main "$1"
  cd "$1"

  echo "# git-kuizu" > README.md
  git add README.md
  git commit -q -m "README を追加"

  printf 'def hello():\n    print("hello")\n' > app.py
  git add app.py
  git commit -q -m "app.py を追加"

  printf 'def bye():\n    print("bye")\n' >> app.py
  git commit -q -am "bye を追加"
)

__quiz_corrupt() {
  chmod u+w "$1" && echo garbage > "$1"
}

__quiz_break() (
  set -e
  cd "$HOME/q$1"
  case "$1" in
    1) touch .git/index.lock ;;
    2) sed -i.bak '1s/.*/[core/' .git/config ;;
    3) git config core.bare true ;;
    4) : > .git/HEAD ;;
    5) printf 'XXXX' | dd of=.git/index bs=1 conv=notrunc 2>/dev/null ;;
    6) : > .git/refs/heads/main ;;
    7) __quiz_corrupt .git/objects/55/bcbcbb235a2c04bd28b2e4f1b8d24db7266db9 ;;
    8) __quiz_corrupt .git/objects/1e/5269c3584df32d65860cd27c8cd9c5f1965be9 ;;
    9) git gc -q
       rm -f .git/objects/pack/*.idx .git/objects/pack/*.rev ;;
    10) __quiz_corrupt .git/objects/43/4dcb3f0533968183d0d695054f100fefc42291 ;;
  esac
)

# 復旧できたかを判定する。失敗時は理由を1行出力して 1 を返す。
# 安い検査から順に行い、git fsck は最後に回す（プロンプトのたびに呼ばれるため）。
__quiz_check() (
  cd "$HOME/q$1" 2>/dev/null || { echo "~/q$1 がありません"; exit 1; }
  if [ -e .git/index.lock ]; then
    echo ".git/index.lock が残っています"; exit 1
  fi
  git rev-parse --git-dir >/dev/null 2>&1 \
    || { echo "Gitリポジトリとして認識されていません"; exit 1; }
  [ "$(git rev-parse --is-bare-repository 2>/dev/null)" = false ] \
    || { echo "bare リポジトリとして扱われています"; exit 1; }
  [ "$(git symbolic-ref -q HEAD 2>/dev/null)" = refs/heads/main ] \
    || { echo "HEAD が main ブランチを指していません"; exit 1; }
  [ "$(git rev-parse -q --verify HEAD 2>/dev/null)" = "$QUIZ_HEAD" ] \
    || { echo "main が元のコミット（434dcb3）を指していません"; exit 1; }
  git --no-optional-locks status --porcelain >/dev/null 2>&1 \
    || { echo "git status が失敗します"; exit 1; }
  git diff --cached --quiet HEAD 2>/dev/null \
    || { echo "index が HEAD のコミットと一致していません"; exit 1; }
  git fsck >/dev/null 2>&1 \
    || { echo "git fsck がエラーを報告しています"; exit 1; }
)

__quiz_goal() {
  printf '\n\033[1;32m  ゴール！ 問題%s をクリアしました。\033[0m\n' "$QUIZ_CURRENT"
  if [ "$QUIZ_CURRENT" -lt "$QUIZ_COUNT" ]; then
    printf '  次の問題: quiz %s\n\n' "$((QUIZ_CURRENT + 1))"
  else
    printf '  これで全問クリアです。\n\n'
  fi
  __quiz_osc "goal;$QUIZ_CURRENT"
}

# PROMPT_COMMAND から呼ばれる。コマンドを1つ実行するたびに自動で判定する。
__quiz_prompt() {
  if [ -n "$QUIZ_CURRENT" ] && [ "$QUIZ_DONE" = 0 ]; then
    if __quiz_check "$QUIZ_CURRENT" >/dev/null 2>&1; then
      QUIZ_DONE=1
      __quiz_goal
    fi
  fi
  __quiz_osc "prompt;${QUIZ_CURRENT:-0};${QUIZ_DONE:-0}"
}

__quiz_list() {
  local n
  echo "壊れたGitリポジトリを直す問題集"
  echo
  for n in $(seq 1 "$QUIZ_COUNT"); do
    printf '  quiz %-2s  %s\n' "$n" "$(__quiz_title "$n")"
  done
  echo
  echo "  quiz <番号>  問題を始める（やり直すときも同じ）"
  echo "  quiz check   いまの問題がなぜ未クリアなのかを表示する"
  echo "  quiz reset   作業ディレクトリをすべて消す"
}

__quiz_start() {
  local n="$1"
  cd "$HOME" || return 1
  if ! { __quiz_base "$HOME/q$n" && __quiz_break "$n"; }; then
    echo "問題の準備に失敗しました。quiz $n をもう一度実行してください。"
    return 1
  fi
  cd "$HOME/q$n" || return 1
  QUIZ_CURRENT="$n"
  QUIZ_DONE=0
  __quiz_osc "start;$n"
  printf '\n\033[1m問題%s：%s\033[0m\n' "$n" "$(__quiz_title "$n")"
  printf '  壊れたリポジトリを ~/q%s に用意しました。\n' "$n"
  printf '  まず \033[33m%s\033[0m を実行してみましょう。\n' "$(__quiz_first "$n")"
  printf '  直ると自動でゴール判定されます。\n\n'
}

quiz() {
  case "${1:-}" in
    "") __quiz_list ;;
    [1-9]|10) __quiz_start "$1" ;;
    check)
      if [ -z "$QUIZ_CURRENT" ]; then
        echo "問題が始まっていません。quiz <番号> で始めてください。"
      elif [ "$QUIZ_DONE" = 1 ]; then
        echo "問題$QUIZ_CURRENT はクリア済みです。"
      else
        printf '未クリア: '
        __quiz_check "$QUIZ_CURRENT"
      fi ;;
    reset)
      cd "$HOME" || return 1
      rm -rf "$HOME"/q[0-9] "$HOME"/q10
      QUIZ_CURRENT=""
      QUIZ_DONE=""
      echo "作業ディレクトリを消しました。" ;;
    *) echo "使い方: quiz [1-$QUIZ_COUNT | check | reset]" ;;
  esac
}
