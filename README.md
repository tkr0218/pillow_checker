# 朝夜のくすり（PWA版）

> **個人用プロジェクトです。** 作者が自分で使うためのもので、利用・コントリビューションは受け付けていません。
> 公開は GitHub Pages の都合によるもので、検索エンジンにはインデックスさせない設定にしています。

朝と夜の薬を飲んだらタップして植物に水やり。花を咲かせて図鑑を集める服薬記録アプリ。
サーバー不要・オフラインで動く PWA。記録はスマホの中（localStorage）に保存。

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
- `BLOOM_AT`（何回で咲くか）は変えない
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
