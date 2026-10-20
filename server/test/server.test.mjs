// 実行: node --test server/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { b64u, encrypt, generateVapidKeys, vapidHeader } from "../src/webpush.mjs";
import { dueNotifications, localNow, validateState, TICK_MIN, WINDOW_MIN } from "../src/schedule.mjs";
import { memoryStore } from "../src/store.mjs";
import { makeApi, makeTick, MAX_DEVICES } from "../src/app.mjs";

// ---------- Web Push 暗号化 ----------
// RFC 8291 Appendix A の例と一致すること
test("暗号化：RFC 8291 の例と一致する", () => {
  const body = encrypt(b64u.dec("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"), {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { asPrivateKey: b64u.dec("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b64u.dec("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(b64u.enc(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

// 受信側（ブラウザ）と同じ手順で復号できること（RFC の例以外の、ランダムな鍵と塩でも）
test("暗号化：受信側の手順で復号できる", () => {
  const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
  const auth = crypto.randomBytes(16), msg = JSON.stringify({ body: "朝の薬の時間です（08:00）" });
  const data = encrypt(msg, { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(auth) });
  const salt = data.subarray(0, 16), idlen = data[20], asPub = data.subarray(21, 21 + idlen), ct = data.subarray(21 + idlen);
  const secret = ua.computeSecret(asPub);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2);
  assert.equal(plain.subarray(0, -1).toString(), msg);
});

test("VAPID：署名が公開鍵で検証でき、aud は送信先のオリジン", () => {
  const v = generateVapidKeys();
  const h = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", v, "https://example.com/", 1_000_000);
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [hd, cl, sig] = jwt.split(".");
  const pub = b64u.dec(v.publicKey);
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33)) } });
  assert.ok(crypto.verify("sha256", Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: "ieee-p1363" }, b64u.dec(sig)));
  const claims = JSON.parse(b64u.dec(cl));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, 1_000_000 + 12 * 3600);
});

// ---------- 送信タイミング ----------
const JST = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi));
const dev = (extra = {}) => ({
  tz: "Asia/Tokyo",
  slots: [{ id: "am", name: "朝", time: "08:00" }, { id: "pm", name: "夜", time: "21:00" }],
  taken: {}, sent: {}, ...extra,
});

test("タイムゾーン：UTC 23時は日本の翌日8時", () => {
  assert.deepEqual(localNow(new Date(Date.UTC(2026, 9, 17, 23, 0)), "Asia/Tokyo"), { date: "2026-10-18", min: 8 * 60 });
});

test("予定時刻になったら通知、15分過ぎたら送らない", () => {
  assert.deepEqual(dueNotifications(dev(), JST(2026, 10, 18, 7, 59)), []);
  assert.deepEqual(dueNotifications(dev(), JST(2026, 10, 18, 8, 0)).map(n => n.key), ["2026-10-18|am|first"]);
  assert.deepEqual(dueNotifications(dev(), JST(2026, 10, 18, 8, 14)).map(n => n.key), ["2026-10-18|am|first"]);
  assert.deepEqual(dueNotifications(dev(), JST(2026, 10, 18, 8, 15)), []);
});

test("30分後に再通知。飲んでいれば送らない", () => {
  assert.deepEqual(dueNotifications(dev(), JST(2026, 10, 18, 8, 30)).map(n => n.key), ["2026-10-18|am|remind"]);
  assert.deepEqual(dueNotifications(dev({ taken: { "2026-10-18": ["am"] } }), JST(2026, 10, 18, 8, 30)), []);
  assert.deepEqual(dueNotifications(dev({ taken: { "2026-10-17": ["am"] } }), JST(2026, 10, 18, 8, 0)).length, 1, "前日の記録は関係ない");
});

test("送信済みなら送らない", () => {
  assert.deepEqual(dueNotifications(dev({ sent: { "2026-10-18|am|first": "x" } }), JST(2026, 10, 18, 8, 5)), []);
});

test("23:50 の予定の再通知は翌日 0:20 に、前日の日付で送る", () => {
  const d = dev({ slots: [{ id: "s1", name: "寝る前", time: "23:50" }] });
  const n = dueNotifications(d, JST(2026, 10, 19, 0, 20));
  assert.deepEqual(n.map(x => x.key), ["2026-10-18|s1|remind"]);
  assert.match(n[0].payload.body, /寝る前の薬がまだ記録されていません/);
  assert.deepEqual(dueNotifications({ ...d, taken: { "2026-10-18": ["s1"] } }, JST(2026, 10, 19, 0, 20)), []);
});

test(`10分ごとの送信処理：どの時刻の予定でも、通知と再通知がちょうど1回ずつ・10分以内に届く`, () => {
  assert.ok(WINDOW_MIN > TICK_MIN, "送る幅が間隔より短いと取りこぼす");
  for (let m = 0; m < 1440; m++) {
    const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const d = dev({ slots: [{ id: "s1", name: "朝", time }] });
    const got = { first: [], remind: [] };
    for (let t = 0; t < 2 * 1440; t += TICK_MIN) {   // 10/18 0:00 から2日分、毎時 0,10,20… 分
      const now = JST(2026, 10, 18, Math.floor(t / 60) % 24, t % 60);
      now.setUTCDate(now.getUTCDate() + Math.floor(t / 1440));
      for (const n of dueNotifications(d, now)) {
        if (n.date !== "2026-10-18") continue;
        d.sent[n.key] = "x";
        got[n.kind].push(t);
      }
    }
    assert.equal(got.first.length, 1, `${time} の通知`);
    assert.equal(got.remind.length, 1, `${time} の再通知`);
    assert.ok(got.first[0] - m >= 0 && got.first[0] - m < TICK_MIN, `${time} の通知が ${got.first[0] - m} 分遅れ`);
  }
});

test("不正な予定は受け付けない", () => {
  assert.throws(() => validateState({ tz: "Asia/Tokyo", slots: [] }));
  assert.throws(() => validateState({ tz: "Mars/Base", slots: [{ id: "am", name: "朝", time: "08:00" }] }));
  assert.throws(() => validateState({ tz: "Asia/Tokyo", slots: [{ id: "am", name: "朝", time: "8:00" }] }));
  assert.throws(() => validateState({ tz: "Asia/Tokyo", slots: [1, 2, 3, 4, 5].map(i => ({ id: "s" + i, name: "x", time: "08:00" })) }));
});

// ---------- API と送信処理（保存先はメモリ、送信は記録するだけ） ----------
const fakeSub = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dev${n}`, keys: { p256dh: "x", auth: "y" } });
const call = (api, path, body, method = "POST") => api({ requestContext: { http: { method } }, rawPath: path, body: JSON.stringify(body) })
  .then(r => ({ status: r.statusCode, body: JSON.parse(r.body) }));
function setup(nowDate = JST(2026, 10, 18, 7, 0)) {
  const store = memoryStore(), sent = [];
  const clock = { t: nowDate };
  const send = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload }); return { ok: true, status: 201, gone: false }; };
  const api = makeApi({ store, passphrase: "himitsu", subject: "https://example.com/", now: () => clock.t, send });
  const tick = makeTick({ store, subject: "https://example.com/", now: () => clock.t, send, log: () => {} });
  return { store, sent, clock, api, tick };
}
const state = { tz: "Asia/Tokyo", slots: [{ id: "am", name: "朝", time: "08:00" }, { id: "pm", name: "夜", time: "21:00" }], taken: {} };

test("API：合言葉が違えば登録できない。正しければ登録でき、トークンなしでは更新できない", async () => {
  const { api } = setup();
  assert.equal((await call(api, "/subscribe", { passphrase: "chigau", subscription: fakeSub(), ...state })).status, 403);
  const ok = await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(), ...state });
  assert.equal(ok.status, 200);
  assert.equal((await call(api, "/state", { deviceId: ok.body.deviceId, token: "nise", ...state })).status, 401);
  assert.equal((await call(api, "/state", { ...ok.body, ...state })).status, 200);
});

test("API：Push サービス以外の URL は購読として受け付けない", async () => {
  const { api } = setup();
  const r = await call(api, "/subscribe", { passphrase: "himitsu", subscription: { endpoint: "https://evil.example.com/x", keys: { p256dh: "x", auth: "y" } }, ...state });
  assert.equal(r.status, 400);
});

test(`API：登録は${MAX_DEVICES}台まで。同じ端末の再登録は置き換え`, async () => {
  const { api, store } = setup();
  for (let i = 1; i <= MAX_DEVICES; i++) assert.equal((await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(i), ...state })).status, 200);
  assert.equal((await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(99), ...state })).status, 409);
  assert.equal((await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(1), ...state })).status, 200);
  assert.equal((await store.devices()).length, MAX_DEVICES);
});

test("送信処理：8時に1回だけ送り、飲んだ記録が届けば再通知しない", async () => {
  const { api, tick, sent, clock } = setup();
  const reg = (await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(), ...state })).body;
  clock.t = JST(2026, 10, 18, 8, 0); await tick();
  clock.t = JST(2026, 10, 18, 8, 1); await tick();   // 同じ通知は二度送らない
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.body, "朝の薬の時間です（08:00）");
  await call(api, "/state", { ...reg, ...state, taken: { "2026-10-18": ["am"] } });
  clock.t = JST(2026, 10, 18, 8, 30); await tick();
  assert.equal(sent.length, 1, "飲んだので再通知なし");
});

test("送信処理：飲んでいなければ30分後に再通知。状態を送り直しても送信済みは消えない", async () => {
  const { api, tick, sent, clock } = setup();
  const reg = (await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(), ...state })).body;
  clock.t = JST(2026, 10, 18, 8, 0); await tick();
  await call(api, "/state", { ...reg, ...state });
  clock.t = JST(2026, 10, 18, 8, 3); await tick();
  clock.t = JST(2026, 10, 18, 8, 30); await tick();
  assert.deepEqual(sent.map(s => s.payload.kind), ["first", "remind"]);
});

test("送信処理：端末側で解除された購読（410）は削除する", async () => {
  const { api, store, clock } = setup();
  await call(api, "/subscribe", { passphrase: "himitsu", subscription: fakeSub(), ...state });
  clock.t = JST(2026, 10, 18, 8, 0);
  const tick = makeTick({ store, subject: "x", now: () => clock.t, send: async () => ({ ok: false, status: 410, gone: true }), log: () => {} });
  assert.deepEqual(await tick(), { sent: 0, removed: 1 });
  assert.equal((await store.devices()).length, 0);
});

test("API：VAPID 公開鍵は初回に作られ、以後同じものを返す", async () => {
  const { api } = setup();
  const a = await call(api, "/vapid", null, "GET"), b = await call(api, "/vapid", null, "GET");
  assert.equal(a.status, 200);
  assert.equal(b64u.dec(a.body.publicKey).length, 65);
  assert.equal(a.body.publicKey, b.body.publicKey);
});
