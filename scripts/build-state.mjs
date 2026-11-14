#!/usr/bin/env node
// VMを起動し、VM内で10問を通しで解いて確かめてから、起動済みの状態を保存する。
// 出力: build/images/alpine-state.bin.zst（zstd コマンドが必要）
import path from "node:path";
import fs from "node:fs";
import url from "node:url";
import child_process from "node:child_process";
import { V86 } from "v86";

const ROOT = path.join(url.fileURLToPath(new URL(".", import.meta.url)), "..");
const IMAGES = path.join(ROOT, "build/images");
const STATE_FILE = path.join(IMAGES, "alpine-state.bin");
const LOG_FILE = path.join(ROOT, "build/state-build.log");
const QUIZ_COUNT = 10;
// ページ側（site/main.js）と同じ値にすること。
const MEMORY_SIZE = 256 * 1024 * 1024;
const VGA_MEMORY_SIZE = 2 * 1024 * 1024;
const ROWS = 28;
const COLS = 100;

const emulator = new V86({
    wasm_path: path.join(ROOT, "node_modules/v86/build/v86.wasm"),
    bios: { url: path.join(ROOT, "build/bios/seabios.bin") },
    vga_bios: { url: path.join(ROOT, "build/bios/vgabios.bin") },
    autostart: true,
    memory_size: MEMORY_SIZE,
    vga_memory_size: VGA_MEMORY_SIZE,
    bzimage_initrd_from_filesystem: true,
    cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable",
    filesystem: {
        baseurl: path.join(IMAGES, "alpine-rootfs-flat"),
        basefs: path.join(IMAGES, "alpine-fs.json"),
    },
});

// シリアル出力から OSC 777 の通知（quiz;...）を取り出して events に積む。
const log = fs.createWriteStream(LOG_FILE);
const events = [];
let pending = "";
let wake = null;
emulator.add_listener("serial0-output-byte", byte => {
    log.write(Buffer.from([byte]));
    pending += String.fromCharCode(byte);
    for (;;) {
        const m = /\x1b\]777;quiz;([^\x07]*)\x07/.exec(pending);
        if (!m) break;
        pending = pending.slice(m.index + m[0].length);
        events.push(m[1]);
    }
    if (pending.length > 4096) pending = pending.slice(-1024);
    if (wake) wake();
});

// 次の prompt 通知までに届いた通知を返す。
async function untilPrompt(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const seen = [];
    for (;;) {
        while (events.length) {
            const e = events.shift();
            seen.push(e);
            if (e.startsWith("prompt;")) return seen;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`時間切れ（${timeoutMs}ms）。ここまでの通知: ${seen.join(", ")}`);
        await new Promise(resolve => {
            const t = setTimeout(resolve, left);
            wake = () => { clearTimeout(t); wake = null; resolve(); };
        });
    }
}

async function run(command, timeoutMs = 120_000) {
    const started = Date.now();
    emulator.serial_send_bytes(0, new TextEncoder().encode(command + "\n"));
    const seen = await untilPrompt(timeoutMs);
    return { seen, ms: Date.now() - started };
}

function fail(message) {
    console.error("NG  " + message);
    console.error("シリアル出力のログ: " + LOG_FILE);
    process.exit(1);
}

console.log("VMを起動しています ...");
const bootStarted = Date.now();
await untilPrompt(10 * 60_000).catch(e => fail("起動しません: " + e.message));
console.log(`起動しました（${Math.round((Date.now() - bootStarted) / 1000)}秒）`);

await run(`stty rows ${ROWS} cols ${COLS}`);

let slowest = 0;
for (let n = 1; n <= QUIZ_COUNT; n++) {
    const start = await run(`quiz ${n}`);
    if (!start.seen.includes(`start;${n}`) || !start.seen.includes(`prompt;${n};0`)) {
        fail(`問題${n}: 開始できません（通知: ${start.seen.join(", ")}）`);
    }
    const lines = fs.readFileSync(path.join(ROOT, `tests/solutions/${n}.sh`), "utf8").split("\n").filter(Boolean);
    let last;
    for (const [i, line] of lines.entries()) {
        last = await run(line);
        slowest = Math.max(slowest, last.ms);
        if (i < lines.length - 1 && last.seen.includes(`goal;${n}`)) {
            fail(`問題${n}: 解答例の途中でクリア判定になりました`);
        }
    }
    if (!last.seen.includes(`goal;${n}`) || !last.seen.includes(`prompt;${n};1`)) {
        fail(`問題${n}: 解答例を実行してもクリアになりません（通知: ${last.seen.join(", ")}）`);
    }
    console.log(`OK  問題${n}（準備 ${start.ms}ms、最後のコマンドと判定 ${last.ms}ms）`);
}
console.log(`コマンド1つと判定にかかった時間の最大: ${slowest}ms`);

const reset = await run("quiz reset");
if (!reset.seen.includes("prompt;0;0")) fail(`quiz reset 後の状態が想定と違います（通知: ${reset.seen.join(", ")}）`);
await run("cd; history -c; sync; echo 3 > /proc/sys/vm/drop_caches");
await run("clear");
await new Promise(resolve => setTimeout(resolve, 5000));

const state = await emulator.save_state();
fs.writeFileSync(STATE_FILE, new Uint8Array(state));
await emulator.destroy();
log.end();

fs.rmSync(STATE_FILE + ".zst", { force: true });
child_process.execFileSync("zstd", ["-19", "-q", "--rm", STATE_FILE], { stdio: "inherit" });
const size = fs.statSync(STATE_FILE + ".zst").size;
console.log(`保存: ${STATE_FILE}.zst（${(size / 1024 / 1024).toFixed(1)}MB）`);
process.exit(0);
