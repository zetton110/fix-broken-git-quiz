"use strict";
// いまの問題のリポジトリ（~/q<番号>）の中身を、クリックでたどれるように表示する。
// VMのルートは 9p なので、v86 が持っているファイルシステムをページ側から直接読める。
// git コマンドは使わず、.git の中のファイルをここで解釈する。壊れたリポジトリでも見られるようにするため。
const Explorer = (() => {
  const $ = id => document.getElementById(id);
  const decoder = new TextDecoder();
  const strictDecoder = new TextDecoder("utf-8", { fatal: true });
  const TYPE_NAMES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
  const DEFAULT_EXPANDED = [".git", ".git/refs", ".git/refs/heads", ".git/objects", ".git/objects/pack"];

  let emulator = null;
  let quiz = 0;
  let root = "";
  let model = null;
  let seq = 0;
  let selection = { kind: "overview" };
  let history = [];
  let expanded = new Set(DEFAULT_EXPANDED);
  let stamps = new Map();
  let changed = new Set();

  // ---- ファイルシステムの読み出し ----

  const abs = rel => (rel ? `${root}/${rel}` : root);

  function stat(rel) {
    try {
      const found = emulator.fs9p.SearchPath(abs(rel));
      if (found.id === -1) return null;
      const inode = emulator.fs9p.GetInode(found.id);
      return { dir: (inode.mode & 0o170000) === 0o040000, size: inode.size, mtime: inode.mtime };
    } catch {
      return null;
    }
  }

  async function read(rel) {
    const info = stat(rel);
    if (!info || info.dir) return null;
    if (info.size === 0) return new Uint8Array(0);
    try {
      return await emulator.read_file(abs(rel));
    } catch {
      return null;
    }
  }

  function walk(rel, files) {
    let names = [];
    try {
      names = emulator.fs9p.read_dir(abs(rel)) || [];
    } catch {
      // 一覧を取れないディレクトリは空として扱う。
    }
    const children = [];
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const info = stat(childRel);
      if (!info) continue;
      const node = { name, rel: childRel, dir: info.dir, size: info.size, mtime: info.mtime };
      if (info.dir) node.children = walk(childRel, files);
      else files.set(childRel, node);
      children.push(node);
    }
    children.sort((a, b) => (a.dir === b.dir ? (a.name < b.name ? -1 : 1) : a.dir ? -1 : 1));
    return children;
  }

  // ---- Git の形式の解釈 ----

  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const short = hash => hash.slice(0, 7);
  const isHash = text => /^[0-9a-f]{40}$/.test(text);

  async function sha1(bytes) {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));
  }

  // zlib のストリームを1つ展開し、どこまで読んだかも返す（packfile では次のオブジェクトが続くため）。
  function inflateAt(buf, offset) {
    if (buf.length < offset + 2 || (buf[offset] & 0x0f) !== 8 || ((buf[offset] << 8) | buf[offset + 1]) % 31 !== 0) {
      throw new Error("zlib で圧縮されたデータではありません");
    }
    const inflator = new pako.Inflate({ raw: true });
    inflator.push(buf.subarray(offset + 2), true);
    if (inflator.err) throw new Error("zlib の展開に失敗しました");
    return { data: inflator.result, end: offset + 2 + inflator.strm.total_in + 4 };
  }

  function parseLoose(raw) {
    const { data } = inflateAt(raw, 0);
    const nul = data.indexOf(0);
    const header = nul < 0 ? "" : decoder.decode(data.subarray(0, nul));
    const match = header.match(/^(commit|tree|blob|tag) (\d+)$/);
    if (!match) throw new Error("オブジェクトのヘッダが不正です");
    const body = data.subarray(nul + 1);
    if (body.length !== Number(match[2])) throw new Error("ヘッダの大きさと中身が合いません");
    return { type: match[1], body, full: data };
  }

  function applyDelta(base, delta) {
    let p = 0;
    const varint = () => {
      let result = 0, shift = 0, byte;
      do {
        byte = delta[p++];
        result |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      return result;
    };
    varint();
    const out = new Uint8Array(varint());
    let o = 0;
    while (p < delta.length) {
      const c = delta[p++];
      if (c & 0x80) {
        let from = 0, len = 0;
        if (c & 1) from = delta[p++];
        if (c & 2) from |= delta[p++] << 8;
        if (c & 4) from |= delta[p++] << 16;
        if (c & 8) from |= delta[p++] << 24;
        if (c & 16) len = delta[p++];
        if (c & 32) len |= delta[p++] << 8;
        if (c & 64) len |= delta[p++] << 16;
        if (!len) len = 0x10000;
        out.set(base.subarray(from, from + len), o);
        o += len;
      } else if (c) {
        out.set(delta.subarray(p, p + c), o);
        p += c;
        o += c;
      } else {
        throw new Error("差分データが不正です");
      }
    }
    return out;
  }

  // .idx を使わず、.pack を先頭から順に読んでオブジェクトを取り出す。
  async function parsePack(buf) {
    if (buf.length < 12 || decoder.decode(buf.subarray(0, 4)) !== "PACK") throw new Error("先頭4バイトが PACK ではありません");
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = view.getUint32(8);
    const entries = [];
    let p = 12;
    for (let i = 0; i < count; i++) {
      const entry = { offset: p };
      let byte = buf[p++];
      entry.kind = (byte >> 4) & 7;
      while (byte & 0x80) byte = buf[p++];
      if (entry.kind === 6) {
        byte = buf[p++];
        let back = byte & 0x7f;
        while (byte & 0x80) {
          byte = buf[p++];
          back = ((back + 1) << 7) | (byte & 0x7f);
        }
        entry.baseOffset = entry.offset - back;
      } else if (entry.kind === 7) {
        entry.baseHash = hex(buf.subarray(p, p + 20));
        p += 20;
      } else if (!TYPE_NAMES[entry.kind]) {
        throw new Error("packfile の中に不明な種類のオブジェクトがあります");
      }
      const inflated = inflateAt(buf, p);
      entry.data = inflated.data;
      p = inflated.end;
      entries.push(entry);
    }

    const byOffset = new Map(entries.map(e => [e.offset, e]));
    const byHash = new Map();
    const resolve = entry => {
      if (entry.type) return true;
      if (entry.kind <= 4) {
        entry.type = TYPE_NAMES[entry.kind];
        entry.body = entry.data;
        return true;
      }
      const base = entry.kind === 6 ? byOffset.get(entry.baseOffset) : byHash.get(entry.baseHash);
      if (!base || !resolve(base)) return false;
      entry.type = base.type;
      entry.body = applyDelta(base.body, entry.data);
      entry.delta = true;
      return true;
    };
    // 差分の元をハッシュ値で指すもの（REF_DELTA）は、元のハッシュ値が分かってから解決する。
    for (let pass = 0; pass < 2; pass++) {
      for (const entry of entries) {
        if (entry.hash || !resolve(entry)) continue;
        const header = new TextEncoder().encode(`${entry.type} ${entry.body.length}\0`);
        const full = new Uint8Array(header.length + entry.body.length);
        full.set(header);
        full.set(entry.body, header.length);
        entry.hash = await sha1(full);
        byHash.set(entry.hash, entry);
      }
    }
    return { count, entries };
  }

  function parseCommit(body) {
    const text = decoder.decode(body);
    const split = text.indexOf("\n\n");
    const head = split < 0 ? text : text.slice(0, split);
    const commit = { tree: null, parents: [], author: "", committer: "", message: split < 0 ? "" : text.slice(split + 2) };
    for (const line of head.split("\n")) {
      const space = line.indexOf(" ");
      const key = line.slice(0, space), value = line.slice(space + 1);
      if (key === "tree") commit.tree = value;
      else if (key === "parent") commit.parents.push(value);
      else if (key === "author") commit.author = value;
      else if (key === "committer") commit.committer = value;
    }
    commit.subject = commit.message.split("\n")[0];
    return commit;
  }

  function parseTree(body) {
    const entries = [];
    let p = 0;
    while (p < body.length) {
      const space = body.indexOf(32, p);
      const nul = body.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 21 > body.length) throw new Error("tree の中身が不正です");
      entries.push({
        mode: decoder.decode(body.subarray(p, space)),
        name: decoder.decode(body.subarray(space + 1, nul)),
        hash: hex(body.subarray(nul + 1, nul + 21)),
      });
      p = nul + 21;
    }
    return entries;
  }

  function parseIndex(buf) {
    if (buf.length < 12 || decoder.decode(buf.subarray(0, 4)) !== "DIRC") throw new Error("先頭4バイトが DIRC ではありません");
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = view.getUint32(4), count = view.getUint32(8);
    if (version !== 2 && version !== 3) throw new Error(`バージョン ${version} の index は、この画面では読めません`);
    const entries = [];
    let p = 12;
    for (let i = 0; i < count; i++) {
      if (p + 62 > buf.length) throw new Error("index が途中で切れています");
      const flags = view.getUint16(p + 60);
      const nameStart = p + 62 + (flags & 0x4000 ? 2 : 0);
      let nameEnd = nameStart;
      while (nameEnd < buf.length && buf[nameEnd] !== 0) nameEnd++;
      entries.push({
        mode: view.getUint32(p + 24).toString(8),
        size: view.getUint32(p + 36),
        hash: hex(buf.subarray(p + 40, p + 60)),
        path: decoder.decode(buf.subarray(nameStart, nameEnd)),
      });
      p += (nameEnd - p + 8) & ~7;
    }
    return { version, entries };
  }

  // ---- リポジトリ全体を読み、参照関係をまとめる ----

  async function build() {
    const files = new Map();
    const tree = walk("", files);
    const m = { tree, files, objects: new Map(), broken: new Map(), packs: new Map(), refs: new Map(), head: null, index: null, back: new Map() };

    for (const rel of files.keys()) {
      const loose = rel.match(/^\.git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/);
      if (loose) {
        const hash = loose[1] + loose[2];
        const raw = await read(rel);
        try {
          const object = parseLoose(raw);
          const actual = await sha1(object.full);
          m.objects.set(hash, { hash, type: object.type, body: object.body, rel, mismatch: actual === hash ? null : actual });
        } catch (error) {
          m.broken.set(hash, { rel, raw, reason: error.message });
        }
      }
    }
    for (const rel of files.keys()) {
      if (!/^\.git\/objects\/pack\/[^/]+\.pack$/.test(rel)) continue;
      const pack = { rel, hasIdx: files.has(rel.replace(/\.pack$/, ".idx")), entries: [], error: null };
      try {
        const parsed = await parsePack(await read(rel));
        pack.entries = parsed.entries.filter(e => e.hash);
        for (const e of pack.entries) {
          if (!m.objects.has(e.hash)) m.objects.set(e.hash, { hash: e.hash, type: e.type, body: e.body, pack: rel, mismatch: null });
        }
      } catch (error) {
        pack.error = error.message;
      }
      m.packs.set(rel, pack);
    }
    for (const object of m.objects.values()) {
      try {
        if (object.type === "commit") object.commit = parseCommit(object.body);
        else if (object.type === "tree") object.entries = parseTree(object.body);
      } catch (error) {
        object.parseError = error.message;
      }
    }

    const headRaw = await read(".git/HEAD");
    if (headRaw) {
      const text = decoder.decode(headRaw).trim();
      const symbolic = text.match(/^ref: (.+)$/);
      m.head = { text, ref: symbolic ? symbolic[1] : null, hash: isHash(text) ? text : null };
    }
    const packedRefs = await read(".git/packed-refs");
    if (packedRefs) {
      for (const line of decoder.decode(packedRefs).split("\n")) {
        const match = line.match(/^([0-9a-f]{40}) (refs\/.+)$/);
        if (match) m.refs.set(match[2], { name: match[2], text: match[1], hash: match[1], rel: ".git/packed-refs" });
      }
    }
    for (const rel of files.keys()) {
      if (!rel.startsWith(".git/refs/")) continue;
      const text = decoder.decode(await read(rel)).trim();
      const name = rel.slice(5);
      m.refs.set(name, { name, text, hash: isHash(text) ? text : null, rel });
    }
    const indexRaw = await read(".git/index");
    if (indexRaw) {
      try {
        m.index = parseIndex(indexRaw);
      } catch (error) {
        m.index = { error: error.message };
      }
    }

    // どこから指されているか（逆向きの参照）
    const point = (hash, label, target) => {
      if (!m.back.has(hash)) m.back.set(hash, []);
      m.back.get(hash).push({ label, target });
    };
    if (m.head && m.head.hash) point(m.head.hash, ".git/HEAD", { kind: "file", rel: ".git/HEAD" });
    for (const ref of m.refs.values()) {
      if (ref.hash) point(ref.hash, ref.rel === ".git/packed-refs" ? `.git/packed-refs の ${ref.name}` : ref.rel, { kind: "file", rel: ref.rel });
    }
    for (const object of m.objects.values()) {
      const target = { kind: "object", hash: object.hash };
      if (object.commit) {
        if (object.commit.tree) point(object.commit.tree, `commit ${short(object.hash)} の tree`, target);
        for (const parent of object.commit.parents) point(parent, `commit ${short(object.hash)} の parent（親コミット）`, target);
      } else if (object.entries) {
        for (const entry of object.entries) point(entry.hash, `tree ${short(object.hash)} の ${entry.name}`, target);
      }
    }
    if (m.index && m.index.entries) {
      for (const entry of m.index.entries) point(entry.hash, `index の ${entry.path}`, { kind: "file", rel: ".git/index" });
    }
    return m;
  }

  // ---- 表示の部品 ----

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children.flat().filter(child => child != null && child !== false));
    return node;
  }

  const badge = (text, kind = "") => el("span", { class: `badge ${kind}` }, text);

  function objectState(hash) {
    const object = model.objects.get(hash);
    if (object) return { text: object.type, kind: object.type };
    if (model.broken.has(hash)) return { text: "壊れている", kind: "bad" };
    return { text: "見つからない", kind: "bad" };
  }

  function objectLink(hash, full = false) {
    const state = objectState(hash);
    return el("span", { class: "object-link" },
      el("button", { type: "button", class: "x-link mono", title: hash, onclick: () => go({ kind: "object", hash }) }, full ? hash : short(hash)),
      badge(state.text, state.kind));
  }

  function fileLink(rel, label = rel) {
    return el("button", { type: "button", class: "x-link mono", onclick: () => go({ kind: "file", rel }) }, label);
  }

  // 文章の中の40桁のハッシュ値をリンクにする。
  function linkify(text) {
    return text.split(/\b([0-9a-f]{40})\b/).map((part, i) => {
      if (i % 2 === 0 || /^0+$/.test(part)) return part;
      return el("button", { type: "button", class: "x-link", title: "このオブジェクトを開く", onclick: () => go({ kind: "object", hash: part }) }, part);
    });
  }

  function hexdump(bytes, limit = 256) {
    const lines = [];
    for (let i = 0; i < Math.min(bytes.length, limit); i += 16) {
      const row = bytes.subarray(i, Math.min(i + 16, bytes.length));
      const hexPart = Array.from(row, b => b.toString(16).padStart(2, "0")).join(" ").padEnd(47);
      const ascii = Array.from(row, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
      lines.push(`${i.toString(16).padStart(6, "0")}  ${hexPart}  ${ascii}`);
    }
    if (bytes.length > limit) lines.push(`…（全 ${bytes.length} バイトのうち、先頭 ${limit} バイト）`);
    return el("pre", { class: "dump" }, lines.join("\n"));
  }

  function asText(bytes) {
    try {
      const text = strictDecoder.decode(bytes);
      return text.includes("\0") ? null : text;
    } catch {
      return null;
    }
  }

  // テキストならそのまま、バイナリなら16進ダンプで見せる。
  function content(bytes) {
    if (bytes.length === 0) return el("p", { class: "empty" }, "（空のファイルです。0バイト）");
    const text = asText(bytes);
    return text === null ? hexdump(bytes) : el("pre", {}, linkify(text));
  }

  const command = text => el("p", { class: "command" }, "コマンドで見るなら：", el("code", {}, text));

  function formatWho(line) {
    const match = line.match(/^(.*) (\d+) ([+-]\d{4})$/);
    if (!match) return line;
    const offset = (match[3][0] === "-" ? -1 : 1) * (Number(match[3].slice(1, 3)) * 60 + Number(match[3].slice(3)));
    const local = new Date((Number(match[2]) + offset * 60) * 1000).toISOString().slice(0, 19).replace("T", " ");
    return `${line}（${local} ${match[3]}）`;
  }

  function summary(object) {
    if (object.commit) return `「${object.commit.subject}」`;
    if (object.entries) return object.entries.map(e => e.name).join("、");
    if (object.type === "blob") {
      const text = asText(object.body);
      if (text === null) return `バイナリ（${object.body.length} バイト）`;
      const first = text.split("\n")[0];
      return `${first.length > 36 ? `${first.slice(0, 36)}…` : first}（${object.body.length} バイト）`;
    }
    return "";
  }

  // ---- 右側：選んだものの中身 ----

  function describe(rel) {
    if (rel === ".git/HEAD") return "いまチェックアウトしているブランチを指すファイルです。通常は「ref: refs/heads/ブランチ名」の1行が入っています。";
    if (rel === ".git/config") return "このリポジトリだけに効く設定ファイルです。[core] のようなセクションの見出しと、その下の「名前 = 値」の行でできています。";
    if (rel === ".git/index") return "ステージ（次のコミットに入る内容）を記録したバイナリファイルです。先頭4バイトは DIRC という署名で、そのあとにファイルごとのパスと blob のハッシュ値が並びます。";
    if (rel === ".git/index.lock") return "Git が index を書き換えるあいだだけ置くロックファイルです。これがあるあいだ、ほかの git コマンドは index を書き換えられません。";
    if (rel === ".git/packed-refs") return "複数の参照（ブランチやタグ）を1つにまとめたファイルです。1行が1つの参照です。";
    if (rel === ".git/COMMIT_EDITMSG") return "直前に入力したコミットメッセージです。";
    if (rel === ".git/ORIG_HEAD") return "reset や merge などの前に HEAD が指していたコミットです。";
    if (rel === ".git/description") return "リポジトリの説明文です。GitWeb などが使うもので、普段の操作には関係しません。";
    if (rel.startsWith(".git/refs/heads/")) return `ブランチ「${rel.slice(16)}」の先頭コミットのハッシュ値（40桁）が入っているファイルです。`;
    if (rel.startsWith(".git/refs/tags/")) return `タグ「${rel.slice(15)}」が指すオブジェクトのハッシュ値が入っているファイルです。`;
    if (rel.startsWith(".git/logs/")) return "参照が動いた履歴（reflog）です。1行が1回の移動で、移動前のハッシュ値、移動後のハッシュ値、操作した人、日時（UNIX時刻とタイムゾーン）、操作の内容の順に並んでいます。";
    if (rel.startsWith(".git/hooks/")) return "コミットの前後などに自動で実行されるスクリプトの見本です。.sample が付いているあいだは実行されません。";
    if (rel === ".git/info/exclude") return "このリポジトリだけで無視するファイルの一覧です（.gitignore と同じ書き方）。";
    if (/^\.git\/objects\/pack\/.*\.pack$/.test(rel)) return "複数のオブジェクトを1つにまとめたファイル（packfile）です。git gc などで作られます。";
    if (/^\.git\/objects\/pack\/.*\.idx$/.test(rel)) return "packfile の索引です。ハッシュ値から、.pack の中のどの位置にそのオブジェクトがあるかを引けます。Git はこの索引がないと packfile の中身を読めません。";
    if (/^\.git\/objects\/pack\/.*\.rev$/.test(rel)) return "packfile の逆引き用の索引です。なくても Git は動きます。";
    if (rel.startsWith(".git/")) return "";
    return "作業ツリーのファイルです（.git の外にある、普段編集しているファイル）。";
  }

  async function viewFile(rel) {
    const out = [el("h3", { class: "mono" }, rel)];
    const info = model.files.get(rel);
    if (!info) {
      out.push(el("p", { class: "empty" }, "このファイルはありません（削除されたか、まだ作られていません）。"));
      return out;
    }
    const about = describe(rel);
    if (about) out.push(el("p", { class: "about" }, about));
    const bytes = await read(rel);
    if (!bytes) {
      out.push(el("p", { class: "empty" }, "読み込めませんでした。"));
      return out;
    }

    if (rel === ".git/index") {
      if (model.index && model.index.entries) {
        out.push(el("p", {}, `バージョン ${model.index.version}、${model.index.entries.length} 件のファイルが記録されています。`));
        out.push(el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, "モード"), el("th", {}, "blob"), el("th", {}, "パス"))),
          el("tbody", {}, model.index.entries.map(e => el("tr", {}, el("td", { class: "mono" }, e.mode), el("td", {}, objectLink(e.hash)), el("td", { class: "mono" }, e.path))))));
        out.push(command("git ls-files --stage"));
      } else {
        out.push(el("p", { class: "warn" }, `index として読めません：${model.index ? model.index.error : "不明なエラー"}`));
        out.push(el("p", {}, "ファイルの先頭は次のとおりです。"), hexdump(bytes, 64));
        out.push(command("head -c 16 .git/index | od -c"));
      }
      return out;
    }

    const pack = model.packs.get(rel);
    if (pack) {
      out.push(el("p", {}, pack.hasIdx ? "対応する索引（.idx）があります。" : el("strong", { class: "warn" }, "対応する索引（.idx）がありません。")));
      if (pack.error) {
        out.push(el("p", { class: "warn" }, `packfile として読めません：${pack.error}`), hexdump(bytes, 64));
      } else {
        out.push(el("p", {}, `この画面では索引を使わず、ファイルを先頭から順に読んで ${pack.entries.length} 個のオブジェクトを取り出しています。`));
        out.push(el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, "オブジェクト"), el("th", {}, "位置"), el("th", {}, "内容"))),
          el("tbody", {}, pack.entries.map(e => el("tr", {},
            el("td", {}, objectLink(e.hash)),
            el("td", { class: "mono" }, `${e.offset}${e.delta ? "（差分）" : ""}`),
            el("td", {}, summary({ ...e, commit: model.objects.get(e.hash).commit, entries: model.objects.get(e.hash).entries })))))));
      }
      return out;
    }

    out.push(content(bytes));
    if (rel === ".git/HEAD" && model.head && model.head.ref) {
      const ref = model.refs.get(model.head.ref);
      out.push(el("p", { class: "follow" }, "指している先：", ref ? fileLink(ref.rel, ref.rel === ".git/packed-refs" ? `.git/packed-refs の ${ref.name}` : ref.rel) : [el("span", { class: "mono" }, `.git/${model.head.ref}`), badge("ファイルがない", "bad")]));
    } else if (rel.startsWith(".git/refs/")) {
      const ref = model.refs.get(rel.slice(5));
      if (ref && ref.hash) out.push(el("p", { class: "follow" }, "指している先：", objectLink(ref.hash)));
      else if (bytes.length) out.push(el("p", { class: "warn" }, "40桁のハッシュ値として読めません。"));
    }
    out.push(command(`cat ${rel}`));
    return out;
  }

  function backlinks(hash) {
    const list = model.back.get(hash) || [];
    return [
      el("h4", {}, "このオブジェクトを指しているもの"),
      list.length
        ? el("ul", { class: "plain" }, list.map(b => el("li", {}, el("button", { type: "button", class: "x-link", onclick: () => go(b.target) }, b.label))))
        : el("p", { class: "empty" }, "見つかりません（どこからも指されていないか、指している側が読めません）。"),
    ];
  }

  function viewObject(hash) {
    const object = model.objects.get(hash);
    const broken = model.broken.get(hash);
    const out = [];
    if (!object) {
      out.push(el("h3", {}, "オブジェクト ", el("span", { class: "mono" }, hash)));
      if (broken) {
        out.push(el("p", { class: "warn" }, `このオブジェクトのファイルは壊れていて、中身を取り出せません（${broken.reason}）。`));
        out.push(el("p", {}, "保存場所：", fileLink(broken.rel)));
        out.push(el("p", {}, "ファイルの中身は次のとおりです。正常なオブジェクトは zlib で圧縮されているので、文字としては読めないはずです。"), content(broken.raw));
      } else {
        out.push(el("p", { class: "warn" }, "このハッシュ値のオブジェクトは、.git/objects の中に見つかりません。"));
      }
      out.push(...backlinks(hash));
      return out;
    }

    out.push(el("h3", {}, badge(object.type, object.type), " ", el("span", { class: "mono" }, hash)));
    if (object.rel) {
      out.push(el("p", {}, "保存場所：", fileLink(object.rel), "（オブジェクト1つを zlib で圧縮したファイル。ハッシュ値の先頭2桁がディレクトリ名、残りがファイル名）"));
      if (broken) out.push(el("p", { class: "warn" }, "同じハッシュ値のファイルが壊れた状態で残っています：", fileLink(broken.rel)));
    } else {
      out.push(el("p", {}, "保存場所：", fileLink(object.pack), " の中（packfile）"));
      if (broken) out.push(el("p", { class: "warn" }, "同じハッシュ値の壊れたファイルもあります：", fileLink(broken.rel), "。Git はこちらを先に読むため、エラーになります。"));
    }
    if (object.mismatch) out.push(el("p", { class: "warn" }, `中身から計算したハッシュ値（${object.mismatch}）が、ファイル名と一致しません。`));

    if (object.parseError) {
      out.push(el("p", { class: "warn" }, object.parseError), hexdump(object.body));
    } else if (object.commit) {
      const c = object.commit;
      out.push(el("dl", {},
        el("dt", {}, "tree"), el("dd", {}, c.tree ? objectLink(c.tree, true) : "なし", el("div", { class: "hint" }, "このコミットの時点の、ファイルの一覧")),
        el("dt", {}, "parent"), el("dd", {}, c.parents.length ? c.parents.map(p => el("div", {}, objectLink(p, true))) : "なし（最初のコミット）", el("div", { class: "hint" }, "1つ前のコミット")),
        el("dt", {}, "author"), el("dd", { class: "mono" }, formatWho(c.author)),
        el("dt", {}, "committer"), el("dd", { class: "mono" }, formatWho(c.committer)),
        el("dt", {}, "メッセージ"), el("dd", {}, el("pre", {}, c.message.replace(/\n+$/, "")))));
    } else if (object.entries) {
      out.push(el("p", { class: "about" }, "tree はディレクトリ1つ分の一覧です。名前ごとに、中身を持つオブジェクト（ファイルなら blob、サブディレクトリなら tree）のハッシュ値が並びます。"));
      out.push(el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "モード"), el("th", {}, "オブジェクト"), el("th", {}, "名前"))),
        el("tbody", {}, object.entries.map(e => el("tr", {}, el("td", { class: "mono" }, e.mode), el("td", {}, objectLink(e.hash)), el("td", { class: "mono" }, e.name))))));
    } else {
      if (object.type === "blob") out.push(el("p", { class: "about" }, "blob はファイル1つ分の中身です。ファイル名は持たず、名前は tree の側にあります。"));
      out.push(content(object.body));
    }
    out.push(...backlinks(hash));
    out.push(command(`git cat-file -p ${short(hash)}`));
    return out;
  }

  function commitNode(hash, label, withTree, seen) {
    const object = model.objects.get(hash);
    const li = el("li", {}, label, objectLink(hash), object && object.commit ? ` 「${object.commit.subject}」` : "");
    if (!object || !object.commit || seen.has(hash)) return li;
    seen.add(hash);
    const children = [];
    if (withTree && object.commit.tree) children.push(treeNode(object.commit.tree, "tree："));
    for (const parent of object.commit.parents) children.push(commitNode(parent, "parent：", false, seen));
    if (children.length) li.append(el("ul", {}, children));
    return li;
  }

  function treeNode(hash, label) {
    const object = model.objects.get(hash);
    const li = el("li", {}, label, objectLink(hash));
    if (object && object.entries) {
      li.append(el("ul", {}, object.entries.map(e => (e.mode === "40000" ? treeNode(e.hash, `${e.name}/：`) : el("li", {}, el("span", { class: "mono" }, e.name), "：", objectLink(e.hash))))));
    }
    return li;
  }

  function viewOverview() {
    const out = [el("h3", {}, "参照のつながり"), el("p", { class: "about" }, "HEAD から順に、指している先をたどった結果です。途中が壊れていると、そこで止まります。")];
    const head = el("li", {}, fileLink(".git/HEAD"));
    if (!model.head) {
      head.append(badge("ファイルがない", "bad"));
    } else if (model.head.ref) {
      const ref = model.refs.get(model.head.ref);
      const li = el("li", {});
      if (!ref) li.append(el("span", { class: "mono" }, `.git/${model.head.ref}`), badge("ファイルがない", "bad"));
      else {
        li.append(fileLink(ref.rel, ref.rel === ".git/packed-refs" ? `.git/packed-refs の ${ref.name}` : ref.rel));
        if (ref.hash) li.append(el("ul", {}, commitNode(ref.hash, "", true, new Set())));
        else li.append(badge(ref.text ? "ハッシュ値ではない" : "空", "bad"));
      }
      head.append(el("ul", {}, li));
    } else if (model.head.hash) {
      head.append(el("ul", {}, commitNode(model.head.hash, "", true, new Set())));
    } else {
      head.append(badge(model.head.text ? "読み取れない内容" : "空", "bad"));
    }
    out.push(el("ul", { class: "chain" }, head));

    out.push(el("h4", {}, fileLink(".git/index"), "（ステージ）"));
    if (model.files.has(".git/index.lock")) out.push(el("p", {}, fileLink(".git/index.lock"), badge("ロックファイルがある", "bad")));
    if (!model.index) out.push(el("p", { class: "empty" }, "index はありません。"));
    else if (model.index.error) out.push(el("p", { class: "warn" }, `読めません：${model.index.error}`));
    else out.push(el("ul", { class: "chain" }, model.index.entries.map(e => el("li", {}, el("span", { class: "mono" }, e.path), "：", objectLink(e.hash)))));

    const all = [...model.objects.values()].sort((a, b) => "ctbg".indexOf(a.type[0]) - "ctbg".indexOf(b.type[0]) || (a.hash < b.hash ? -1 : 1));
    out.push(el("h4", {}, `すべてのオブジェクト（${all.length + [...model.broken.keys()].filter(h => !model.objects.has(h)).length} 個）`));
    out.push(el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "オブジェクト"), el("th", {}, "保存場所"), el("th", {}, "内容"))),
      el("tbody", {},
        all.map(o => el("tr", {}, el("td", {}, objectLink(o.hash)), el("td", {}, o.rel ? "単独のファイル" : "packfile"), el("td", {}, summary(o)))),
        [...model.broken.keys()].filter(h => !model.objects.has(h)).map(h => el("tr", {}, el("td", {}, objectLink(h)), el("td", {}, "単独のファイル"), el("td", {}, "中身を取り出せません"))))));
    return out;
  }

  // ---- 左側：ファイルの一覧 ----

  function selectedRel() {
    if (selection.kind === "file") return selection.rel;
    if (selection.kind === "object") {
      const object = model.objects.get(selection.hash) || model.broken.get(selection.hash);
      return object ? object.rel || object.pack : null;
    }
    return null;
  }

  function treeItems(nodes, depth, current) {
    const items = [];
    for (const node of nodes) {
      const pad = `padding-left:${8 + depth * 14}px`;
      if (node.dir) {
        // .git/objects/55/ のような2桁のディレクトリは、中のファイルを 55/bcbc… の形で並べる。
        if (/^\.git\/objects\/[0-9a-f]{2}$/.test(node.rel)) {
          items.push(...treeItems(node.children, depth, current));
          continue;
        }
        const open = expanded.has(node.rel);
        items.push(el("li", {}, el("button", {
          type: "button", class: "tree-item dir", style: pad, "aria-expanded": String(open),
          onclick: () => { if (open) expanded.delete(node.rel); else expanded.add(node.rel); renderTree(); },
        }, el("span", { class: "twist" }, open ? "▾" : "▸"), `${node.name}/`)));
        if (open) items.push(...treeItems(node.children, depth + 1, current));
        continue;
      }
      const loose = node.rel.match(/^\.git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/);
      const classes = ["tree-item"];
      if (node.rel === current) classes.push("current");
      if (changed.has(node.rel)) classes.push("changed");
      const state = loose ? objectState(loose[1] + loose[2]) : null;
      items.push(el("li", {}, el("button", {
        type: "button", class: classes.join(" "), style: pad, title: node.rel,
        onclick: () => go(loose ? { kind: "object", hash: loose[1] + loose[2] } : { kind: "file", rel: node.rel }),
      }, el("span", { class: "twist" }), el("span", { class: "name" }, loose ? `${loose[1]}/${loose[2].slice(0, 6)}…` : node.name), state && badge(state.text, state.kind), changed.has(node.rel) && badge("更新", "new"))));
    }
    return items;
  }

  function renderTree() {
    const box = $("explorer-tree");
    const top = box.scrollTop;
    box.replaceChildren(el("ul", { class: "tree" }, treeItems(model.tree, 0, selectedRel())));
    box.scrollTop = top;
  }

  // ---- 全体の描画と操作 ----

  async function render(keepScroll = false) {
    const detail = $("explorer-detail");
    $("explorer-back").disabled = history.length === 0;
    $("explorer-overview").disabled = !model;
    $("explorer-root").textContent = model ? `~/q${quiz}` : "";
    if (!model) {
      $("explorer-tree").replaceChildren();
      detail.replaceChildren(el("p", { class: "empty" }, quiz ? `~/q${quiz} がありません。` : "問題を始めると、リポジトリの中身（.git の中）がここに表示されます。"));
      return;
    }
    renderTree();
    const mine = seq;
    const top = detail.scrollTop;
    const nodes = selection.kind === "file" ? await viewFile(selection.rel)
      : selection.kind === "object" ? viewObject(selection.hash)
      : viewOverview();
    if (mine !== seq) return;
    detail.replaceChildren(...nodes);
    detail.scrollTop = keepScroll ? top : 0;
  }

  function go(next) {
    if (!model) return;
    history.push(selection);
    selection = next;
    // 選んだファイルが一覧で見えるよう、途中のディレクトリを開く。
    const rel = selectedRel();
    if (rel) {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
    }
    render();
  }

  async function refresh(n) {
    if (!emulator) return;
    const mine = ++seq;
    if (n !== quiz) {
      quiz = n;
      selection = { kind: "overview" };
      history = [];
      expanded = new Set(DEFAULT_EXPANDED);
      stamps = new Map();
    }
    root = `/root/q${n}`;
    let next = null;
    if (n && stat("")) {
      try {
        next = await build();
      } catch (error) {
        console.error(error);
      }
    }
    if (mine !== seq) return;
    changed = new Set();
    if (next) {
      const fresh = new Map([...next.files].map(([rel, f]) => [rel, `${f.size}:${f.mtime}`]));
      if (stamps.size) {
        for (const [rel, stamp] of fresh) if (stamps.get(rel) !== stamp) changed.add(rel);
      }
      stamps = fresh;
    }
    model = next;
    render(true);
  }

  function attach(v86) {
    emulator = v86;
    $("explorer-back").addEventListener("click", () => {
      if (!history.length) return;
      selection = history.pop();
      render();
    });
    $("explorer-overview").addEventListener("click", () => go({ kind: "overview" }));
    render();
  }

  return { attach, refresh };
})();
