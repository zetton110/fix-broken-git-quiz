# 引き継ぎメモ

ブラウザ上で壊れたGitリポジトリを直す問題集サイトの、設計と進み具合をまとめたものです。
claude.ai のセッションで途中まで作り、続きをローカルで進めるために書いています。

## 作るもの

- GitHub Pages（`https://zetton110.github.io/fix-broken-git-quiz/`）で公開する静的サイト
- 画面のターミナルで本物の `git` を実行し、壊れたリポジトリを直す
- 直ったことを自動で判定し、画面にゴールを表示する
- 問題は10問。難易度順に並んでいる

## 構成

ブラウザ内でx86エミュレータ [v86](https://github.com/copy/v86) を動かし、その上の Alpine Linux で `git` を実行します。
サーバー側の処理はありません。

| 部分 | 内容 | 状態 |
| --- | --- | --- |
| 出題スクリプト | `vm/rootfs/usr/local/lib/quiz/quiz.sh` | VMの外と中の両方でテスト済み |
| シェル初期設定 | `vm/home/bash_profile`、`vm/home/gitconfig` | VM内で確認済み |
| 解答例とテスト | `tests/solutions/`、`scripts/test-native.sh` | 10問とも通過 |
| VMイメージ | `vm/Dockerfile`、`scripts/build-image.sh` | 作成済み、ローカルでビルド済み |
| 起動済み状態 | `scripts/build-state.mjs` | 作成済み、VM内で10問を解いてから保存する |
| Webページ | `site/`、`scripts/build-site.sh` | 作成済み、ローカルのブラウザで確認済み |
| .git エクスプローラー | `site/explorer.js` | 作成済み、ローカルのブラウザで10問とも確認済み（未デプロイ） |
| デプロイ | `.github/workflows/deploy.yml` | GitHub Actions でビルドとデプロイに成功（2026-11-14） |

## ビルドと確認の手順

Docker、Node.js、`zstd` コマンド、`zstandard` モジュールの入った Python が必要です。

```sh
npm install
python3 -m venv .venv && .venv/bin/pip install zstandard
npm test                                              # VMの外で出題スクリプトを検査する
PYTHON=$PWD/.venv/bin/python npm run build:image      # build/images/ にルートファイルシステムを作る
npm run build:state                                   # VM内で10問を解き、build/images/alpine-state.bin.zst を保存する
npm run build:site                                    # dist/ に公開するファイルを集める
python3 -m http.server 8765 --directory dist          # http://localhost:8765/ で確認する
```

## 出題スクリプトの使い方

VM内の bash が `/root/.bash_profile` 経由で `quiz.sh` を読み込みます。
リポジトリ内では `vm/home/bash_profile` と `vm/home/gitconfig` という先頭にドットのない名前で置いてあり、Dockerfile で `/root/.bash_profile` と `/root/.gitconfig` にコピーします。

- `quiz`：問題の一覧を表示する
- `quiz <番号>`：`~/q<番号>` に壊れたリポジトリを作り、そこへ移動する
- `quiz check`：いまの問題が未クリアである理由を1行表示する
- `quiz reset`：作業ディレクトリをすべて消す

`PROMPT_COMMAND` に `__quiz_prompt` を設定してあり、コマンドを1つ実行するたびに判定が走ります。
判定は全問共通で、次の条件をすべて満たすとクリアです。

1. `.git/index.lock` がない
2. Gitリポジトリとして認識される
3. bare リポジトリではない
4. `HEAD` が `refs/heads/main` を指している
5. `main` が `434dcb3f0533968183d0d695054f100fefc42291` を指している
6. `git status` が成功する
7. index が `HEAD` のコミットと一致している
8. `git fsck` が成功する

準備スクリプトは作者名と日時を固定しているので、コミットのハッシュ値はどの環境でも同じになります。
条件5はこの性質に依存しています。

## ページとVMの通信

通信はシリアルポート（ttyS0）1本だけで行います。

- **VMからページへ**：`quiz.sh` が OSC 777 のエスケープシーケンスを出力する。端末には表示されない。
  - `ESC ] 777 ; quiz;start;<番号> BEL`：問題を開始した
  - `ESC ] 777 ; quiz;goal;<番号> BEL`：クリアした
  - `ESC ] 777 ; quiz;prompt;<現在の番号>;<クリア済みなら1> BEL`：プロンプトを表示する直前に毎回出す
- **ページからVMへ**：ターミナルに文字を送る。問題を選ぶボタンは `quiz 4` と改行を送るだけ。

ページ側は xterm.js の `term.parser.registerOscHandler(777, handler)` で受け取る想定です。
`prompt` の通知は、VMの準備完了の検知と、ページ側の状態の同期に使えます。

## .git エクスプローラー

ターミナルの下に、いまの問題のリポジトリ（`~/q<番号>`）の中身をクリックでたどれる画面があります（`site/explorer.js`）。

- VMのルートは 9p なので、v86 が持つファイルシステムをページ側から直接読む（`emulator.fs9p.read_dir`、`SearchPath`、`GetInode`、`emulator.read_file`）。シリアルポートは使わない
- `git` コマンドは使わず、`.git` の中のファイルをページ側で解釈する。壊れたリポジトリでも表示できるようにするため
- loose オブジェクトと packfile は pako（`vendor/pako_inflate.js`）で展開する。packfile は `.idx` を使わず先頭から順に読む
- `quiz;prompt` の通知が来るたび（コマンドを1つ実行するたび）に全体を読み直す。前回から変わったファイルには「更新」の印を付ける
- 表示するもの：ファイルの一覧、HEAD からたどった参照のつながり、index の中身、オブジェクト（commit、tree、blob）の中身、そのオブジェクトを指しているもの

## 実装メモ

- v86 の変換ツールと BIOS は、npm の `v86@0.5.473` と同じ版（コミット `315b2b0b758703ef0e6cc7b4088d6068f83f3c20`）の v86 リポジトリを `.cache/v86` に取得して使う
- Dockerfile は v86 公式の `tools/docker/alpine/Dockerfile` がもと。`bash git nano less file` を足し、root のログインシェルを `/bin/bash` にしている
- `memory_size`（256MB）、`vga_memory_size`、端末の大きさ（34行×120桁）は `scripts/build-state.mjs` と `site/main.js` で同じ値にする
- ページは起動済み状態を `initial_state` で読み込む。復元の直後に送った入力はVMに届かないことがあるので、`quiz;prompt` の通知が来るまで改行を送り直し、通知が来たら `clear` を送って画面を空にする
- 問題文とヒントは `site/quizzes.js` にある。番号とタイトルは `quiz.sh` と揃える
- クリア状況は `localStorage` に保存する

## 残りの作業

- .git エクスプローラー（`site/explorer.js`）のコミットと push
- GitHub Actions の各アクションが Node.js 20 向けで、非推奨の警告が出ている（動作には影響なし）

## 確かめたことと、確かめていないこと

確かめたこと（2026-11-14、macOS、Docker 29.4、Node.js 25.9）：

- `scripts/test-native.sh` が10問とも通る（Git 2.43.0 の Linux、Git 2.45.2 の macOS）
- VM内で、解答例どおりに操作すると10問ともゴール判定になる（`scripts/build-state.mjs`）
- コマンド1つの実行と判定にかかる時間は、VM内で最大約0.5秒
- 起動済み状態は約26MB、`dist/` 全体で約74MB
- ブラウザで、問題の選択、キー入力、ゴール表示、クリア状況の表示が動く
- 各問題の「最初に試すコマンド」とヒントのコマンドが、説明どおりの出力になる
- GitHub Actions でのビルドとデプロイが成功し、公開ページで問題9をゴールまで解ける
- .git エクスプローラーが、10問とも壊れた箇所を示す（空の HEAD、空の参照、読めない index、壊れたオブジェクト、索引のない packfile）
- 問題9を解くと、作られた `.idx` が一覧に「更新」の印付きで現れる

確かめていないこと：

- .git エクスプローラーの、幅の広い画面（2列の配置）とダークモードでの見た目
- Chrome 系以外のブラウザと、スマートフォンでの動作
- `nano` の画面表示

## 問題の一覧

| 番号 | 症状 | 壊す場所 | 直し方 |
| --- | --- | --- | --- |
| 1 | 別のGitプロセスが動いていると言われる | `.git/index.lock` の残留 | 削除する |
| 2 | 設定ファイルの1行目が不正だと言われる | `.git/config` の構文 | 見出しを書き直す |
| 3 | 作業ツリーの中で実行しろと言われる | `core.bare` | `false` に戻す |
| 4 | リポジトリとして認識されない | `.git/HEAD` | `HEAD` を書き直す |
| 5 | indexファイルが壊れていると言われる | `.git/index` | 削除して `git reset` |
| 6 | コミット済みなのに No commits yet | `.git/refs/heads/main` | ハッシュ値を書き戻す |
| 7 | コミット済みのファイルを表示できない | blob | 削除して `git hash-object -w` |
| 8 | 履歴は見えるのに状態を表示できない | tree | 削除して `git write-tree` |
| 9 | HEADが不正なオブジェクトだと言われる | packfile の `.idx` | `git index-pack` |
| 10 | 最新のコミットが読めない | commit | 削除して `git commit-tree` |

各問題の解説は、もとになったブログ記事の原稿にあります。
