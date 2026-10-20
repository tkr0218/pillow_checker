// 花あつめ：抽選ロジックの回帰テスト
// 実行: TZ=Asia/Tokyo node test_blooms.mjs          （スナップショット更新は --update）
// index.html の @logic-start〜@logic-end をそのまま読み込むので、ページと同じコードを検証する。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const HTML = new URL("./index.html", import.meta.url);
const SNAP = new URL("./blooms.snapshot.json", import.meta.url);
const src = readFileSync(HTML, "utf8");
const logic = src.slice(src.indexOf("// @logic-start"), src.indexOf("// @logic-end"));

// 毎回まっさらなロジックを作る（テスト同士で RULESETS などの変更が漏れないように）
const load = () => new Function(`${logic}; return { state, computeAll, dayKey, addDays, RULESETS, SPECIES, CADENCES, normalizeSettings, setTodaySlots, slotsFor, isDone, currentStreak, seriesOf };`)();
const LEGACY_SNAP = new URL("./blooms.legacy.snapshot.json", import.meta.url);
const V1_SNAP = new URL("./blooms.v1.snapshot.json", import.meta.url);   // v2（第二弾・確率変更）を入れる前の結果
const V2_DAY = "2026-10-20";   // v2 は 2026-10-20 21:00 以降の記録から
const CUTOVER_DAY = "2026-10-14";

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
  L.RULESETS.push({ v: 3, from: "2027-01-01", weights: [10, 10, 40, 40], luckyWeights: [0, 0, 50, 50], luckyStreak: 1, pity: 2, newChance: 1, series: true });
  L.SPECIES.push({ id: "test-new", nm: "テスト花", r: 1, v: 3, shape: "round", n: 5, c: "#000", ctr: "#fff" });
  assert.deepEqual(summary(L.computeAll(END)), before);
});

test("新しい版の花は、その版の適用時刻以降にしか咲かない", () => {
  const L = load(); fillYear(L);
  L.RULESETS.push({ v: 3, from: "2026-11-15T00:00:00.000Z", weights: [100, 0, 0, 0], luckyWeights: [100, 0, 0, 0], luckyStreak: 99, pity: 99, newChance: 1, series: true });
  L.SPECIES.push({ id: "v3-only", nm: "新花", r: 1, v: 3, shape: "round", n: 5, c: "#000", ctr: "#fff" });
  const bl = L.computeAll(END).blooms;
  assert.ok(bl.filter(b => b.sp.id === "v3-only").every(b => b.k >= "2026-11-15"));
  assert.ok(bl.some(b => b.sp.id === "v3-only"), "新しい版の花が一度も咲いていない");
});

test("v2 を入れる前（2026-10-20 21:00 より前）に咲いた花は、v1 のときと同じ", () => {
  const L = load(); fillYear(L);
  const before = JSON.parse(readFileSync(V1_SNAP, "utf8")).filter(x => x < V2_DAY);
  const now = summary(L.computeAll(END)).filter(x => x < V2_DAY);
  assert.ok(before.length > 40, "比較対象が少なすぎる");
  assert.deepEqual(now, before);
});

// 2026-10-21 から使い始めた人（すべて v2）
function v2User(L, startK = "2026-10-21", days = 365, seriesLog = []) {
  fillPerfect(L, startK, days);
  L.state.settings = { ...L.normalizeSettings({}), seriesLog };
}

test("第二弾：咲いた瞬間に第二弾を選んでいれば第二弾の花、第一弾なら第一弾の花", () => {
  const L = load();
  v2User(L, "2026-10-21", 30, [{ at: "2026-11-05T00:00:00.000Z", s: 2 }]);
  const bl = L.computeAll(new Date(2026, 10, 20, 23)).blooms;
  for (const b of bl) {
    const t = b.k < "2026-11-05" ? 1 : 2;
    assert.equal(L.seriesOf(b.sp), t, `${b.k} の ${b.sp.nm}`);
    assert.equal(b.series, t);
  }
  assert.ok(bl.some(b => b.series === 2) && bl.some(b => b.series === 1));
});

test("第二弾：あとから選び直しても、すでに咲いた花は変わらない", () => {
  const L = load();
  v2User(L, "2026-10-21", 30, [{ at: "2026-11-05T00:00:00.000Z", s: 2 }]);
  const before = summary(L.computeAll(new Date(2026, 10, 20, 23)));
  L.state.settings.seriesLog.push({ at: "2026-11-20T15:00:00.000Z", s: 1 });   // 11/21 0:00 JST に第一弾へ戻す
  assert.deepEqual(summary(L.computeAll(new Date(2026, 10, 20, 23))), before);
});

test("第二弾：v2 より前は第二弾を選んでいても第一弾の花が咲く", () => {
  const L = load(); fillYear(L);
  L.state.settings = { ...L.state.settings, seriesLog: [{ at: "2026-01-01T00:00:00.000Z", s: 2 }] };
  for (const b of L.computeAll(END).blooms) if (b.k < V2_DAY) assert.equal(L.seriesOf(b.sp), 1);
});

test("v2 の確率：毎日欠かさず記録しても ★4 はまれ（1年で数本程度）", () => {
  let total = 0, r4 = 0, r3 = 0;
  for (const start of ["2026-10-21", "2026-11-03", "2026-12-17", "2027-01-09", "2027-02-25"]) {
    const L = load(); v2User(L, start, 365);
    const [y, m, d] = start.split("-").map(Number);
    const bl = L.computeAll(new Date(y + 1, m - 1, d, 23)).blooms;
    total += bl.length; r4 += bl.filter(b => b.sp.r === 4).length; r3 += bl.filter(b => b.sp.r === 3).length;
  }
  console.log(`      5人×1年: ${total}本、★3 ${(r3 / total * 100).toFixed(1)}%、★4 ${(r4 / total * 100).toFixed(1)}%（1人1年あたり ★4 ${(r4 / 5).toFixed(1)}本）`);
  assert.ok(r4 / total < 0.06, "★4 が多すぎる");
  assert.ok(r4 > 0, "★4 が一度も出ない");
});

test("同じ日に取り消して飲み直しても（時刻が変わっても）結果は同じ＝引き直し不可", () => {
  const a = (() => { const L = load(); fillYear(L, { amHour: 8 }); return summary(L.computeAll(END)); })();
  const b = (() => { const L = load(); fillYear(L, { amHour: 10 }); return summary(L.computeAll(END)); })();
  assert.deepEqual(a, b);
});

test("天井：★3以上なしが pity 本を超えて続かない", () => {
  const L = load(); fillYear(L);
  let run = 0;
  for (const b of L.computeAll(END).blooms) {
    const pity = L.RULESETS.find(r => r.v === b.v).pity;   // その花が咲いたときの版の天井
    if (run >= pity - 1) assert.ok(b.sp.r >= 3, `${b.k}：★3以上なしが ${run} 本続いたあとも ★${b.sp.r}`);
    run = b.sp.r >= 3 ? 0 : run + 1;
  }
});

test("ルール切り替え（2026-10-14 14:00）より前に咲いた花は、旧ルールのときと同じ", () => {
  const L = load(); fillYear(L);
  const legacy = JSON.parse(readFileSync(LEGACY_SNAP, "utf8")).filter(x => x < CUTOVER_DAY);
  const now = summary(L.computeAll(END)).filter(x => x < CUTOVER_DAY);
  assert.ok(legacy.length > 30, "比較対象が少なすぎる");
  assert.deepEqual(now, legacy);
});

// 切り替え後に使い始めた人：毎日全部飲む
function fillPerfect(L, startK, nDays, skip = () => false) {
  const [y, m, d] = startK.split("-").map(Number), start = new Date(y, m - 1, d);
  for (let i = 0; i < nDays; i++) {
    const day = L.addDays(start, i), k = L.dayKey(day);
    const am = new Date(day); am.setHours(8); const pm = new Date(day); pm.setHours(21);
    L.state.days[k] = { am: skip(i, "am") ? null : am.toISOString(), pm: skip(i, "pm") ? null : pm.toISOString() };
  }
}

test("新ルール：1本目4回、以降6回ごと", () => {
  const L = load(); fillPerfect(L, "2026-11-01", 8);   // 16回
  const A = L.computeAll(new Date(2026, 10, 8, 23));
  // 4回目=2日目夜、10回目=5日目夜、16回目=8日目夜
  assert.deepEqual(A.blooms.map(b => b.k), ["2026-11-02", "2026-11-05", "2026-11-08"]);
});

test("新ルール：飲めなかった日があると、その次の花は4回（育てている花はそのまま）", () => {
  const L = load();
  fillPerfect(L, "2026-11-01", 9, (i, s) => i === 2 && s === "pm");   // 3日目の夜だけ飲まない
  const A = L.computeAll(new Date(2026, 10, 9, 23));
  // 1本目：4回目＝2日目夜
  // 2本目：6回のまま（3日目朝, 4日目朝夜, 5日目朝夜, 6日目朝）＝6日目
  // 3本目：2本目を育てている間に失敗があったので4回（6日目夜, 7日目朝夜, 8日目朝）＝8日目
  // 4本目：失敗なしなので6回（8日目夜, 9日目朝夜 …）＝まだ咲かない
  assert.deepEqual(A.blooms.map(b => b.k), ["2026-11-02", "2026-11-06", "2026-11-08"]);
  assert.equal(A.need, 6);
});

test("使い始めた日の途中から始めても、その日は失敗として数えない", () => {
  const L = load();
  fillPerfect(L, "2026-11-01", 5, (i, s) => i === 0 && s === "am");   // 初日は夜から開始
  const A = L.computeAll(new Date(2026, 10, 5, 23));
  // 記録: 1日目夜(1) 2日目(3) 3日目朝(4→1本目) … 2本目は6回 ＝ 3日目夜,4日目朝夜,5日目朝夜 で5回 → まだ
  assert.deepEqual(A.blooms.map(b => b.k), ["2026-11-03"]);
  assert.equal(A.need - A.progress, 1);
});

test("予定の変更は今日から。過去の日の判定と連続記録は変わらない", () => {
  const L = load(); fillPerfect(L, "2026-11-01", 10);
  const now = new Date(2026, 10, 10, 23);
  const before = L.currentStreak(now);
  L.setTodaySlots("2026-11-10", [...L.slotsFor("2026-11-10"), { id: "s1", name: "昼", time: "12:30" }]);
  assert.equal(L.slotsFor("2026-11-09").length, 2);
  assert.equal(L.slotsFor("2026-11-10").length, 3);
  assert.ok(L.isDone("2026-11-09"));
  assert.ok(!L.isDone("2026-11-10"), "今日は昼を飲んでいないので未達成");
  assert.equal(L.currentStreak(now), before - 1, "今日の分だけ未達成になり、昨日までの連続は残る");
});

test("旧形式の設定（am/pm）はそのまま読める", () => {
  const L = load();
  const s = L.normalizeSettings({ am: "07:30", pm: "22:00" });
  assert.deepEqual(s.schedules[0].slots.map(x => [x.id, x.name, x.time]), [["am", "朝", "07:30"], ["pm", "夜", "22:00"]]);
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
