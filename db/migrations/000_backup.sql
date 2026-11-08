-- ============================================================
-- 000_backup.sql  マイグレーション前の任意バックアップ（DB内スナップショット）
-- ============================================================
-- 既存データを変更しない 001 の前に、念のため同じDB内にコピーを残す。
-- 実行場所: Supabase ダッシュボード → SQL Editor
--
-- 復元したいとき（例: tasks を実行前の状態へ）:
--   begin;
--   delete from tasks;
--   insert into tasks select * from myflow_bak_20261105_tasks;
--   commit;
--
-- 不要になったら（問題なく使えると確認できてから）:
--   drop table myflow_bak_20261105_tasks, myflow_bak_20261105_goals,
--              myflow_bak_20261105_memos, myflow_bak_20261105_highlights;
--
-- ※ 日付部分(20261105)は実行する日に合わせて置き換えてよい。
-- ※ Supabase の自動バックアップ(プランによる)や、各テーブルの CSV エクスポート
--    (Table Editor → Export to CSV) と併用するとより安全。

create table if not exists myflow_bak_20261105_tasks      as select * from tasks;
create table if not exists myflow_bak_20261105_goals      as select * from goals;
create table if not exists myflow_bak_20261105_memos      as select * from memos;
create table if not exists myflow_bak_20261105_highlights as select * from highlights;

-- バックアップ表は公開APIから見えないようにする
alter table myflow_bak_20261105_tasks      enable row level security;
alter table myflow_bak_20261105_goals      enable row level security;
alter table myflow_bak_20261105_memos      enable row level security;
alter table myflow_bak_20261105_highlights enable row level security;

-- 件数の確認（元テーブルと同じ件数になっていること）
select 'tasks' as t, (select count(*) from tasks) as src, (select count(*) from myflow_bak_20261105_tasks) as bak
union all select 'goals',      (select count(*) from goals),      (select count(*) from myflow_bak_20261105_goals)
union all select 'memos',      (select count(*) from memos),      (select count(*) from myflow_bak_20261105_memos)
union all select 'highlights', (select count(*) from highlights), (select count(*) from myflow_bak_20261105_highlights);
