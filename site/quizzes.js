"use strict";
// 問題文とヒント。番号とタイトルは vm/rootfs/usr/local/lib/quiz/quiz.sh と揃える。
// hints は [見出し, 説明, コマンド（省略可）] の並びで、後ろほど答えに近い。
const QUIZZES = [
  {
    title: "別のGitプロセスが動いていると言われる",
    symptom: "README.md をステージしようとすると、別の git プロセスが動いているというエラーで止まります。",
    first: "git add README.md",
    hints: [
      ["調べ方", "エラーメッセージに、原因になっているファイルの名前が出ています。.git の中を見てみましょう。", "ls -la .git"],
      ["原因", "index.lock は、Git が index を書き換えるあいだだけ置くロックファイルです。Git が異常終了すると残ることがあります。ほかに git が動いていなければ、消して構いません。"],
      ["解答例", "ロックファイルを削除します。", "rm .git/index.lock"],
    ],
  },
  {
    title: "設定ファイルの1行目が不正だと言われる",
    symptom: "どのコマンドを実行しても、設定ファイルの1行目が不正だというエラーになります。",
    first: "git status",
    hints: [
      ["調べ方", "エラーが指しているファイルの1行目を見てみましょう。", "cat .git/config"],
      ["原因", "セクションの見出しは [core] のように角括弧で閉じる必要があります。閉じ括弧が欠けています。"],
      ["解答例", "nano .git/config で1行目を [core] に直します。sed でも直せます。", "sed -i.bak '1s/.*/[core]/' .git/config"],
    ],
  },
  {
    title: "作業ツリーの中で実行しろと言われる",
    symptom: "作業ツリーの中にいるのに、作業ツリーの中で実行するように言われます。",
    first: "git status",
    hints: [
      ["調べ方", "Git がこのリポジトリをどう認識しているかは、リポジトリの設定で決まります。", "git config --list --local"],
      ["原因", "core.bare が true になっています。bare リポジトリは作業ツリーを持たないものとして扱われます。"],
      ["解答例", "core.bare を false に戻します。", "git config core.bare false"],
    ],
  },
  {
    title: "リポジトリとして認識されない",
    symptom: ".git ディレクトリはあるのに、Gitリポジトリではないと言われます。",
    first: "git status",
    hints: [
      ["調べ方", "Git は .git の中に HEAD、objects、refs がそろっているときだけリポジトリとして扱います。それぞれ確認しましょう。", "ls -la .git; cat .git/HEAD"],
      ["原因", ".git/HEAD が空です。HEAD には、いまのブランチを指す1行が入っているはずです。"],
      ["解答例", "HEAD に main ブランチへの参照を書き戻します。", "echo 'ref: refs/heads/main' > .git/HEAD"],
    ],
  },
  {
    title: "indexファイルが壊れていると言われる",
    symptom: "index ファイルの署名が不正で、壊れていると言われます。",
    first: "git status",
    hints: [
      ["調べ方", "index の先頭4バイトは DIRC という署名のはずです。先頭を見てみましょう。", "head -c 4 .git/index; echo"],
      ["原因", "index の先頭が書きつぶされています。index はステージの状態を持つファイルで、コミットの内容から作り直せます。"],
      ["解答例", "壊れた index を消し、HEAD のコミットから作り直します。", "rm .git/index\ngit reset"],
    ],
  },
  {
    title: "コミットしたはずなのに「No commits yet」と表示される",
    symptom: "3回コミットしたリポジトリなのに、まだコミットがないと表示され、すべてのファイルが新規追加の扱いになっています。",
    first: "git status",
    hints: [
      ["調べ方", "HEAD が指すブランチのファイルを順にたどります。", "cat .git/HEAD; cat .git/refs/heads/main"],
      ["原因", ".git/refs/heads/main が空です。ここには main の先頭コミットのハッシュ値が入っているはずです。コミット自体は残っていて、ハッシュ値は reflog のファイルで分かります。", "tail -n 1 .git/logs/refs/heads/main"],
      ["解答例", "最新のコミットのハッシュ値を書き戻します。", "echo 434dcb3f0533968183d0d695054f100fefc42291 > .git/refs/heads/main"],
    ],
  },
  {
    title: "コミット済みのファイルの内容を表示できない",
    symptom: "git status は正常に見えますが、コミット済みの app.py の内容を表示しようとするとエラーになります。",
    first: "git show HEAD:app.py",
    hints: [
      ["調べ方", "エラーメッセージに、壊れているオブジェクトのハッシュ値が出ています。全体の検査もできます。", "git fsck"],
      ["原因", "app.py の内容を持つ blob オブジェクトが壊れています。blob はファイルの内容だけから決まるので、同じ内容のファイルがあれば作り直せます。作業ツリーの app.py は無事です。"],
      ["解答例", "壊れたオブジェクトを消し、作業ツリーの app.py から blob を書き直します。", "rm -f .git/objects/55/bcbcbb235a2c04bd28b2e4f1b8d24db7266db9\ngit hash-object -w app.py"],
    ],
  },
  {
    title: "履歴は見えるのに状態を表示できない",
    symptom: "git log --oneline で履歴は見えますが、git status がエラーになります。",
    first: "git status",
    hints: [
      ["調べ方", "エラーメッセージのハッシュ値が、どのコミットのどの部分なのかを調べます。", "git cat-file -p HEAD"],
      ["原因", "最新のコミットが指す tree オブジェクトが壊れています。tree はディレクトリの中身の一覧で、index が同じ内容を持っていれば index から作り直せます。"],
      ["解答例", "壊れたオブジェクトを消し、index から tree を書き直します。", "rm -f .git/objects/1e/5269c3584df32d65860cd27c8cd9c5f1965be9\ngit write-tree"],
    ],
  },
  {
    title: "HEADが不正なオブジェクトだと言われる",
    symptom: "HEAD が不正なオブジェクトだと言われ、どのコミットも読めません。",
    first: "git status",
    hints: [
      ["調べ方", "オブジェクトがどこに保存されているかを見てみましょう。", "ls -R .git/objects"],
      ["原因", "オブジェクトは packfile（.pack）にまとめられていますが、中身の位置を引くための索引（.idx）がありません。索引は .pack から作り直せます。"],
      ["解答例", ".pack から .idx を作り直します。", "git index-pack .git/objects/pack/pack-*.pack"],
    ],
  },
  {
    title: "最新のコミットそのものが読めない",
    symptom: "最新のコミットのオブジェクトが壊れていて、履歴も状態も表示できません。",
    first: "git status",
    hints: [
      ["調べ方", "コミットは、tree、親コミット、作者、日時、メッセージからできています。すべて同じなら、同じハッシュ値のコミットを作り直せます。まず材料を集めます。", "git write-tree\ncat .git/logs/HEAD"],
      ["原因", "tree は index から求められます（1e5269c…）。親コミットとメッセージは reflog の最後の行に残っています（親は 3b37e79…、メッセージは「bye を追加」）。作者は Taro <taro@example.com>、日時は reflog にある 1793494800 +0900 です。"],
      ["解答例", "壊れたオブジェクトを消し、同じ材料でコミットを作り直します。", "rm -f .git/objects/43/4dcb3f0533968183d0d695054f100fefc42291\nGIT_AUTHOR_NAME=\"Taro\" GIT_AUTHOR_EMAIL=\"taro@example.com\" GIT_AUTHOR_DATE=\"1793494800 +0900\" GIT_COMMITTER_NAME=\"Taro\" GIT_COMMITTER_EMAIL=\"taro@example.com\" GIT_COMMITTER_DATE=\"1793494800 +0900\" git commit-tree 1e5269c3584df32d65860cd27c8cd9c5f1965be9 -p 3b37e793f7b72fef74d619390a41ee7ee6c4c644 -m \"bye を追加\""],
    ],
  },
];
