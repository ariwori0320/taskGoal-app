# ChatGPT から MyFlow を操作する（カスタム MCP コネクタ連携）

OpenAI が Custom GPT の「アクション(Actions)」を終了（2026年〜）したため、
ChatGPT 連携は **カスタム MCP コネクタ（開発者モード）** で行う。
この方式は **ChatGPT Business / Enterprise / Edu** で書き込み操作（追加・変更・完了・削除）まで使える。

## 追加したもの（すべて追加のみ・既存機能は不変）
- `app/api/connect/[transport]/route.ts` … MCP サーバー本体（tools: list/add/complete/update/delete）
- `lib/gpt.ts` … 認証・整形の共通処理（REST版と共用）
- 依存: `mcp-handler@^1`, `@modelcontextprotocol/sdk@^1`, `zod@^3`

> 旧 REST/OpenAPI 版（`/api/gpt/*`, `public/openapi-gpt.json`）も残してあるが、ChatGPT の
> Custom GPT Actions 終了に伴い ChatGPT からは使わない。iOS ショートカット等の別連携には流用可能。

## 接続情報
- **MCP サーバー URL**: `https://task-goal-app-qlr7.vercel.app/api/connect/mcp`
- **認証**: Token 方式（`Authorization: Bearer <GPT_API_KEY>`）。環境変数 `GPT_API_KEY` は設定済み。
- 未設定時は 503、トークン不一致は 401 を返す。

---

## セットアップ手順（ChatGPT Business）

### 1. 開発者モードを有効化
1. ChatGPT（ブラウザ版）→ **設定(Settings)**
2. **「コネクタ(Connectors)」**（または「Security and login」）を開く
   ※ Business では、まず**ワークスペース管理者**が開発者モード/カスタムコネクタを許可する必要がある場合あり
3. **「開発者モード(Developer mode)」** を有効化

### 2. カスタムコネクタを追加
1. 「コネクタ」画面で **「カスタムコネクタを追加 / Create」**
2. 入力:
   - **名前(Name)**: `MyFlow`
   - **MCP サーバー URL**: `https://task-goal-app-qlr7.vercel.app/api/connect/mcp`
   - **認証(Authentication)**: **Token（APIキー）** を選び、`GPT_API_KEY` の値を貼り付け
3. 信頼の確認にチェックして **作成/接続**
4. 成功すると `list_tasks` `add_task` `complete_task` `update_task` `delete_task` の5ツールが見えるはず

### 3. 使う
- 新規チャットで、ツール/コネクタに **MyFlow** を有効にして話しかける
  - 「未完了のタスク教えて」→ list_tasks
  - 「"牛乳を買う"を追加」→ add_task
  - 「それ完了にして」→ complete_task
  - 「"牛乳"を削除して」→ delete_task（**ChatGPT が実行前に確認を出す**）
- 変更・削除は ChatGPT が実行前に確認する仕様。ツール側でも破壊的操作として注釈済み。

---

## 動作確認済み（ローカル `next start`）
- 認証なし → 401 / 未設定 → 503
- `initialize` → protocolVersion・tools capability・serverInfo を正常応答
- `tools/list` → 5ツールを公開

## セキュリティ補足
- 認証は共有トークン（`GPT_API_KEY`）1本。漏れたら Vercel で値を変えて再デプロイすれば無効化できる。
- 既存の `/api/tasks` 等（アプリ本体用）は従来どおり無認証（本件の対象外）。
- `npm audit` の指摘のうち critical は Next.js 本体の既存事項、MCP SDK の high は
  未使用の OAuth クライアント機能に関するもの。将来的な Next.js 更新は別タスク。
