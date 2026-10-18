// データの保存先。本番は DynamoDB、テストではメモリ上の実装を使う（同じメソッドを持つ）
// 1テーブルに次の2種類を入れる
//   pk = "config#vapid"      … VAPID 鍵（初回に自動で作る）
//   pk = "dev#<deviceId>"    … 通知を受け取る端末（購読情報・予定・服用状態・送信済み）

export function memoryStore() {
  const m = new Map();
  const clone = v => v === undefined ? undefined : structuredClone(v);
  return {
    async get(pk) { return clone(m.get(pk)); },
    async putIfAbsent(item) { if (m.has(item.pk)) return false; m.set(item.pk, clone(item)); return true; },
    async put(item) { m.set(item.pk, clone(item)); },
    async remove(pk) { m.delete(pk); },
    async devices() { return [...m.values()].filter(v => v.pk.startsWith("dev#")).map(clone); },
    // 送信済みの印を付ける。すでに付いていたら false（二重送信の防止）
    async markSent(pk, key, at) {
      const v = m.get(pk); if (!v) return false;
      v.sent = v.sent || {};
      if (v.sent[key]) return false;
      v.sent[key] = at; return true;
    },
    _dump: () => m,
  };
}

export async function dynamoStore(tableName) {
  // Lambda の Node.js ランタイムに AWS SDK v3 が含まれているので、依存関係として入れない
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const T = tableName;
  return {
    async get(pk) { return (await db.send(new GetCommand({ TableName: T, Key: { pk } }))).Item; },
    async putIfAbsent(item) {
      try { await db.send(new PutCommand({ TableName: T, Item: item, ConditionExpression: "attribute_not_exists(pk)" })); return true; }
      catch (e) { if (e.name === "ConditionalCheckFailedException") return false; throw e; }
    },
    async put(item) { await db.send(new PutCommand({ TableName: T, Item: item })); },
    async remove(pk) { await db.send(new DeleteCommand({ TableName: T, Key: { pk } })); },
    async devices() {
      const out = []; let ExclusiveStartKey;
      do {
        const r = await db.send(new ScanCommand({
          TableName: T, ExclusiveStartKey,
          FilterExpression: "begins_with(pk, :p)", ExpressionAttributeValues: { ":p": "dev#" },
        }));
        out.push(...(r.Items || [])); ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async markSent(pk, key, at) {
      try {
        await db.send(new UpdateCommand({
          TableName: T, Key: { pk },
          UpdateExpression: "SET sent.#k = :at",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(sent.#k)",
          ExpressionAttributeNames: { "#k": key }, ExpressionAttributeValues: { ":at": at },
        }));
        return true;
      } catch (e) { if (e.name === "ConditionalCheckFailedException") return false; throw e; }
    },
  };
}
