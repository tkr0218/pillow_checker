# 花あつめ（PWA版）

1日1〜4回の服用を記録し、記録の回数に応じて咲く花を図鑑に集めるアプリ。
オフラインで動く PWA。記録は使っている端末の中（localStorage）に保存される。
通知を有効にした端末だけ、予定（名前・時刻）と、今日と前日にどの予定を記録したかを通知サーバー（AWS）に送る。飲んだ時刻と花の記録は送らない。

https://tkr0218.github.io/pillow_checker/

このアプリは記録用です。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体（画面・ロジックすべて） |
| `manifest.webmanifest` | ホーム画面に追加したときの名前・アイコン・全画面表示の設定 |
| `sw.js` | Service Worker。オフライン起動とキャッシュ更新 |
| `icons/` | アプリアイコン |
| `test_blooms.mjs` / `blooms.snapshot.json` | 抽選ロジックの回帰テストと固定スナップショット |

## 1. GitHub Pages で公開する（無料）

1. GitHub で新しいリポジトリを作る（例: `kusuri`）。**Public** にする（無料プランの Pages は Public のみ）
2. このフォルダの中身をリポジトリ直下に push
   ```sh
   cd kusuri-pwa
   git init && git add . && git commit -m "first release"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/kusuri.git
   git push -u origin main
   ```
3. リポジトリの **Settings → Pages** で Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして保存
4. 数分後に `https://<ユーザー名>.github.io/kusuri/` で開ける

> Public リポジトリにはコードだけが載り、服薬の記録は載りません（記録はスマホ内だけ）。

## 2. Android にインストールする

1. Android の Chrome で上の URL を開く
2. メニュー（︙）→「アプリをインストール」または「ホーム画面に追加」
3. ホーム画面のアイコンから起動すると、ブラウザのバーなしで全画面で開く

## 3. 飲む時刻に知らせる（いまはサーバーなしで）

Android の「時計」アプリで朝・夜のアラームを作り、ラベルを「くすり」にしておく。
アプリ内からの通知は次のステップ（下の「今後」）で AWS を使って実装する。

## 4. アプリを更新するとき

1. `index.html` などを変更
2. `sw.js` の `VERSION` を必ず上げる（上げないと古いキャッシュが残り続ける）
3. テストを実行してから push
   ```sh
   TZ=Asia/Tokyo node test_blooms.mjs
   ```
4. スマホ側は、アプリを一度閉じて開き直すと新しい版になる

## バックアップ

記録はスマホの中だけにある。機種変更・Chrome のデータ削除・アプリのアンインストールで消える。
画面下の「ファイルに書き出す」で JSON を保存し、Google ドライブなどに置いておく。
「ファイルから読み込む」は既存の記録を優先し、足りない日だけを追加する（上書きしない）。

## 花の抽選ルールを変えるときの約束

`index.html` 内のコメントにも書いてあるとおり：

- `RULESETS` と `SPECIES` は**追記のみ**。既存行の変更・削除・並べ替えは禁止
- ルールを変えるときは新しい版を `from`（適用開始日）つきで足す
- 新しい花には新しい版番号 `v` をつける
- 何回で咲くかを変えるときは `CADENCES` に適用開始時刻つきの新しい版を足す（既存の版は変えない）
- 変更後は `test_blooms.mjs` が全部通ることを確認。スナップショットを `--update` で書き換えるのは「過去の花が変わってもいい」と判断したときだけ

## 今後：アプリから通知を出す（AWS）

Web には「毎朝8時にローカル通知」という仕組みがないので、サーバーから Web Push を送る。

```
スマホ(PWA) ──購読情報──▶ API Gateway + Lambda ──▶ DynamoDB（購読・飲んだ記録）
                                   ▲
EventBridge Scheduler（朝・夜）────┘──▶ Lambda が web-push で通知送信
```

- 飲んだかどうかをサーバーも知っていれば「まだ飲んでいない人にだけ」通知できる
- この規模ならほぼ無料枠に収まる見込み。**最初に AWS Budgets で月1ドルの予算アラートを設定**してから始める

## 通知（Web Push）

予定の時刻に、まだ記録していない予定だけを通知する。30分たっても記録がなければもう一度通知する。
通知サーバーは AWS（Lambda・EventBridge Scheduler・DynamoDB）で動き、GitHub Actions からデプロイする。登録には合言葉が必要。

```
スマホ(PWA) ──登録・予定・服用状態──▶ Lambda（関数URL） ──▶ DynamoDB
EventBridge Scheduler（10分ごと）──▶ Lambda ──▶ Web Push ──▶ スマホ
```

| ファイル | 役割 |
|---|---|
| `server/src/` | 通知サーバー。Web Push の暗号化も Node 標準の crypto で実装し、外部ライブラリを使わない |
| `server/test/` | サーバーと `sw.js` の通知処理のテスト（RFC 8291 の例との照合を含む） |
| `server/template.yaml` | 通知サーバーの AWS 構成（SAM） |
| `server/bootstrap.yaml` | 初回だけ使う。GitHub Actions 用の OIDC・デプロイ用ロール・成果物バケット |
| `.github/workflows/test-and-deploy.yml` | push のたびにテストを実行し、main なら通知サーバーをデプロイ |

### 初回の準備

1. AWS Budgets で月1ドルの予算アラートを作る
2. 東京リージョン（ap-northeast-1）の CloudFormation で `server/bootstrap.yaml` からスタックを作る（スタック名は `hana-notify-bootstrap`）。パラメータ `GitHubSubject` は、2026年7月15日以降に作ったリポジトリなら `repo:所有者@所有者ID/リポジトリ@リポジトリID`（ID は `GET /repos/{owner}/{repo}` の `owner.id` と `id`）
3. GitHub の Settings → Secrets and variables → Actions で次を設定する
   - Variables: `AWS_ROLE_ARN`、`AWS_ARTIFACT_BUCKET`（bootstrap スタックの出力の値）
   - Secrets: `NOTIFY_PASSPHRASE`（8文字以上、空白なし）
4. Actions から `test-and-deploy` を実行する。出力の `ApiUrl` を `index.html` の `NOTIFY_URL` に設定して push する

### 費用

10分ごと（毎時0・10・20…分）の起動で月約4,300回。Lambda の無料枠内。DynamoDB はプロビジョンド 2/2 で無料枠内。ログは7日で削除する。
