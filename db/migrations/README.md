# DB マイグレーション（リニューアル）

**これは本番データベースの変更です。** 追加のみで既存データは変更・削除しませんが、実行前に必ずバックアップを取ってください。
アプリは、マイグレーションを実行する前でも、今までのタスク・目標・メモは従来どおり動きます
（新機能の画面には「データベースの更新が必要です」と表示されます）。

## 手順（Supabase ダッシュボード → SQL Editor）

1. **バックアップ**（任意だが推奨）: `000_backup.sql` を実行。同じ DB の中に `myflow_bak_YYYYMMDD_*` というコピーができる。
   さらに Table Editor から `tasks / goals / memos / highlights` を CSV でエクスポートしておくと安心。
2. **適用**: `001_myflow_renewal.sql` を実行。何度実行しても安全（`if not exists`）。
3. **確認**: SQL Editor で次を実行し、5つのテーブルと2つの列があること。
   ```sql
   select table_name from information_schema.tables where table_name like 'myflow\_%' and table_name not like 'myflow\_bak%' order by 1;
   select column_name from information_schema.columns where table_name = 'tasks' and column_name in ('estimate_minutes','goal_id');
   ```
4. **アプリを再読み込み**して、「計画」画面が開けることを確認。

## 何が変わるか

| 変更 | 内容 |
|---|---|
| `tasks` に列を2つ追加 | `estimate_minutes`（所要時間）、`goal_id`（目標との紐づけ）。どちらも NULL 可。既存の行は NULL のまま |
| 新テーブル | `myflow_timeboxes`（予定）/ `myflow_fixed_events`（固定予定）/ `myflow_events`（履歴・監査ログ）/ `myflow_settings`（設定）/ `myflow_ai_tokens`（AI の合鍵） |
| 行レベルセキュリティ | 新テーブルはすべて有効化（ポリシー無し = 公開APIの anon キーからは読めない。サーバーの service_role だけが使える） |

テーブル名に `myflow_` を付けているのは、このプロジェクトを他のアプリと共有しているためです。

## 元に戻す

`001_rollback.sql` を実行。⚠️ リニューアルで作ったデータ（予定・固定予定・履歴・設定・AI の合鍵）は消えます。
`tasks / goals / memos / highlights` の既存データは変わりません（`tasks` の追加2列に入れた値だけ消える）。

## 検証済みの内容
PGlite（Postgres 互換）上で、次を確認しています: 既存データが不変 / 2回実行しても安全 / 制約が効く
（例: 予定の `status` に `failed` は入らない）/ ロールバック後に実行前と完全に同一 / バックアップからの復元。
