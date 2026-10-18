// いつ・どの予定の通知を送るかを決める純粋関数。時刻と端末の情報だけを入力にし、副作用を持たない。

export const REMIND_AFTER_MIN = 30;   // 最初の通知から再通知までの分数
export const WINDOW_MIN = 15;          // 予定時刻からこの分数を過ぎたら送らない（止まっていた後にまとめて届くのを防ぐ）
export const KEEP_DAYS = 3;            // taken / sent を残す日数

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// タイムゾーン tz での日付(YYYY-MM-DD)と、0時からの分数
export function localNow(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function addDaysStr(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

// 送るべき通知の一覧。昨日の予定（23時台の予定の再通知が0時をまたぐ場合）も見る
export function dueNotifications(item, now) {
  const { date: today, min: nowMin } = localNow(now, item.tz);
  const out = [];
  for (const offset of [0, -1]) {
    const date = offset ? addDaysStr(today, -1) : today;
    const taken = new Set((item.taken && item.taken[date]) || []);
    for (const slot of item.slots || []) {
      if (taken.has(slot.id)) continue;
      for (const kind of ["first", "remind"]) {
        // 今日の0時からの分数。昨日の予定は -1440 分ずらす
        const at = toMin(slot.time) + (kind === "remind" ? REMIND_AFTER_MIN : 0) + offset * 1440;
        if (nowMin < at || nowMin >= at + WINDOW_MIN) continue;
        const key = `${date}|${slot.id}|${kind}`;
        if (item.sent && item.sent[key]) continue;
        out.push({
          key, date, slotId: slot.id, kind,
          payload: {
            title: "花あつめ",
            body: kind === "first"
              ? `${slot.name}の薬の時間です（${slot.time}）`
              : `${slot.name}の薬がまだ記録されていません（${slot.time}の予定）`,
            tag: `${date}|${slot.id}`, slotId: slot.id, date, kind,
          },
        });
      }
    }
  }
  return out;
}

// 古い taken / sent を消す
export function prune(map, today, keyDate = k => k.slice(0, 10)) {
  const min = addDaysStr(today, -(KEEP_DAYS - 1)), out = {};
  for (const [k, v] of Object.entries(map || {})) if (keyDate(k) >= min) out[k] = v;
  return out;
}

// 端末から送られてきた予定・服用状態の検証。不正なら Error を投げる
export function validateState(input) {
  const tz = String(input.tz || "");
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { throw new Error("invalid tz"); }
  if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 4) throw new Error("invalid slots");
  const slots = input.slots.map(s => {
    const id = String(s.id || ""), name = String(s.name || "").slice(0, 12), time = String(s.time || "");
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || !name || !TIME_RE.test(time)) throw new Error("invalid slot");
    return { id, name, time };
  });
  const taken = {};
  for (const [date, ids] of Object.entries(input.taken || {})) {
    if (!DATE_RE.test(date) || !Array.isArray(ids)) throw new Error("invalid taken");
    taken[date] = ids.map(String).filter(id => /^[A-Za-z0-9_-]{1,24}$/.test(id)).slice(0, 8);
  }
  return { tz, slots, taken };
}
