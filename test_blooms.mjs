// 朝夜のくすり：抽選ロジックの回帰テスト
// 実行: TZ=Asia/Tokyo node test_blooms.mjs          （スナップショット更新は --update）
// index.html の @logic-start〜@logic-end をそのまま読み込むので、ページと同じコードを検証する。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const HTML = new URL("./index.html", import.meta.url);
const SNAP = new URL("./blooms.snapshot.json", import.meta.url);
const src = readFileSync(HTML, "utf8");
const logic = src.slice(src.indexOf("// @logic-start"), src.indexOf("// @logic-end"));

// 毎回まっさらなロジックを作る（テスト同士で RULESETS などの変更が漏れないように）
const load = () => new Function(`${logic}; return { state, computeAll, dayKey, addDays, RULESETS, SPECIES, BLOOM_AT };`)();

// 2026年1年分：基本は毎日朝夜、ときどき飲み忘れ
function fillYear(L, { amHour = 8 } = {}) {
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < 365; i++) {
    const d = L.addDays(start, i), k = L.dayKey(d);
    const am = new Date(d); am.setHours(amHour, 5);
    const pm = new Date(d); pm.setHours(21, 30);
    const skipAm = i % 11 === 3, skipPm = i % 17 === 9;
    L.state.days[k] = { am: skipAm ? null : am.toISOString(), pm: skipPm ? null : pm.toISOString() };
  }
}
const END = new Date(2026, 11, 31, 23);
const summary = A => A.blooms.map(b => `${b.k}:${b.sp.id}`);

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("ok   ", name); }
  catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message.split("\n")[0]); }
}

test("日付は端末の現地時間で区切る（深夜3時も当日）", () => {
  const L = load();
  assert.equal(L.dayKey(new Date(2026, 9, 10, 3, 0)), "2026-10-10");
});

test("過去の花はスナップショットと一致する", () => {
  const L = load(); fillYear(L);
  const got = summary(L.computeAll(END));
  if (process.argv.includes("--update") || !existsSync(SNAP)) {
    writeFileSync(SNAP, JSON.stringify(got, null, 1));
    console.log("      スナップショットを書き出しました:", got.length, "本");
  } else {
    assert.deepEqual(got, JSON.parse(readFileSync(SNAP, "utf8")));
  }
});

test("新しい版（ルール・花）を足しても、それ以前に咲いた花は変わらない", () => {
  const before = (() => { const L = load(); fillYear(L); return summary(L.computeAll(END)); })();
  const L = load(); fillYear(L);
  L.RULESETS.push({ v: 2, from: "2027-01-01", weights: [10, 10, 40, 40], luckyWeights: [0, 0, 50, 50], luckyStreak: 1, pity: 2, newChance: 1 });
  L.SPECIES.push({ id: "test-new", nm: "テスト花", r: 1, v: 2, shape: "round", n: 5, c: "#000", ctr: "#fff" });
  assert.deepEqual(summary(L.computeAll(END)), before);
});

test("v2 の花は v2 の適用日以降にしか咲かない", () => {
  const L = load(); fillYear(L);
  L.RULESETS.push({ v: 2, from: "2026-07-01", weights: [100, 0, 0, 0], luckyWeights: [100, 0, 0, 0], luckyStreak: 99, pity: 99, newChance: 1 });
  L.SPECIES.push({ id: "v2-only", nm: "新花", r: 1, v: 2, shape: "round", n: 5, c: "#000", ctr: "#fff" });
  const bl = L.computeAll(END).blooms;
  assert.ok(bl.filter(b => b.sp.id === "v2-only").every(b => b.k >= "2026-07-01"));
  assert.ok(bl.some(b => b.sp.id === "v2-only"), "v2 の花が一度も咲いていない");
});

test("同じ日に取り消して飲み直しても（時刻が変わっても）結果は同じ＝引き直し不可", () => {
  const a = (() => { const L = load(); fillYear(L, { amHour: 8 }); return summary(L.computeAll(END)); })();
  const b = (() => { const L = load(); fillYear(L, { amHour: 10 }); return summary(L.computeAll(END)); })();
  assert.deepEqual(a, b);
});

test("天井：★3以上なしが pity 本を超えて続かない", () => {
  const L = load(); fillYear(L);
  const pity = L.RULESETS[0].pity; let run = 0, max = 0;
  for (const b of L.computeAll(END).blooms) { run = b.sp.r >= 3 ? 0 : run + 1; max = Math.max(max, run); }
  assert.ok(max <= pity - 1, `最大 ${max} 本続いた`);
});

test("序盤は早く咲く（4回・12回・24回、以降14回ごと）", () => {
  const L = load();
  assert.deepEqual([0, 1, 2, 3, 4].map(L.BLOOM_AT), [4, 12, 24, 38, 52]);
});

test("季節限定の花は季節外に咲かない", () => {
  const L = load(); fillYear(L);
  for (const b of L.computeAll(END).blooms) {
    if (!b.sp.months) continue;
    const m = Number(b.k.slice(5, 7));
    assert.ok(b.sp.months.includes(m), `${b.sp.nm} が ${b.k} に咲いた`);
  }
});

// 参考：1年分の結果
{
  const L = load(); fillYear(L); const A = L.computeAll(END);
  const r = [0, 0, 0, 0]; A.blooms.forEach(b => r[b.sp.r - 1]++);
  console.log(`\n1年（ときどき飲み忘れ）: ${A.bloomed}本 / 図鑑 ${Object.keys(A.owned).length}種 / ★1-4 = ${r.join(", ")}`);
}
process.exit(failed ? 1 : 0);
