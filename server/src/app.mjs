// API（Lambda 関数URL）と、1分ごとの送信処理。保存先と送信処理は引数で受け取り、テストで差し替えられるようにする
import crypto from "node:crypto";
import { generateVapidKeys, sendPush } from "./webpush.mjs";
import { dueNotifications, localNow, prune, validateState } from "./schedule.mjs";

export const MAX_DEVICES = 5;
const MAX_BODY = 8 * 1024;
// 購読先として受け付ける Push サービス（任意のURLへ送信させない）
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

const sha256 = s => crypto.createHash("sha256").update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function getVapid(store) {
  const cur = await store.get("config#vapid");
  if (cur) return cur;
  await store.putIfAbsent({ pk: "config#vapid", ...generateVapidKeys(), createdAt: new Date().toISOString() });
  return store.get("config#vapid");   // 同時に作られた場合も、先に保存された方を使う
}

function validSubscription(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(re => re.test(u.hostname))
      && typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string";
  } catch { return false; }
}

async function authDevice(store, body) {
  const id = String(body.deviceId || "");
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const dev = await store.get("dev#" + id);
  if (!dev || !crypto.timingSafeEqual(Buffer.from(dev.tokenHash, "hex"), sha256(body.token || ""))) return null;
  return dev;
}

export function makeApi({ store, passphrase, subject, now = () => new Date(), send = sendPush }) {
  return async function handler(event) {
    const method = event.requestContext?.http?.method || "GET";
    const path = event.rawPath || "/";
    if (method === "GET" && path === "/vapid") return json(200, { publicKey: (await getVapid(store)).publicKey });
    if (method !== "POST") return json(404, { error: "not found" });

    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : (event.body || "");
    if (raw.length > MAX_BODY) return json(413, { error: "too large" });
    let body; try { body = JSON.parse(raw || "{}"); } catch { return json(400, { error: "invalid json" }); }

    if (path === "/subscribe") {
      if (!passphrase || !sameSecret(body.passphrase || "", passphrase)) return json(403, { error: "合言葉が違います" });
      if (!validSubscription(body.subscription || {})) return json(400, { error: "invalid subscription" });
      let st; try { st = validateState(body); } catch (e) { return json(400, { error: e.message }); }
      const devices = await store.devices();
      for (const d of devices) if (d.sub.endpoint === body.subscription.endpoint) await store.remove(d.pk);   // 同じ端末の再登録
      if (devices.filter(d => d.sub.endpoint !== body.subscription.endpoint).length >= MAX_DEVICES) return json(409, { error: `登録できる端末は${MAX_DEVICES}台までです` });
      const deviceId = crypto.randomBytes(16).toString("hex"), token = crypto.randomBytes(32).toString("base64url");
      const t = now().toISOString(), today = localNow(now(), st.tz).date;
      await store.put({
        pk: "dev#" + deviceId, deviceId, tokenHash: sha256(token).toString("hex"),
        sub: { endpoint: body.subscription.endpoint, keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth } },
        tz: st.tz, slots: st.slots, taken: prune(st.taken, today), sent: {}, createdAt: t, updatedAt: t,
      });
      return json(200, { deviceId, token });
    }

    const dev = await authDevice(store, body);
    if (!dev) return json(401, { error: "unknown device" });

    if (path === "/state") {
      let st; try { st = validateState(body); } catch (e) { return json(400, { error: e.message }); }
      const today = localNow(now(), st.tz).date;
      // 送信済みの印は残す（状態の更新で同じ通知が再送されないように）
      await store.put({ ...dev, tz: st.tz, slots: st.slots, taken: prune(st.taken, today), sent: prune(dev.sent, today), updatedAt: now().toISOString() });
      return json(200, { ok: true });
    }
    if (path === "/test") {
      const r = await send(dev.sub, { title: "花あつめ", body: "テスト通知です。この端末で通知を受け取れます。", tag: "test" }, await getVapid(store), subject);
      if (r.gone) await store.remove(dev.pk);
      return json(r.ok ? 200 : 502, { status: r.status });
    }
    if (path === "/unsubscribe") { await store.remove(dev.pk); return json(200, { ok: true }); }
    return json(404, { error: "not found" });
  };
}

// 1分ごとに呼ばれる。送る前に「送信済み」の印を付けるので、同じ通知は最大1回（重複より取りこぼしを選ぶ）
export function makeTick({ store, subject, now = () => new Date(), send = sendPush, log = console.log }) {
  return async function tick() {
    const t = now(), vapid = await getVapid(store);
    let sent = 0, removed = 0;
    for (const dev of await store.devices()) {
      for (const n of dueNotifications(dev, t)) {
        if (!(await store.markSent(dev.pk, n.key, t.toISOString()))) continue;
        try {
          const r = await send(dev.sub, n.payload, vapid, subject);
          if (r.gone) { await store.remove(dev.pk); removed++; break; }
          if (r.ok) sent++; else log(JSON.stringify({ msg: "push failed", status: r.status, key: n.key }));
        } catch (e) { log(JSON.stringify({ msg: "push error", error: String(e), key: n.key })); }
      }
    }
    return { sent, removed };
  };
}
