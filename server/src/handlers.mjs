// Lambda の入口。環境変数は template.yaml で設定する
import { dynamoStore } from "./store.mjs";
import { makeApi, makeTick } from "./app.mjs";

const SUBJECT = process.env.VAPID_SUBJECT;
let storeP;
const store = () => (storeP ||= dynamoStore(process.env.TABLE_NAME));

export const api = async event => makeApi({ store: await store(), passphrase: process.env.NOTIFY_PASSPHRASE, subject: SUBJECT })(event);
export const tick = async () => {
  const r = await makeTick({ store: await store(), subject: SUBJECT })();
  if (r.sent || r.removed) console.log(JSON.stringify({ msg: "tick", ...r }));
  return r;
};
