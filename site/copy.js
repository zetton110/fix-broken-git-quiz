"use strict";
// コマンドをコピーするボタン。ターミナルに貼って試せるよう、コマンドを示している箇所の右に置く。
// 目立たせないよう、文字ではなく小さなアイコンで出す。
// getText はコピーする文字を返す関数（押した時点の内容をコピーするため）。
const COPY_ICONS = {
  // 重なった2枚の紙
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/>',
  // チェックの印
  done: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
  // ×の印
  failed: '<path d="M4 4l8 8M12 4l-8 8"/>',
};
const COPY_LABELS = { copy: "コマンドをコピーする", done: "コピーしました", failed: "コピーできませんでした" };
function copyButton(getText) {
  const button = document.createElement("button");
  button.type = "button";
  let timer;
  // ボタンの絵と、マウスを載せたときや読み上げで伝える文を切り替える。
  function show(state) {
    button.className = state === "copy" ? "copy" : `copy ${state}`;
    button.title = COPY_LABELS[state];
    button.setAttribute("aria-label", COPY_LABELS[state]);
    button.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${COPY_ICONS[state]}</svg>`;
  }
  show("copy");
  button.addEventListener("click", async () => {
    const text = getText();
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードへの書き込みが許可されていない環境では、文字を選択してコピーする古い方法を試す。
      const area = document.createElement("textarea");
      area.readOnly = true;
      area.style.cssText = "position: fixed; opacity: 0;";
      area.value = text;
      document.body.append(area);
      area.select();
      ok = document.execCommand("copy");
      area.remove();
    }
    // コピーできたことを、アイコンを少しのあいだチェックの印に変えて知らせる。
    show(ok ? "done" : "failed");
    clearTimeout(timer);
    timer = setTimeout(() => show("copy"), 1500);
  });
  return button;
}
