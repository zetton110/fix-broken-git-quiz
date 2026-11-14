"use strict";

// scripts/build-state.mjs と同じ値にすること。
const MEMORY_SIZE = 256 * 1024 * 1024;
const VGA_MEMORY_SIZE = 2 * 1024 * 1024;
const ROWS = 28;
const COLS = 100;
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
  theme: { background: "#14171c", foreground: "#e4e7eb" },
});
term.open($("terminal"));

term.parser.registerOscHandler(777, data => {
  const [tag, kind, a, b] = data.split(";");
  if (tag !== "quiz") return false;
  if (kind === "start") onStart(Number(a));
  else if (kind === "goal") onGoal(Number(a));
  else if (kind === "prompt") onPrompt(Number(a), b === "1");
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
function flushOutput() {
  term.write(new Uint8Array(outBuffer));
  outBuffer = [];
}

const encoder = new TextEncoder();
function send(text) {
  emulator.serial_send_bytes(0, encoder.encode(text));
}
term.onData(data => {
  if (state.ready) send(data);
});

emulator.add_listener("download-progress", e => {
  if (state.ready) return;
  const percent = e.lengthComputable && e.total ? ` ${Math.floor((e.loaded / e.total) * 100)}%` : "";
  setStatus(`読み込んでいます…${percent}`);
});
emulator.add_listener("download-error", () => {
  setStatus("読み込みに失敗しました。ページを再読み込みしてください。", true);
});
emulator.add_listener("emulator-ready", () => {
  setStatus("起動しています…");
  // 保存しておいた状態はプロンプトで止まっている。改行を送って prompt 通知を出させ、準備完了を知る。
  // 状態の復元の直後に送った入力は届かないことがあるので、通知が来るまで送り直す。
  const ping = setInterval(() => {
    if (state.ready) clearInterval(ping);
    else send("\n");
  }, 300);
});

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = text === "";
}

// ---- VMからの通知 ----

function onPrompt(current, done) {
  if (!state.ready) {
    state.ready = true;
    setStatus("");
    document.body.classList.add("ready");
    send("clear; quiz\n");
    term.focus();
  }
  if (current !== state.current) {
    state.current = current;
    renderPanel();
    renderList();
  }
  if (current && done && !state.cleared.has(current)) markCleared(current);
  // プロンプトが出るたび（コマンドを1つ実行するたび）に、リポジトリの中身の表示を更新する。
  Explorer.refresh(current);
}

function onStart(n) {
  state.current = n;
  $("goal").hidden = true;
  $("explain").open = false;
  renderPanel();
  renderList();
}

function onGoal(n) {
  markCleared(n);
  const next = n < QUIZZES.length ? n + 1 : 0;
  $("goal-text").textContent = next
    ? `ゴール！ 問題${n} をクリアしました。`
    : `ゴール！ 問題${n} をクリアしました。これで全問クリアです。`;
  const button = $("goal-next");
  button.hidden = !next;
  button.textContent = next ? `問題${next} へ進む` : "";
  button.onclick = () => startQuiz(next);
  $("goal").hidden = false;
  $("explain").open = true;
}

function markCleared(n) {
  state.cleared.add(n);
  saveCleared();
  renderList();
  renderExplain();
}

// 解説は、クリアしたことのある問題にだけ表示する。クリアした直後は開いた状態にする。
function renderExplain() {
  const quiz = QUIZZES[state.current - 1];
  const box = $("explain");
  box.hidden = !quiz || !state.cleared.has(state.current);
  if (box.hidden) return;
  $("explain-title").textContent = `問題${state.current} の解説`;
  $("explain-body").replaceChildren(...quiz.explain.map(text => {
    const p = document.createElement("p");
    // `…` で囲んだ部分をコードとして表示する。
    text.split("`").forEach((part, i) => {
      if (i % 2 === 0) p.append(part);
      else p.append(Object.assign(document.createElement("code"), { textContent: part }));
    });
    return p;
  }));
}

// ---- 画面 ----

function startQuiz(n) {
  if (!state.ready) return;
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
    if (cleared) {
      button.classList.add("cleared");
      mark.setAttribute("aria-label", `問題${n}、クリア済み`);
    }
    const title = document.createElement("span");
    title.textContent = quiz.title;
    button.append(mark, title);
    button.addEventListener("click", () => startQuiz(n));
    const li = document.createElement("li");
    li.append(button);
    list.append(li);
  });
  $("progress").textContent = `${state.cleared.size} / ${QUIZZES.length}`;
}

function renderPanel() {
  renderExplain();
  const quiz = QUIZZES[state.current - 1];
  if (!quiz) return;
  $("panel-title").textContent = `問題${state.current}：${quiz.title}`;
  $("panel-symptom").textContent = quiz.symptom;
  $("panel-first-command").textContent = quiz.first;
  $("panel-first").hidden = false;
  const hints = $("panel-hints");
  hints.replaceChildren();
  quiz.hints.forEach(([heading, text, command], i) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = i === quiz.hints.length - 1 ? heading : `ヒント${i + 1}：${heading}`;
    const p = document.createElement("p");
    p.textContent = text;
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
  if (!confirm("クリア状況を消しますか？")) return;
  state.cleared.clear();
  saveCleared();
  renderList();
  renderExplain();
});

renderList();
