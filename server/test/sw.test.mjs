// sw.js の通知まわり（push / notificationclick）を、ブラウザの代わりの最小の環境で動かして確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../../sw.js", import.meta.url), "utf8");
const SCOPE = "https://tkr0218.github.io/pillow_checker/";

function loadSw({ windows = [] } = {}) {
  const handlers = {}, shown = [], opened = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { scope: SCOPE, showNotification: async (title, opts) => { shown.push({ title, ...opts }); } },
    clients: { matchAll: async () => windows, openWindow: async url => { opened.push(url); } },
    location: { origin: "https://tkr0218.github.io" },
  };
  vm.runInNewContext(code, { self, URL, console });
  // vm の中で作られた配列・オブジェクトは別の realm のものなので、比べる前に JSON で普通の値にする
  const plain = v => JSON.parse(JSON.stringify(v));
  const fire = async (type, ev) => { const ps = []; handlers[type]({ ...ev, waitUntil: p => ps.push(p) }); await Promise.all(ps); };
  return { fire, get shown() { return plain(shown); }, opened };
}
const payload = { title: "花あつめ", body: "夜の薬の時間です（21:00）", tag: "2026-10-18|pm", slotId: "pm", date: "2026-10-18", kind: "first" };

test("通知を受け取ると表示し、「飲んだので記録する」ボタンを付ける", async () => {
  const sw = loadSw();
  await sw.fire("push", { data: { json: () => payload } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].body, "夜の薬の時間です（21:00）");
  assert.equal(sw.shown[0].tag, "2026-10-18|pm");
  assert.deepEqual(sw.shown[0].actions.map(a => a.title), ["飲んだので記録する"]);
});

test("中身が壊れた通知でも、何かは表示する（表示しないと Chrome が警告を出す）", async () => {
  const sw = loadSw();
  await sw.fire("push", { data: { json: () => { throw new Error("bad"); } } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "花あつめ");
});

test("アプリが閉じているとき「飲んだので記録する」→ 記録用の URL で開く", async () => {
  const sw = loadSw();
  let closed = false;
  await sw.fire("notificationclick", { action: "take", notification: { data: { slotId: "pm", date: "2026-10-18" }, close: () => { closed = true; } } });
  assert.ok(closed);
  assert.deepEqual(sw.opened, [SCOPE + "?take=pm&date=2026-10-18"]);
});

test("アプリが開いているときは、そのウィンドウに記録を頼む。通知本体を押しただけなら記録しない", async () => {
  const msgs = []; let focused = 0;
  const win = { url: SCOPE, focus: async () => { focused++; }, postMessage: m => msgs.push(m) };
  const sw = loadSw({ windows: [win] });
  await sw.fire("notificationclick", { action: "take", notification: { data: { slotId: "pm", date: "2026-10-18" }, close() {} } });
  await sw.fire("notificationclick", { action: "", notification: { data: { slotId: "pm", date: "2026-10-18" }, close() {} } });
  assert.equal(focused, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(msgs)), [{ type: "take", slotId: "pm", date: "2026-10-18" }]);
  assert.deepEqual(sw.opened, []);
});
