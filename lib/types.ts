// DB の行の型（サーバー・クライアント共通）。新しい列は任意(?)にして、未マイグレーション環境でも壊れないようにする。

export type Priority = "high" | "mid" | "low"

export interface TaskRow {
  id: string
  user_id: string
  mode: string
  text: string
  priority: Priority
  start_date: string | null
  due_date: string | null
  done: boolean
  parent_id: string | null
  memo: string | null
  is_recurring: boolean
  recurring_days: string
  recurring_done_date: string | null
  sort_order: number | null
  created_at: string
  estimate_minutes?: number | null
  goal_id?: string | null
}

export interface GoalRow {
  id: string
  user_id: string
  mode: string
  text: string
  due_date: string | null
  pct: number
  created_at: string
}

export interface TimeboxDb {
  id: string
  user_id: string
  mode: string
  task_id: string
  date: string
  window_start: number
  window_end: number
  preset: "morning" | "noon" | "night" | "custom" | null
  planned_minutes: number
  status: "planned" | "done" | "released"
  actual_minutes: number | null
  kept_window: boolean | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface FixedEventDb {
  id: string
  user_id: string
  mode: string
  title: string
  date: string | null
  start_min: number
  end_min: number
  repeat_days: string
  until: string | null
  allows_tasks: boolean
  created_at: string
  updated_at: string
}

export type EventType =
  | "task_created" | "task_completed" | "task_reopened" | "task_deleted" | "task_category_changed" | "task_unplaced"
  | "timebox_created" | "timebox_moved" | "timebox_postponed" | "timebox_resized" | "timebox_done" | "timebox_split" | "timebox_unplaced"
  | "fixed_event_deleted"
  | "ai_call" | "token_created" | "token_revoked"

export interface EventRow {
  id: string
  user_id: string
  mode: string | null
  type: EventType
  task_id: string | null
  timebox_id: string | null
  actor: string
  payload: Record<string, unknown>
  created_at: string
}
