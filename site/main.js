"use strict";

// scripts/build-state.mjs と同じ値にすること。
const MEMORY_SIZE = 256 * 1024 * 1024;
const VGA_MEMORY_SIZE = 2 * 1024 * 1024;
const ROWS = 34;
const COLS = 110;
const STORAGE_KEY = "fix-broken-git-quiz:cleared";

const $ = id => document.getElementById(id);
const state = { ready: false, current: 0, cleared: loadCleared() };

function loadCleared() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(saved.filter(n => Number.isInteger(n) && n >= 1 && n <= QUIZZES.length));
  } catch {
    return new Set();
  }
}

function saveCleared() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.cleared]));
  } catch {
    // 保存できなくても、このページを開いているあいだは動く。
  }
}

// ---- ターミナルとVM ----

const term = new Terminal({
  rows: ROWS,
  cols: COLS,
  fontSize: 14,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", "MS Gothic", monospace',
  cursorBlink: true,
  theme: { background: "#1a2638", foreground: "#e4e9ef" },
  // VM の中のプログラムが出したリンク（OSC 8）は開かない。問題ではリンクを使わないので、
  // 見た目だけのリンクで別のサイトへ誘導されないようにする。
  linkHandler: { activate() {} },
});
term.open($("terminal"));

// VM からの通知。VM の中では利用者が何でも出力できるので、問題番号は範囲を確かめてから使う。
term.parser.registerOscHandler(777, data => {
  const [tag, kind, a, b] = data.split(";");
  if (tag !== "quiz") return false;
  const n = /^\d{1,2}$/.test(a) ? Number(a) : -1;
  const isQuiz = n >= 1 && n <= QUIZZES.length;
  if (kind === "start" && isQuiz) onStart(n);
  else if (kind === "goal" && isQuiz) onGoal(n);
  else if (kind === "prompt" && (n === 0 || isQuiz)) onPrompt(n, b === "1");
  return true;
});

const emulator = new V86({
  wasm_path: "vendor/v86.wasm",
  memory_size: MEMORY_SIZE,
  vga_memory_size: VGA_MEMORY_SIZE,
  bios: { url: "bios/seabios.bin" },
  vga_bios: { url: "bios/vgabios.bin" },
  filesystem: {
    baseurl: "images/alpine-rootfs-flat",
    basefs: "images/alpine-fs.json",
  },
  bzimage_initrd_from_filesystem: true,
  cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable",
  initial_state: { url: "images/alpine-state.bin.zst" },
  autostart: true,
  disable_keyboard: true,
  disable_mouse: true,
  disable_speaker: true,
});

Explorer.attach(emulator);

// VMの出力は1バイトずつ届く。日本語（UTF-8）が途中で切れないよう、バイト列のまま渡す。
let outBuffer = [];
emulator.add_listener("serial0-output-byte", byte => {
  if (outBuffer.length === 0) setTimeout(flushOutput, 0);
  outBuffer.push(byte);
});
// 問題を準備しているあいだ（muted）は、VMの出力を画面に出さない。
// ページが送ったコマンドや準備中の表示を見せないためで、通知（OSC 777）だけを拾う。
let muted = false;
let startSeen = false;
let held = [];
function flushOutput() {
  let bytes = outBuffer;
  outBuffer = [];
  if (muted) {
    held.push(...bytes);
    const text = String.fromCharCode(...held);
    const pattern = /\x1b\]777;([^\x07]*)\x07/g;
    let end = 0, match;
    while (muted && (match = pattern.exec(text))) {
      term.write(new Uint8Array(held.slice(match.index, pattern.lastIndex)));
      end = pattern.lastIndex;
      // 問題の開始の通知のあとにプロンプトの通知が来たら準備は終わり。ここから先の出力（プロンプト）を画面に出す。
      // 開始より前のプロンプトの通知は、それ以前の入力（起動時に送った改行など）のものなので待ち続ける。
      if (match[1].startsWith("quiz;start;")) startSeen = true;
      else if (startSeen && match[1].startsWith("quiz;prompt;")) muted = false;
    }
    if (muted) {
      // 通知が途中で切れているかもしれないので、最後の ESC 以降だけ残す。
      const esc = text.lastIndexOf("\x1b");
      held = esc >= end ? held.slice(esc) : [];
      return;
    }
    bytes = held.slice(end);
    held = [];
    setPreparing(0);
    setStatus("");
    term.write("\x1b[2J\x1b[3J\x1b[H");
  }
  term.write(new Uint8Array(bytes));
}

const encoder = new TextEncoder();
function send(text) {
  emulator.serial_send_bytes(0, encoder.encode(text));
}
term.onData(data => {
  if (state.ready && state.current && !muted) send(data);
});

emulator.add_listener("download-progress", e => {
  if (state.ready) return;
  const percent = e.lengthComputable && e.total ? ` ${Math.floor((e.loaded / e.total) * 100)}%` : "";
  setStatus(`読み込んでいます…${percent}`, false, true);
});
emulator.add_listener("download-error", () => {
  setStatus("読み込みに失敗しました。ページを再読み込みしてください。", true);
});
emulator.add_listener("emulator-ready", () => {
  setStatus("起動しています…", false, true);
  // 保存しておいた状態はプロンプトで止まっている。改行を送って prompt 通知を出させ、準備完了を知る。
  // 状態の復元の直後に送った入力は届かないことがあるので、通知が来るまで送り直す。
  const ping = setInterval(() => {
    if (state.ready) clearInterval(ping);
    else send("\n");
  }, 300);
});

// busy を true にすると、文の前に回転する印を出して、待っていることを示す。
function setStatus(text, isError = false, busy = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("busy", busy);
  el.hidden = text === "";
}

// 問題を準備しているあいだ（quiz コマンドを送ってからプロンプトが出るまで）は、
// 押したボタンと問題の番号に読み込み中の印を出す。0 で終わり。
let preparing = 0;
function setPreparing(n) {
  preparing = n;
  document.body.classList.toggle("preparing", n !== 0);
  renderOnboarding();
  renderList();
}

// ---- VMからの通知 ----

function onPrompt(current, done) {
  if (!state.ready) {
    state.ready = true;
    setStatus("上の番号から問題を選ぶと、ここにその問題のターミナルが表示されます。");
    document.body.classList.add("ready");
    renderOnboarding();
    send("clear\n");
  }
  if (current !== state.current) {
    state.current = current;
    renderPanel();
    renderList();
  }
  if (current && done && !state.cleared.has(current)) markCleared(current);
  // プロンプトが出るたび（コマンドを1つ実行するたび）に、.git エクスプローラーを更新する。たたんでいるあいだは読まない。
  if (explorerOpen) Explorer.refresh(current);
}

function onStart(n) {
  state.current = n;
  if ($("goal-dialog").open) $("goal-dialog").close();
  renderPanel();
  renderList();
  // 問題文を最初から読めるよう、ページの最上部に戻す。
  window.scrollTo(0, 0);
}

function onGoal(n) {
  markCleared(n);
  showGoal(n, true);
}

function markCleared(n) {
  state.cleared.add(n);
  saveCleared();
  renderList();
  renderExplainButton();
}

// ゴールしたときに、ゴールの知らせ・解説・次の問題へ進むボタンをモーダルダイアログで表示する。
// クリア済みの問題では、問題文の下のボタンから同じダイアログで解説を読み返せる（justCleared = false）。
function showGoal(n, justCleared) {
  const quiz = QUIZZES[n - 1];
  const dialog = $("goal-dialog");
  const next = n < QUIZZES.length ? n + 1 : 0;
  dialog.classList.toggle("review", !justCleared);
  if (!justCleared) $("goal-text").textContent = `問題${n}：${quiz.title}`;
  else if (next) $("goal-text").textContent = `ゴール！ 問題${n} をクリアしました`;
  else $("goal-text").textContent = `ゴール！ 問題${n} をクリアしました。これで全問クリアです`;
  renderExplain(quiz.explain);
  const button = $("goal-next");
  button.hidden = !next;
  button.textContent = next ? `問題${next} へ進む` : "";
  button.onclick = () => {
    dialog.close();
    startQuiz(next);
  };
  if (!dialog.open) dialog.showModal();
  // 閉じているあいだはスクロール位置を変えられないので、開いてから先頭に戻す。
  document.querySelector(".goal-body").scrollTop = 0;
}

$("goal-close").addEventListener("click", () => $("goal-dialog").close());
// 枠の外（背景）をクリックしても閉じる。
$("goal-dialog").addEventListener("click", e => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$("goal-dialog").addEventListener("close", () => term.focus());
$("explain-open").addEventListener("click", () => showGoal(state.current, false));

// クリアしたことのある問題には、解説を読み返すボタンを出す。
// 問題を選ぶ前の画面（使い方）のボタン。まだクリアしていない最初の問題から始める。
function firstUncleared() {
  for (let n = 1; n <= QUIZZES.length; n++) if (!state.cleared.has(n)) return n;
  return 1;
}
function renderOnboarding() {
  const button = $("onboarding-start");
  button.disabled = !state.ready || preparing !== 0;
  button.classList.toggle("busy", preparing !== 0);
  if (preparing) {
    button.textContent = `問題${preparing} を準備しています…`;
    return;
  }
  if (!state.ready) return;
  const n = firstUncleared();
  button.textContent = state.cleared.size && state.cleared.size < QUIZZES.length ? `続きから始める（問題${n}）` : "問題1 から始める";
}
$("onboarding-start").addEventListener("click", () => startQuiz(firstUncleared()));

function renderExplainButton() {
  $("explain-open").hidden = !state.current || !state.cleared.has(state.current);
}

// 解説を組み立てる。最初に要点（原因・直し方・覚えておくこと）、次に見出しつきのくわしい説明、
// 最後に、文中でリンクした Pro Git の箇所の一覧を並べる。要点の次には、原因の場所と直し方を示す図を置く。
function renderExplain(explain) {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const used = new Set();
  const points = el("dl", "explain-points");
  for (const [label, text] of explain.points) points.append(el("dt", "", label), rich(el("dd"), text, used));
  const details = el("div", "explain-details");
  for (const [heading, text] of explain.details) {
    const section = el("section");
    section.append(el("h4", "", heading), rich(el("p"), text, used));
    details.append(section);
  }
  const refs = el("ul", "explain-refs");
  for (const key of used) {
    const li = el("li");
    li.append(bookLink(key, LINKS[key][1]));
    refs.append(li);
  }
  const figure = [];
  if (explain.map) {
    const fig = el("figure", "explain-map");
    const scroll = el("div", "explain-map-scroll");
    const svg = RecoveryMap.render(explain.map);
    svg.setAttribute("aria-label", ".git の中のつながりと、この問題で原因になった場所、直すときに使った関係の図");
    scroll.append(svg);
    fig.append(scroll, rich(el("figcaption"), explain.map.point));
    figure.push(el("h3", "", "図で見る"), fig);
  }
  $("explain-body").replaceChildren(
    el("h3", "", "ポイント"), points,
    ...figure,
    el("h3", "", "くわしく"), details,
    el("h3", "", "Pro Git で読む"), refs);
}

// Pro Git 日本語版の該当箇所へのリンク。別のタブで開く。
function bookLink(key, text) {
  const a = document.createElement("a");
  a.href = BOOK + encodeURI(LINKS[key][0]);
  a.target = "_blank";
  a.rel = "noopener";
  a.title = `Pro Git：${LINKS[key][1]}`;
  if (text) a.textContent = text;
  return a;
}

// 文章を要素に入れる。`…` で囲んだ部分はコードとして、[文字](キー) は Pro Git へのリンクとして表示する。
// used を渡すと、リンクしたキーをそこに記録する。
function rich(el, text, used) {
  const pattern = /\[([^\]]+)\]\(([a-z-]+)\)|`([^`]+)`/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    el.append(text.slice(last, match.index));
    last = pattern.lastIndex;
    if (match[3] !== undefined) {
      el.append(Object.assign(document.createElement("code"), { textContent: match[3] }));
    } else {
      el.append(rich(bookLink(match[2]), match[1]));
      if (used) used.add(match[2]);
    }
  }
  el.append(text.slice(last));
  return el;
}

// 問題が起きた場面を、チャットの会話として表示する。
const SPEAKERS = { k: { name: "後輩", mark: "後" }, s: { name: "先輩（あなた）", mark: "先" } };
function renderChat(quiz) {
  $("panel-chat-messages").replaceChildren(...quiz.chat.map(([who, text], i) => {
    const li = document.createElement("li");
    const time = `10:${String(12 + i).padStart(2, "0")}`;
    const body = document.createElement("div");
    // 同じ人が続けて発言したときは、Slack と同じくアイコンと名前を省く。
    const continued = i > 0 && quiz.chat[i - 1][0] === who;
    li.className = `chat-message ${who === "s" ? "senpai" : "kohai"}${continued ? " continued" : ""}`;
    if (continued) {
      li.append(Object.assign(document.createElement("span"), { className: "chat-gutter", textContent: time }));
    } else {
      const avatar = Object.assign(document.createElement("span"), { className: "chat-avatar", textContent: SPEAKERS[who].mark });
      avatar.setAttribute("aria-hidden", "true");
      const head = document.createElement("div");
      head.className = "chat-head";
      head.append(
        Object.assign(document.createElement("strong"), { textContent: SPEAKERS[who].name }),
        Object.assign(document.createElement("span"), { className: "chat-time", textContent: time }));
      li.append(avatar);
      body.append(head);
    }
    body.append(rich(document.createElement("p"), text));
    li.append(body);
    return li;
  }));
  $("panel-chat").hidden = false;
  rich($("panel-situation"), quiz.situation);
  $("panel-situation").hidden = false;
}

// ---- 画面 ----

// .git エクスプローラーは、最初はたたんでおく。まずはターミナルで調べてもらうため。
let explorerOpen = false;
$("explorer-toggle").addEventListener("click", () => {
  explorerOpen = !explorerOpen;
  $("explorer").classList.toggle("collapsed", !explorerOpen);
  const button = $("explorer-toggle");
  button.textContent = explorerOpen ? "−" : "＋";
  button.title = explorerOpen ? "たたむ" : "開く";
  button.setAttribute("aria-label", explorerOpen ? ".git エクスプローラーをたたむ" : ".git エクスプローラーを開く");
  button.setAttribute("aria-expanded", String(explorerOpen));
  if (explorerOpen && state.ready) Explorer.refresh(state.current);
});

// 問題を始める（やり直すときも同じ）。VMには quiz <番号> を送るが、その入力や準備中の表示は画面に出さず、
// 準備が終わってから、その問題のディレクトリにいるプロンプトだけを見せる。
function startQuiz(n) {
  if (!state.ready || muted) return;
  muted = true;
  startSeen = false;
  held = [];
  setPreparing(n);
  setStatus(`問題${n} を準備しています…`, false, true);
  // Ctrl-U で入力途中の行を消してから送る。
  send(`\x15quiz ${n}\n`);
  term.focus();
}

function renderList() {
  const list = $("quiz-list");
  list.replaceChildren();
  QUIZZES.forEach((quiz, i) => {
    const n = i + 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiz-item";
    if (n === state.current) button.setAttribute("aria-current", "true");
    const mark = document.createElement("span");
    mark.className = "mark";
    const cleared = state.cleared.has(n);
    mark.textContent = cleared ? "✓" : String(n);
    if (cleared) button.classList.add("cleared");
    if (n === preparing) button.classList.add("preparing");
    // 一覧には番号だけを出す。タイトルはマウスを載せると出る。
    const label = `問題${n}：${quiz.title}${cleared ? "（クリア済み）" : ""}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(mark);
    button.addEventListener("click", () => startQuiz(n));
    const li = document.createElement("li");
    li.append(button);
    list.append(li);
  });
  $("progress").textContent = `${state.cleared.size} / ${QUIZZES.length}`;
}

function renderPanel() {
  renderExplainButton();
  const quiz = QUIZZES[state.current - 1];
  $("terminal-title").textContent = quiz ? `bash — ~/q${state.current}` : "bash";
  $("panel").classList.toggle("started", Boolean(quiz));
  if (!quiz) return;
  $("panel-title").textContent = `問題${state.current}：${quiz.title}`;
  $("panel-situation").replaceChildren();
  renderChat(quiz);
  $("panel-symptom").textContent = quiz.symptom;
  $("panel-first-command").textContent = quiz.first;
  $("panel-first").hidden = false;
  const hints = $("panel-hints");
  hints.replaceChildren();
  quiz.hints.forEach(([heading, text, command], i) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = i === quiz.hints.length - 1 ? heading : `ヒント${i + 1}：${heading}`;
    const p = rich(document.createElement("p"), text);
    details.append(summary, p);
    if (command) {
      const pre = document.createElement("pre");
      pre.textContent = command;
      details.append(pre);
    }
    hints.append(details);
  });
}

$("clear-progress").addEventListener("click", () => {
  if (!confirm("クリア状況を消して、最初の画面に戻りますか？")) return;
  state.cleared.clear();
  saveCleared();
  // ページを読み込み直して、VMごと最初の状態（問題を選ぶ前の画面）に戻す。
  location.reload();
});

renderList();
