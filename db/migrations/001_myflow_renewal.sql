-- ============================================================
-- 001_myflow_renewal.sql  MyFlow リニューアル用のDB変更（追加のみ）
-- ============================================================
-- ・既存テーブルのデータは一切変更・削除しない
-- ・tasks への変更は「NULL可の列を2つ追加」だけ（既存行は NULL のまま）
-- ・新テーブルはすべて myflow_ プレフィックス（同じSupabaseプロジェクトを他アプリと共有しているため）
-- ・何度実行しても安全（if not exists）
-- ・元に戻す場合は 001_rollback.sql
--
-- 実行場所: Supabase ダッシュボード → SQL Editor
-- 実行前に 000_backup.sql（任意）でスナップショットを取ることを推奨。

begin;

-- ---------- 1) tasks: 任意の追加列 ----------
alter table tasks add column if not exists estimate_minutes integer;   -- 所要時間の見積り(分)。任意
alter table tasks add column if not exists goal_id text;               -- 紐づく目標(goals.id)。任意

-- ---------- 2) タイムボックス（時間帯指定の作業枠） ----------
-- 1つのタスクに複数ひも付けられる。タスクの締切(tasks.due_date)とは別物。
-- window_start/end は「その日の0時からの分」(例: 19:00 = 1140)。date は Asia/Tokyo などの現地日付。
create table if not exists myflow_timeboxes (
  id              text primary key,
  user_id         text not null default 'default',
  mode            text not null check (mode in ('work', 'private')),   -- タスクのカテゴリと常に一致させる
  task_id         text not null,
  date            date not null,
  window_start    integer not null check (window_start between 0 and 1439),
  window_end      integer not null check (window_end between 1 and 1440),
  preset          text check (preset in ('morning', 'noon', 'night', 'custom')),
  planned_minutes integer not null check (planned_minutes between 1 and 1440),
  status          text not null default 'planned' check (status in ('planned', 'done', 'released')),
  actual_minutes  integer check (actual_minutes is null or actual_minutes between 0 and 1440),
  kept_window     boolean,          -- 予定の時間帯の中で実施できたか（タスクの完了とは別に記録）
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (window_start < window_end)
);
create index if not exists myflow_timeboxes_user_mode_date_idx on myflow_timeboxes (user_id, mode, date);
create index if not exists myflow_timeboxes_task_idx           on myflow_timeboxes (task_id);

-- ---------- 3) 固定予定（開始・終了が決まっている予定） ----------
create table if not exists myflow_fixed_events (
  id          text primary key,
  user_id     text not null default 'default',
  mode        text not null check (mode in ('work', 'private')),
  title       text not null,
  date        date,                              -- 単発: その日 / 繰り返し: 開始日
  start_min   integer not null check (start_min between 0 and 1439),
  end_min     integer not null check (end_min between 1 and 1440),
  repeat_days text not null default '',          -- '' = 単発 / '1,2,3,4,5' = 曜日の繰り返し (0=日..6=土)
  until       date,                              -- 繰り返しの終了日（任意）
  allows_tasks boolean not null default false,   -- true: この時間に同じカテゴリの作業を入れてよい（勤務時間など）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (start_min < end_min),
  check (date is not null or repeat_days <> '')
);
create index if not exists myflow_fixed_events_user_mode_idx on myflow_fixed_events (user_id, mode);

-- ---------- 4) 履歴・監査ログ ----------
-- 完了履歴・先送り状況・AIからの操作履歴を1つのログにまとめる（追記のみ）。
create table if not exists myflow_events (
  id          text primary key,
  user_id     text not null default 'default',
  mode        text,                              -- 対象カテゴリ(不明なら NULL)
  type        text not null,                     -- task_completed / timebox_postponed / ai_write ...
  task_id     text,
  timebox_id  text,
  actor       text not null default 'ui',        -- 'ui' または 'ai:<トークン名>'
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists myflow_events_user_created_idx on myflow_events (user_id, created_at desc);
create index if not exists myflow_events_task_idx         on myflow_events (task_id);

-- ---------- 5) 設定（時間帯プリセット・タイムゾーン・余白） ----------
create table if not exists myflow_settings (
  user_id        text primary key,
  timezone       text not null default 'Asia/Tokyo',
  presets        jsonb not null default '[]'::jsonb,
  buffer_minutes integer not null default 5 check (buffer_minutes between 0 and 120),
  updated_at     timestamptz not null default now()
);

-- ---------- 6) AI 連携トークン ----------
-- トークンの平文は保存しない（SHA-256 のハッシュのみ）。権限とカテゴリはトークンごと。
create table if not exists myflow_ai_tokens (
  id            text primary key,
  user_id       text not null default 'default',
  name          text not null,
  token_hash    text not null unique,
  token_prefix  text not null,                   -- 一覧表示用の先頭数文字
  allowed_modes text not null default 'private', -- カンマ区切り。'' なら何も許可しない
  scopes        text not null default 'read',    -- read,task_add,task_edit,schedule,complete,delete
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,                     -- 値が入ったら無効（取り消し）
  created_at    timestamptz not null default now()
);

-- ---------- 7) 行レベルセキュリティ ----------
-- このプロジェクトは他アプリと共有されており、anon キーが公開されている可能性がある。
-- 新テーブルは RLS を有効化し（ポリシーなし = anon/authenticated は一切アクセス不可）、
-- サーバー側の service_role だけが読み書きできるようにする。
alter table myflow_timeboxes    enable row level security;
alter table myflow_fixed_events enable row level security;
alter table myflow_events       enable row level security;
alter table myflow_settings     enable row level security;
alter table myflow_ai_tokens    enable row level security;

commit;

-- 確認用（任意）: 新テーブルと追加列ができていること
-- select table_name from information_schema.tables where table_name like 'myflow\_%' order by 1;
-- select column_name from information_schema.columns where table_name = 'tasks' and column_name in ('estimate_minutes','goal_id');
