// 解説に載せる図。.git の中のファイルのつながりと、「何から何を作り直せるか」を1枚に描く。
// map を渡すと、その問題で原因になった場所と、直すときに使う関係を赤で目立たせる。
//   map.broken … 原因の場所（NODES のキー）
//   map.edges  … 直すときに使う関係の配列。[材料, 作り直すもの, ラベル, ラベルの位置（省略可）]
//   map.note   … 原因の場所の右に書く短い説明（行の配列）
const RecoveryMap = (() => {
  const W = 180, H = 52;
  const NODES = {
    config: { x: 10, y: 10, t: ".git/config", s: "リポジトリの設定" },
    head: { x: 10, y: 92, t: ".git/HEAD", s: "いまのブランチ" },
    ref: { x: 10, y: 178, t: ".git/refs/heads/main", s: "ブランチの位置" },
    reflog: { x: 10, y: 278, t: ".git/logs（reflog）", s: "ブランチが動いた記録" },
    commit: { x: 295, y: 178, t: "コミット 434dcb3", s: "tree、親、作者、日時など" },
    tree: { x: 295, y: 278, t: "tree 1e5269c", s: "ファイル名と blob の一覧" },
    blob: { x: 295, y: 378, t: "blob 55bcbcb", s: "app.py の内容" },
    index: { x: 570, y: 278, t: ".git/index", s: "次のコミットの下書き" },
    worktree: { x: 570, y: 378, t: "作業ツリー", s: "app.py（編集中のファイル）" },
    pack: { x: 295, y: 478, t: "pack-….pack", s: "オブジェクトの本体" },
    idx: { x: 570, y: 478, t: "pack-….idx", s: "オブジェクトの位置の索引" },
  };
  // Git が現在のコミットとファイルにたどり着くまでに読む順番。
  const REFS = [["head", "ref", "ブランチ名"], ["ref", "commit", "ハッシュ値"], ["commit", "tree"], ["tree", "blob"]];
  // 作り直せる関係。[材料, 作り直せるもの, 線をずらす量]
  const FIXES = [
    ["reflog", "ref", 0], ["reflog", "commit", 0], ["index", "commit", 0],
    ["tree", "index", -9], ["index", "tree", 9], ["worktree", "blob", 0], ["pack", "idx", 0],
  ];

  const svgEl = (tag, attrs, text) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const center = (n) => [n.x + W / 2, n.y + H / 2];

  // 箱の中心どうしを結ぶ線を、それぞれの箱の縁で切る。off は線を横へずらす量。
  function segment(a, b, off) {
    let [x1, y1] = center(a), [x2, y2] = center(b);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    const clip = Math.min(dx ? (W / 2) / Math.abs(dx) : Infinity, dy ? (H / 2) / Math.abs(dy) : Infinity);
    const gap = 4 / len;
    const p = [x1 + dx * clip, y1 + dy * clip, x2 - dx * (clip + gap), y2 - dy * (clip + gap)];
    const nx = -dy / len * off, ny = dx / len * off;
    return [p[0] + nx, p[1] + ny, p[2] + nx, p[3] + ny];
  }

  // 線と、その先の矢じりを描く。
  function arrow(parent, [x1, y1, x2, y2], kind) {
    const angle = Math.atan2(y2 - y1, x2 - x1), size = kind === "key" ? 11 : 8;
    const tip = (da) => `${x2 - size * Math.cos(angle + da)},${y2 - size * Math.sin(angle + da)}`;
    const g = svgEl("g", { class: `map-arrow map-${kind}` });
    g.append(
      svgEl("line", { x1, y1, x2: x2 - (size - 2) * Math.cos(angle), y2: y2 - (size - 2) * Math.sin(angle) }),
      svgEl("polygon", { points: `${x2},${y2} ${tip(0.42)} ${tip(-0.42)}` }));
    parent.append(g);
    return g;
  }

  // 線のそばのラベル。横の線なら箱の上端より上に、縦の線なら線の右に置く。
  function label(parent, a, b, seg, text, kind, pos) {
    let x = (seg[0] + seg[2]) / 2, y = (seg[1] + seg[3]) / 2, anchor = "middle";
    if (pos) [x, y, anchor] = pos;
    else if (Math.abs(seg[1] - seg[3]) < 1) y = Math.min(a.y, b.y) - 7;
    else if (Math.abs(seg[0] - seg[2]) < 1) { x += 9; y += 4; anchor = "start"; }
    else y -= 9;
    parent.append(svgEl("text", { x, y, "text-anchor": anchor, class: `map-label map-label-${kind}` }, text));
  }

  function render(map) {
    const svg = svgEl("svg", { viewBox: "0 -14 760 566", class: "recovery-map", role: "img" });
    const keyEdges = (map && map.edges) || [];
    const isKey = (from, to) => keyEdges.some((e) => e[0] === from && e[1] === to);

    svg.append(
      svgEl("rect", { x: 280, y: 148, width: 210, height: 296, rx: 9, class: "map-group" }),
      svgEl("text", { x: 291, y: 166, class: "map-g" }, ".git/objects"),
      svgEl("rect", { x: 280, y: 452, width: 480, height: 90, rx: 9, class: "map-group" }),
      svgEl("text", { x: 291, y: 469, class: "map-g" }, ".git/objects/pack"));

    for (const [from, to, text] of REFS) {
      const seg = segment(NODES[from], NODES[to], 0);
      arrow(svg, seg, "ref");
      if (text) label(svg, NODES[from], NODES[to], seg, text, "ref");
    }
    for (const [from, to, off] of FIXES) {
      if (isKey(from, to)) continue;
      const g = arrow(svg, segment(NODES[from], NODES[to], off), "fix");
      if (map) g.classList.add("map-dim");
    }

    for (const [key, n] of Object.entries(NODES)) {
      const broken = map && map.broken === key;
      svg.append(
        svgEl("rect", { x: n.x, y: n.y, width: W, height: H, rx: 7, class: broken ? "map-box map-broken" : "map-box" }),
        svgEl("text", { x: n.x + W / 2, y: n.y + 22, "text-anchor": "middle", class: "map-t" }, n.t),
        svgEl("text", { x: n.x + W / 2, y: n.y + 40, "text-anchor": "middle", class: "map-s" }, n.s));
      if (!broken) continue;
      svg.append(
        svgEl("rect", { x: n.x + 8, y: n.y - 10, width: 62, height: 19, rx: 9.5, class: "map-tag" }),
        svgEl("text", { x: n.x + 39, y: n.y + 3.5, "text-anchor": "middle", class: "map-tag-text" }, "原因の場所"));
      (map.note || []).forEach((line, i) => {
        svg.append(svgEl("text", {
          x: n.x + W + 12,
          y: n.y + H / 2 - (map.note.length - 1) * 8 + 4 + i * 16,
          class: "map-label map-label-key",
        }, line));
      });
    }

    // 直すときに使う関係は、箱より手前に描く。
    for (const [from, to, text, pos] of keyEdges) {
      const base = FIXES.find((f) => f[0] === from && f[1] === to);
      const seg = segment(NODES[from], NODES[to], base ? base[2] : 0);
      arrow(svg, seg, "key");
      if (text) label(svg, NODES[from], NODES[to], seg, text, "key", pos);
    }

    // 凡例
    const legend = [["ref", "Git がたどる順"], ["fix", "材料 → 作り直せるもの"]];
    if (map) legend.push(["key", "この問題で使う関係"]);
    legend.forEach(([kind, text], i) => {
      const y = 462 + i * 24;
      arrow(svg, [14, y, 58, y], kind);
      svg.append(svgEl("text", { x: 68, y: y + 4, class: `map-label map-label-${kind === "key" ? "key" : "ref"}` }, text));
    });
    return svg;
  }

  return { render };
})();
