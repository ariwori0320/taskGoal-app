-- ============================================================
-- 001_rollback.sql  001_myflow_renewal.sql を元に戻す
-- ============================================================
-- ⚠️ 実行すると、リニューアルで新しく作ったデータ（タイムボックス・固定予定・履歴・設定・AIトークン）は消える。
--    tasks / goals / memos / highlights の既存データは変更されない
--    （tasks に追加した 2 列 estimate_minutes / goal_id に入れた値だけは消える）。
-- 必要なら先に各テーブルを CSV エクスポートしておく。

begin;

drop table if exists myflow_ai_tokens;
drop table if exists myflow_settings;
drop table if exists myflow_events;
drop table if exists myflow_fixed_events;
drop table if exists myflow_timeboxes;

alter table tasks drop column if exists estimate_minutes;
alter table tasks drop column if exists goal_id;

commit;
