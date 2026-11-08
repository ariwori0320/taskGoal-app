import { db, isMissingColumn, isMissingTable, type Cond } from "../db"
import { recordEvent } from "../events"
import { newId } from "../id"
import {
  badRequest, migrationRequired, requireMode, requireScope, resolveModes,
  type Mode, type Principal,
} from "../principal"
import { buildHierarchy, isTaskDone, type TaskNode } from "../task-utils"
import { nowInTz } from "../time"
import type { TaskRow, TimeboxDb } from "../types"
import { cleanText, normDays, optBool, optEstimate, optPriority, optString, optYmd } from "../validate"
import { loadSettings } from "./settings"
import { collectDescendants, getGoalRow, getTaskRow, taskDepth } from "./rows"

// 完了判定は画面と共通の純粋関数を使う
export { isTaskDone }

/** AI などへ返す整形（内部の列名・並び順などは出さない） */
export function shapeTask(t: TaskRow, today: string) {
  return {
    id: t.id,
    text: t.text,
    mode: t.mode,
    priority: t.priority,
    completed: isTaskDone(t, today),
    start_date: t.start_date ?? null,
    due_date: t.due_date ?? null,
    estimate_minutes: t.estimate_minutes ?? null,
    is_recurring: !!t.is_recurring,
    recurring_days: t.recurring_days ?? "",
    parent_id: t.parent_id ?? null,
    goal_id: t.goal_id ?? null,
    memo: t.memo ?? null,
    created_at: t.created_at,
  }
}

// ---------- 取得 ----------

export interface ListTasksQuery {
  mode?: string | null
  status?: "active" | "done" | "all"
  q?: string
  due_from?: string
  due_to?: string
  goal_id?: string
  limit?: number
}

export async function listTasks(p: Principal, query: ListTasksQuery = {}): Promise<{ today: string; tasks: TaskRow[]; hierarchy: Map<string, TaskNode> }> {
  requireScope(p, "read")
  const modes = resolveModes(p, query.mode)
  const settings = await loadSettings(p.userId)
  const today = nowInTz(settings.timezone).date
  if (modes.length === 0) return { today, tasks: [], hierarchy: new Map() }

  const conds: Cond[] = [["user_id", "eq", p.userId], ["mode", "in", modes]]
  if (query.goal_id) conds.push(["goal_id", "eq", query.goal_id])
  let rows = (await db.find("tasks", conds, { order: "created_at.desc", limit: Math.min(query.limit ?? 1000, 2000) })) as TaskRow[]
  // 階層は、絞り込む前の全件から作る（完了済みの親が外れても、子の「親の経路」を失わないように）。見える範囲(modes)の中だけ。
  const hierarchy = buildHierarchy(rows, today)

  const status = query.status ?? "active"
  if (status === "active") rows = rows.filter(t => !isTaskDone(t, today))
  else if (status === "done") rows = rows.filter(t => isTaskDone(t, today))
  if (query.q) {
    const needle = query.q.toLowerCase()
    rows = rows.filter(t => (t.text || "").toLowerCase().includes(needle))
  }
  if (query.due_from) rows = rows.filter(t => t.due_date && t.due_date >= query.due_from!)
  if (query.due_to) rows = rows.filter(t => t.due_date && t.due_date <= query.due_to!)
  return { today, tasks: rows, hierarchy }
}

export interface UnplacedItem { task: TaskRow; node: TaskNode; planned_minutes: number; done_minutes: number; unplaced_minutes: number | null }

/**
 * 「未配置のタスク」: まだ予定（タイムボックス）に入っていない、これから作業する単位。
 * 画面の「未配置」と同じ定義 = 子を持たない葉 / 未完了 / 繰り返しでない / 未実施の予定が無い。
 * 親（子を持つタスク）は、葉をまとめる見出しなので含めず、各葉に親の経路(node.path)を付ける。
 * 並びは、期限が早い順 → 優先度が高い順 → 古い順。
 */
export async function listUnplacedTasks(p: Principal, query: { mode?: string | null; limit?: number } = {}): Promise<{ today: string; items: UnplacedItem[] }> {
  requireScope(p, "read")
  const { today, tasks, hierarchy } = await listTasks(p, { mode: query.mode, status: "all", limit: 2000 })
  const modes = resolveModes(p, query.mode)
  let boxes: TimeboxDb[] = []
  if (modes.length > 0) {
    try {
      boxes = (await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["mode", "in", modes], ["status", "in", ["planned", "done"]]], { limit: 2000 })) as TimeboxDb[]
    } catch (e) {
      if (!isMissingTable(e)) throw e
    }
  }
  const plannedBy = new Map<string, number>(), doneBy = new Map<string, number>(), hasPlanned = new Set<string>()
  for (const b of boxes) {
    if (b.status === "planned") { hasPlanned.add(b.task_id); plannedBy.set(b.task_id, (plannedBy.get(b.task_id) ?? 0) + b.planned_minutes) }
    else doneBy.set(b.task_id, (doneBy.get(b.task_id) ?? 0) + (b.actual_minutes ?? b.planned_minutes))
  }
  const prio = { high: 0, mid: 1, low: 2 } as Record<string, number>
  const items = tasks
    .filter(t => !t.is_recurring && !isTaskDone(t, today) && hierarchy.get(t.id)?.is_leaf && !hasPlanned.has(t.id))
    .sort((a, b) => (a.due_date ?? "9999") < (b.due_date ?? "9999") ? -1 : (a.due_date ?? "9999") > (b.due_date ?? "9999") ? 1
      : (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1) || (a.created_at < b.created_at ? -1 : 1))
    .slice(0, Math.min(query.limit ?? 200, 500))
    .map(t => {
      const est = t.estimate_minutes ?? null, planned = plannedBy.get(t.id) ?? 0, done = doneBy.get(t.id) ?? 0
      return { task: t, node: hierarchy.get(t.id)!, planned_minutes: planned, done_minutes: done, unplaced_minutes: est === null ? null : Math.max(0, est - planned - done) }
    })
  return { today, items }
}

export async function getTaskDetail(p: Principal, id: string) {
  requireScope(p, "read")
  const task = await getTaskRow(p, id)
  const children = await collectDescendants(p.userId, id)
  let timeboxes: TimeboxDb[] = []
  try {
    timeboxes = (await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["task_id", "eq", id], ["status", "neq", "released"]], { order: "date.asc", limit: 200 })) as TimeboxDb[]
  } catch (e) {
    if (!isMissingTable(e)) throw e
  }
  const settings = await loadSettings(p.userId)
  return { task, children, timeboxes, today: nowInTz(settings.timezone).date }
}

// ---------- 追加 ----------

export interface AddTaskInput {
  text?: unknown
  mode?: unknown
  priority?: unknown
  start_date?: unknown
  due_date?: unknown
  estimate_minutes?: unknown
  is_recurring?: unknown
  recurring_days?: unknown
  parent_id?: unknown
  goal_id?: unknown
  memo?: unknown
}

function checkDateOrder(start: string | null | undefined, due: string | null | undefined) {
  if (start && due && start > due) throw badRequest("開始日は期限日より前の日付にしてください")
}

export async function addTask(p: Principal, input: AddTaskInput): Promise<TaskRow> {
  requireScope(p, "task_add")
  const text = cleanText(input.text, "タスク名")
  const priority = optPriority(input.priority) ?? "mid"
  const start = optYmd(input.start_date, "開始日")
  const due = optYmd(input.due_date, "期限日")
  checkDateOrder(start, due)
  const estimate = optEstimate(input.estimate_minutes)
  const memo = optString(input.memo, "メモ")
  const isRecurring = optBool(input.is_recurring, "繰り返し") ?? false

  let mode: Mode
  let parent: TaskRow | null = null
  if (typeof input.parent_id === "string" && input.parent_id) {
    parent = await getTaskRow(p, input.parent_id)
    if (input.mode !== undefined && input.mode !== parent.mode) throw badRequest("サブタスクは親タスクと同じカテゴリになります")
    if ((await taskDepth(p.userId, parent)) >= 2) throw badRequest("サブタスクは3階層までです")
    if (isRecurring) throw badRequest("サブタスクは繰り返しにできません")
    mode = parent.mode as Mode
  } else {
    const requested = input.mode === undefined ? (p.kind === "ui" ? "work" : p.modes[0]) : input.mode
    if (requested !== "work" && requested !== "private") throw badRequest("mode は work か private を指定してください")
    mode = requested
  }
  requireMode(p, mode)

  let goalId: string | null | undefined
  if (input.goal_id !== undefined && input.goal_id !== null && input.goal_id !== "") {
    const goal = await getGoalRow(p, String(input.goal_id))
    if (goal.mode !== mode) throw badRequest("目標とタスクのカテゴリが異なります")
    goalId = goal.id
  }

  const row: Record<string, unknown> = {
    id: newId(),
    user_id: p.userId,
    mode,
    text,
    priority,
    due_date: due ?? null,
    parent_id: parent?.id ?? null,
    done: false,
    is_recurring: isRecurring,
    recurring_days: isRecurring ? normDays(input.recurring_days) : "",
  }
  // 新しい列・任意の列は、値があるときだけ送る（未マイグレーション環境でも基本の追加は壊れない）
  if (start) row.start_date = start
  if (memo) row.memo = memo
  if (estimate !== undefined && estimate !== null) row.estimate_minutes = estimate
  if (goalId) row.goal_id = goalId

  let created: TaskRow
  try {
    created = (await db.insert("tasks", row)) as TaskRow
  } catch (e) {
    if (isMissingColumn(e)) throw migrationRequired()
    throw e
  }
  await recordEvent(p, { type: "task_created", mode, task_id: created.id, payload: { text } })
  return created
}

// ---------- 編集 ----------

export interface UpdateTaskInput {
  text?: unknown
  priority?: unknown
  start_date?: unknown
  due_date?: unknown
  memo?: unknown
  estimate_minutes?: unknown
  is_recurring?: unknown
  recurring_days?: unknown
  goal_id?: unknown
}

export async function updateTask(p: Principal, id: string, patch: UpdateTaskInput): Promise<TaskRow> {
  requireScope(p, "task_edit")
  const t = await getTaskRow(p, id)
  const updates: Record<string, unknown> = {}

  if (patch.text !== undefined) updates.text = cleanText(patch.text, "タスク名")
  const priority = optPriority(patch.priority)
  if (priority) updates.priority = priority
  const start = optYmd(patch.start_date, "開始日")
  const due = optYmd(patch.due_date, "期限日")
  if (start !== undefined) updates.start_date = start
  if (due !== undefined) updates.due_date = due
  checkDateOrder(start !== undefined ? start : t.start_date, due !== undefined ? due : t.due_date)
  const memo = optString(patch.memo, "メモ")
  if (memo !== undefined) updates.memo = memo
  const estimate = optEstimate(patch.estimate_minutes)
  if (estimate !== undefined) updates.estimate_minutes = estimate

  const rec = optBool(patch.is_recurring, "繰り返し")
  if (rec !== undefined) {
    if (rec && t.parent_id) throw badRequest("サブタスクは繰り返しにできません")
    updates.is_recurring = rec
    updates.recurring_days = rec ? normDays(patch.recurring_days ?? t.recurring_days) : ""
  } else if (patch.recurring_days !== undefined) {
    updates.recurring_days = t.is_recurring ? normDays(patch.recurring_days) : ""
  }

  if (patch.goal_id !== undefined) {
    if (patch.goal_id === null || patch.goal_id === "") updates.goal_id = null
    else {
      const goal = await getGoalRow(p, String(patch.goal_id))
      if (goal.mode !== t.mode) throw badRequest("目標とタスクのカテゴリが異なります")
      updates.goal_id = goal.id
    }
  }

  if (Object.keys(updates).length === 0) throw badRequest("変更内容が指定されていません")
  try {
    return (await db.update("tasks", id, updates)) as TaskRow
  } catch (e) {
    if (isMissingColumn(e)) throw migrationRequired()
    throw e
  }
}

// ---------- カテゴリ変更 ----------

/** 影響が大きいとみなす件数（AI からの変更はこの件数を超えたら明示的な承認が必要） */
export const BULK_CONFIRM_THRESHOLD = 5

export async function changeTaskCategory(p: Principal, id: string, mode: unknown, opts: { confirm?: boolean } = {}) {
  requireScope(p, "task_edit")
  if (mode !== "work" && mode !== "private") throw badRequest("mode は work か private を指定してください")
  requireMode(p, mode) // 移動先
  const t = await getTaskRow(p, id) // 移動元（権限が無ければ 404）
  if (t.mode === mode) return { changed: false as const, task: t, affected: 0 }
  if (t.parent_id) throw badRequest("サブタスクのカテゴリは単独では変えられません。親タスクのカテゴリを変更してください")

  const descendants = await collectDescendants(p.userId, id)
  const ids = [id, ...descendants.map(d => d.id)]

  if (p.kind === "ai" && !opts.confirm && ids.length > BULK_CONFIRM_THRESHOLD) {
    return { needsConfirmation: true as const, message: `親タスクとサブタスクあわせて${ids.length}件のカテゴリが変わります。ユーザーの承認後に confirm:true で再実行してください。`, affected: ids.length }
  }

  await db.updateWhere("tasks", [["user_id", "eq", p.userId], ["id", "in", ids]], { mode })

  // 別カテゴリの目標とのひも付けは外す（カテゴリをまたぐ関連を作らない）
  const linked = [t, ...descendants].filter(x => !!x.goal_id)
  if (linked.length > 0) {
    const goalIds = Array.from(new Set(linked.map(x => x.goal_id as string)))
    const goals = (await db.find("goals", [["user_id", "eq", p.userId], ["id", "in", goalIds]], { limit: 200 })) as { id: string; mode: string }[]
    const goalMode = new Map(goals.map(g => [g.id, g.mode]))
    const detach = linked.filter(x => goalMode.get(x.goal_id as string) !== mode).map(x => x.id)
    if (detach.length > 0) await db.updateWhere("tasks", [["user_id", "eq", p.userId], ["id", "in", detach]], { goal_id: null })
  }

  // タイムボックスもカテゴリを揃える（タスクとタイムボックスのカテゴリは常に一致）
  try {
    await db.updateWhere("myflow_timeboxes", [["user_id", "eq", p.userId], ["task_id", "in", ids]], { mode, updated_at: new Date().toISOString() })
  } catch (e) {
    if (!isMissingTable(e)) throw e
  }

  await recordEvent(p, { type: "task_category_changed", mode, task_id: id, payload: { from: t.mode, to: mode, count: ids.length } })
  const task = await getTaskRow(p, id)
  return { changed: true as const, task, affected: ids.length }
}

// ---------- 完了 ----------

export async function completeTask(p: Principal, id: string, done = true) {
  requireScope(p, "complete")
  const t = await getTaskRow(p, id)
  const settings = await loadSettings(p.userId)
  const now = nowInTz(settings.timezone)

  const updates = t.is_recurring
    ? { recurring_done_date: done ? now.date : null }
    : { done }
  const task = (await db.update("tasks", id, updates)) as TaskRow

  // 複数テーブルにまたがる更新は1つのトランザクションにできないため、途中で失敗したら、
  // ここまでの更新を逆順に元へ戻す（タスクだけ完了／予定だけ実施済み、という食い違いを残さない）。
  const undo: (() => Promise<unknown>)[] = [
    () => db.update("tasks", id, t.is_recurring ? { recurring_done_date: t.recurring_done_date ?? null } : { done: !!t.done }),
  ]
  let doneBox: TimeboxDb | null = null
  let released = 0
  let restored = 0
  try {
  if (done) {
    try {
      const planned = (await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["task_id", "eq", id], ["status", "eq", "planned"]], { limit: 200 })) as TimeboxDb[]
      const todays = planned.filter(b => b.date === now.date).sort((a, b) => a.window_start - b.window_start)[0]
      if (todays) {
        // タスクを完了した事実と「予定の時間帯を守れたか」は別々に記録する
        const kept = now.minutes >= todays.window_start && now.minutes <= todays.window_end
        doneBox = (await db.update("myflow_timeboxes", todays.id, {
          status: "done", completed_at: new Date().toISOString(), actual_minutes: todays.planned_minutes,
          kept_window: kept, updated_at: new Date().toISOString(),
        })) as TimeboxDb
        undo.push(() => db.update("myflow_timeboxes", todays.id, { status: "planned", completed_at: null, actual_minutes: null, kept_window: null, updated_at: new Date().toISOString() }))
      }
      if (!t.is_recurring) {
        // 完了したタスクの残りの予定は不要になる（履歴として残し、計画からは外す）
        const rest = planned.filter(b => b.id !== todays?.id)
        if (rest.length > 0) {
          const restIds = rest.map(b => b.id)
          await db.updateWhere("myflow_timeboxes", [["user_id", "eq", p.userId], ["id", "in", restIds]], { status: "released", updated_at: new Date().toISOString() })
          undo.push(() => db.updateWhere("myflow_timeboxes", [["user_id", "eq", p.userId], ["id", "in", restIds]], { status: "planned", updated_at: new Date().toISOString() }))
          released = rest.length
        }
      }
    } catch (e) {
      if (!isMissingTable(e)) throw e
    }
  } else if (!t.is_recurring) {
    // 未完了に戻す: 完了で解放した「今日以降」の予定を元の予定に戻す（押し間違いで先の予定が消えないように）。
    // 過去の日付の予定と、実施済みの記録は戻さない。
    try {
      const back = (await db.updateWhere("myflow_timeboxes", [
        ["user_id", "eq", p.userId], ["task_id", "eq", id], ["status", "eq", "released"], ["date", "gte", now.date],
      ], { status: "planned", updated_at: new Date().toISOString() })) as unknown[]
      restored = back.length
    } catch (e) {
      if (!isMissingTable(e)) throw e
    }
  }
  } catch (e) {
    for (const u of undo.reverse()) {
      try { await u() } catch (ue) { console.error("[completeTask] 元に戻せませんでした", ue instanceof Error ? ue.message.slice(0, 200) : ue) }
    }
    throw e
  }

  await recordEvent(p, {
    type: done ? "task_completed" : "task_reopened", mode: t.mode, task_id: id, timebox_id: doneBox?.id ?? null,
    payload: done ? { kept_window: doneBox?.kept_window ?? null, had_timebox: !!doneBox, recurring: !!t.is_recurring } : { restored_timeboxes: restored },
  })
  return { task, timebox: doneBox, releasedTimeboxes: released, restoredTimeboxes: restored, today: now.date }
}

// ---------- 削除 ----------

export async function deleteTask(p: Principal, id: string, opts: { confirm?: boolean } = {}) {
  requireScope(p, "delete")
  const t = await getTaskRow(p, id)
  const descendants = await collectDescendants(p.userId, id)
  const ids = [id, ...descendants.map(d => d.id)]

  let boxCount = 0
  try {
    const boxes = await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["task_id", "in", ids]], { limit: 1000 })
    boxCount = boxes.length
  } catch (e) {
    if (!isMissingTable(e)) throw e
  }

  if (!opts.confirm) {
    return {
      needsConfirmation: true as const,
      message: "このタスクを削除します（サブタスクと予定も一緒に削除されます）。ユーザーの承認後に confirm:true で再実行してください。",
      target: { id: t.id, text: t.text, mode: t.mode },
      subtasks: descendants.length,
      timeboxes: boxCount,
    }
  }

  if (boxCount > 0) await db.deleteWhere("myflow_timeboxes", [["user_id", "eq", p.userId], ["task_id", "in", ids]])
  await db.deleteWhere("tasks", [["user_id", "eq", p.userId], ["id", "in", ids]])
  await recordEvent(p, { type: "task_deleted", mode: t.mode, task_id: id, payload: { text: t.text, subtasks: descendants.length, timeboxes: boxCount } })
  return { deleted: true as const, id, subtasks: descendants.length, timeboxes: boxCount }
}
