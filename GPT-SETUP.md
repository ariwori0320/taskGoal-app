# ChatGPT から MyFlow を操作する（Custom GPT Actions 連携）

ChatGPT の **Custom GPT（GPT Builder）の Actions** から MyFlow のタスクを操作するための手順。
既存のアプリ機能・API（`/api/tasks` など）には一切手を加えていない。追加した `/api/gpt/*` だけを使う。

## 追加されたもの（すべて追加のみ）
- `app/api/gpt/tasks/route.ts` … 一覧取得(GET) / 追加(POST)
- `app/api/gpt/tasks/complete/route.ts` … 完了・未完了戻し(POST)
- `app/api/gpt/tasks/update/route.ts` … 変更(POST, confirm必須)
- `app/api/gpt/tasks/delete/route.ts` … 削除(POST, confirm必須)
- `lib/gpt.ts` … 認証・整形の共通処理
- `public/openapi-gpt.json` … GPT に登録するスキーマ（`https://<本番URL>/openapi-gpt.json` で配信）

## 設計
- **認証**: `Authorization: Bearer <GPT_API_KEY>`。環境変数 `GPT_API_KEY` 未設定時は 503 で全拒否（誤公開防止）。
- **即時実行**: 取得 / 追加 / 完了。
- **確認後に実行**: 変更 / 削除。`confirm:true` が無いと実行せず、対象のプレビューを返す（`needsConfirmation: true`）。
  ChatGPT 側の実行確認（consequential）とサーバー側の confirm ゲートで二重に守る。
- **対象ユーザー**: `user_id="default"` 固定の本人専用。

---

## セットアップ手順

### 1. APIキーを決めて Vercel に設定
`openssl rand -base64 32` などで長いランダム文字列を生成し、Vercel の
Project → Settings → Environment Variables に追加して **再デプロイ**する。

```
GPT_API_KEY = <生成したランダム文字列>
```

> ⚠️ 設定するまで `/api/gpt/*` は 503 を返す（＝無防備に公開されない）。

### 2. 本番URLを確認して openapi-gpt.json を書き換え
`public/openapi-gpt.json` の `servers[0].url` を自分の本番URL（例 `https://taskgoal-app.vercel.app`）に置き換えてコミット・デプロイ。
デプロイ後、ブラウザで `https://<本番URL>/openapi-gpt.json` が開けることを確認。

### 3. Custom GPT を作成
1. ChatGPT → 左下「GPTを探す」→「作成する」→「構成(Configure)」タブ。
2. 一番下の **「アクションを作成する」** を開く。
3. **スキーマ**: `https://<本番URL>/openapi-gpt.json` を「URLからインポート」するか、JSON を貼り付け。
4. **認証(Authentication)**: 種類 **API Key** / **Bearer** を選び、`GPT_API_KEY` に設定した値を入力。
5. 保存。

### 4. GPT の指示（Instructions）に貼る
```
あなたは MyFlow のタスク管理アシスタントです。日本語で応対します。

- 「何かある?」「今日のタスク」などの問い合わせは listTasks で取得して答える（既定は未完了）。
- タスク追加は addTask で即時に行う。期限・優先度・繰り返しが指定されたら反映する。
- 「終わった」「完了」は completeTask を使う。該当タスクが曖昧なら listTasks で候補を出して確認する。
- タスクの内容変更(updateTask)と削除(deleteTask)は必ずユーザーに確認してから実行する。
  手順: まず confirm を付けずに呼ぶ → 返ってきた needsConfirmation の内容をユーザーに提示 →
  「はい」と同意が取れたら同じ操作を confirm:true で再送する。同意が無ければ実行しない。
- 対象タスクの特定には listTasks（q でキーワード検索）を使い、取得した id を各操作に渡す。
- 操作後は結果を簡潔に報告する。
```

### 5. 動作確認
- 「未完了のタスクを教えて」→ listTasks
- 「『牛乳を買う』を追加して」→ addTask
- 「それを完了にして」→ completeTask
- 「『牛乳を買う』を削除して」→ deleteTask が確認を返す → 「はい」→ confirm:true で削除

---

## 補足・既知の制約
- 既存の `/api/tasks` など（アプリ本体用）は**従来どおり無認証**（本件の対象外）。外部公開は `/api/gpt/*` のみ認証を掛けている。
- `deleteTask` は指定 id のみ削除する（アプリ UI のようにサブタスクを連鎖削除はしない）。必要なら今後対応可能。
- goals / memos を ChatGPT から扱いたくなった場合も、同じ方式で `/api/gpt/goals` 等を追加できる。
