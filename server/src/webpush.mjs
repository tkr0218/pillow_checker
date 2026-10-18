// Web Push 送信（RFC 8291 aes128gcm 暗号化 + RFC 8292 VAPID）。外部ライブラリなし、Node 標準の crypto と fetch だけを使う。
import crypto from "node:crypto";

export const b64u = {
  enc: buf => Buffer.from(buf).toString("base64url"),
  dec: str => Buffer.from(str, "base64url"),
};

// VAPID 鍵を作る。publicKey は非圧縮形式(65バイト)、privateKey は d(32バイト)。どちらも base64url
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" }), priv = privateKey.export({ format: "jwk" });
  return {
    publicKey: b64u.enc(Buffer.concat([Buffer.from([4]), b64u.dec(pub.x), b64u.dec(pub.y)])),
    privateKey: priv.d,
  };
}

function privateKeyObject({ publicKey, privateKey }) {
  const pub = b64u.dec(publicKey);
  return crypto.createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: privateKey, x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) },
  });
}

// VAPID の Authorization ヘッダー
export function vapidHeader(endpoint, vapid, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const header = b64u.enc(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u.enc(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject }));
  const input = `${header}.${claims}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: privateKeyObject(vapid), dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

// RFC 8291 による暗号化。テストでは asPrivateKey と salt を固定して RFC の例と照合する
export function encrypt(payload, keys, { asPrivateKey, salt, recordSize = 4096 } = {}) {
  const uaPublic = b64u.dec(keys.p256dh), authSecret = b64u.dec(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("invalid subscription keys");
  const ecdh = crypto.createECDH("prime256v1");
  if (asPrivateKey) ecdh.setPrivateKey(asPrivateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  salt = salt || crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // 0x02 = 最後のレコード
  if (plain.length + 16 > recordSize) throw new Error("payload too large");
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(recordSize);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// 送信。戻り値の gone が true なら購読は無効（端末側で解除された）なので削除する
export async function sendPush(subscription, payloadObj, vapid, subject, { ttl = 3600, fetchImpl = fetch } = {}) {
  const body = encrypt(JSON.stringify(payloadObj), subscription.keys);
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(subscription.endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body,
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}
