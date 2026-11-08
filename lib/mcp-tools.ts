// MCP のツール定義。トークンの権限(Principal)ごとに、使えるツールだけを登録する。
// 認可はここだけに頼らず、必ずサービス層(lib/services/*)でも検査される（二重の防御）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { db } from "./db"
import { recordEvent } from "./events"
import { describeWarning } from "./planning"
import { ServiceError, type Principal, type Scope } from "./principal"
import { presetForWindow, windowLabel, type Settings } from "./settings"
import { completionHistory, postponements, summary } from "./services/analytics"
import { getGoalProgress, linkTaskToGoal, listGoals } from "./services/goals"
import { getSchedule } from "./services/schedule"
import { loadSettings } from "./services/settings"
import { createTimebox, listTimeboxes, splitTimebox, unplaceTask, updateTimebox } from "./services/timeboxes"
import { addTask, changeTaskCategory, completeTask, deleteTask, getTaskDetail, listTasks, listUnplacedTasks, shapeTask, updateTask } from "./services/tasks"
import { buildHierarchy, type TaskNode } from "./task-utils"
import { hhmmToMinutes, minutesToHhmm, nowInTz } from "./time"
import type { TaskRow, TimeboxDb } from "./types"

const modeEnum = z.enum(["work", "private"])
const ymd = z.string().describe("YYYY-MM-DD")
const slotEnum = z.enum(["morning", "noon", "night"]).describe("時間帯: morning=朝 / noon=昼 / night=夜（時間は get_my_access で確認できる）")

function ok(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] }
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] }
}

function shapeBox(b: TimeboxDb & { task_text?: string | null }, settings: Settings, titles?: Map<string, string>) {
  return {
    id: b.id, task_id: b.task_id, task_text: b.task_text ?? titles?.get(b.task_id) ?? null, mode: b.mode, date: b.date,
    start: minutesToHhmm(b.window_start), end: minutesToHhmm(b.window_end),
    slot: presetForWindow(settings, b.window_start, b.window_end)?.key ?? null,
    minutes: b.planned_minutes, status: b.status, actual_minutes: b.actual_minutes, kept_window: b.kept_window,
  }
}

/** shapeTask に、親子の情報（親の経路・深さ・葉か・子と葉の進み具合）を足す */
function withNode<T extends object>(shaped: T, n: TaskNode | undefined) {
  if (!n) return shaped
  return {
    ...shaped,
    path: n.path, depth: n.depth, root_id: n.root_id, is_leaf: n.is_leaf,
    children: { total: n.children_total, done: n.children_done },
    leaves: { total: n.leaves_total, done: n.leaves_done },
  }
}

/** 予定に付けるタスク名をまとめて引く。対象の予定は権限確認済み（サービス層が 404 にする）なので、そのタスクの名前だけを返す。 */
async function titlesFor(p: Principal, ids: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids))
  if (uniq.length === 0) return new Map()
  const rows = (await db.find("tasks", [["user_id", "eq", p.userId], ["id", "in", uniq]], { limit: 2000 })) as TaskRow[]
  return new Map(rows.map(t => [t.id, t.text]))
}

/** slot（朝/昼/夜）または start_time+end_time から時間帯(分)を決める。どちらも無ければ undefined。 */
function resolveWindow(a: { slot?: string; start_time?: string; end_time?: string }, settings: Settings): { start: number; end: number } | undefined {
  if (a.slot) {
    const p = settings.presets.find(x => x.key === a.slot)
    if (!p) throw new ServiceError(400, "bad_request", "slot は morning / noon / night のいずれかです")
    return { start: p.start, end: p.end }
  }
  if (a.start_time || a.end_time) {
    const s = hhmmToMinutes(a.start_time), e = hhmmToMinutes(a.end_time)
    if (s === null || e === null) throw new ServiceError(400, "bad_request", "start_time / end_time は HH:MM 形式で、両方指定してください")
    return { start: s, end: e }
  }
  return undefined
}

function userMessage(e: unknown): string {
  if (e instanceof ServiceError) return e.message
  console.error("[mcp]", e instanceof Error ? e.message.slice(0, 300) : e)
  return "サーバーでエラーが発生しました。しばらくしてからもう一度お試しください。"
}

export const TOOL_NAMES = [
  "get_my_access", "list_tasks", "get_unplaced_tasks", "get_task", "list_goals", "get_goal_progress", "list_timeboxes", "get_schedule",
  "get_completion_history", "get_postponements", "get_summary",
  "add_task", "update_task", "complete_task", "change_task_category", "link_task_to_goal",
  "create_timebox", "move_timebox", "resize_timebox", "split_timebox", "unplace_task", "delete_task",
] as const

export function registerTools(server: McpServer, p: Principal) {
  /** scope が無いトークンには、そのツール自体を見せない。呼び出しごとに操作履歴(ai_call)を残す。 */
  function tool<S extends z.ZodRawShape>(
    name: (typeof TOOL_NAMES)[number], scope: Scope | null,
    def: { title: string; description: string; inputSchema: S; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } },
    run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  ) {
    if (scope && !p.scopes.includes(scope)) return
    server.registerTool(name, def, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      const a = args as Record<string, unknown>
      const base = {
        mode: typeof a.mode === "string" ? a.mode : null,
        task_id: typeof a.task_id === "string" ? a.task_id : typeof a.id === "string" ? a.id : null,
      }
      try {
        const out = await run(args)
        await recordEvent(p, { type: "ai_call", ...base, payload: { tool: name, ok: true, fields: Object.keys(a).filter(k => a[k] !== undefined) } })
        return ok(out)
      } catch (e) {
        await recordEvent(p, { type: "ai_call", ...base, payload: { tool: name, ok: false, error: e instanceof ServiceError ? e.code : "server_error" } })
        return fail(userMessage(e))
      }
    }) as never)
  }

  const read = { readOnlyHint: true }
  const modify = { readOnlyHint: false, destructiveHint: true }   // 既存のデータを書き換える（ChatGPT/Claude が実行前に確認する）
  const create = { readOnlyHint: false, destructiveHint: false }  // 新しく追加するだけ

  // ================= 自分の権限 =================
  tool("get_my_access", null, {
    title: "このトークンの権限と今日の日付",
    description: "アクセスできるカテゴリ(仕事/プライベート)・使える操作・今日の日付・時間帯(朝/昼/夜)を返す。日付を扱う前に呼ぶと確実。",
    inputSchema: {}, annotations: read,
  }, async () => {
    const settings = await loadSettings(p.userId)
    const now = nowInTz(settings.timezone)
    return {
      today: now.date, timezone: settings.timezone, now_time: minutesToHhmm(now.minutes),
      accessible_modes: p.modes, allowed_operations: p.scopes,
      time_slots: settings.presets.map(x => ({ key: x.key, label: x.label, start: minutesToHhmm(x.start), end: minutesToHhmm(x.end) })),
      note: p.actor === "ai:legacy-key" ? "旧方式の共有キーです。権限はプライベートのみ・削除不可に制限されています。管理画面で新しいトークンを発行してください。" : undefined,
    }
  })

  // ================= 読み取り =================
  tool("list_tasks", "read", {
    title: "タスク一覧", description: "タスクを取得する。status=active(未完了,既定)/done/all。mode を省略すると許可されたカテゴリすべて。",
    inputSchema: { mode: modeEnum.optional(), status: z.enum(["active", "done", "all"]).optional(), q: z.string().optional().describe("タスク名の部分一致"), due_from: ymd.optional(), due_to: ymd.optional(), goal_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: read,
  }, async a => {
    const r = await listTasks(p, a)
    return { today: r.today, count: r.tasks.length, tasks: r.tasks.map(t => withNode(shapeTask(t, r.today), r.hierarchy.get(t.id))) }
  })

  tool("get_unplaced_tasks", "read", {
    title: "未配置のタスク", description: "まだ予定(タイムボックス)に入っていない、これから作業するタスクの一覧。子・孫タスクも含み、親は見出しとして path に入る(親自体は一覧に出さない)。期限が早い順。unplaced_minutes は見積りのうち予定に入っていない分。",
    inputSchema: { mode: modeEnum.optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: read,
  }, async a => {
    const r = await listUnplacedTasks(p, a)
    return {
      today: r.today, count: r.items.length,
      tasks: r.items.map(i => ({ ...withNode(shapeTask(i.task, r.today), i.node), planned_minutes: i.planned_minutes, done_minutes: i.done_minutes, unplaced_minutes: i.unplaced_minutes })),
    }
  })

  tool("get_task", "read", {
    title: "タスクの詳細", description: "1件のタスクと、そのサブタスク・予定(タイムボックス)・見積りに対する配置状況を返す。",
    inputSchema: { id: z.string() }, annotations: read,
  }, async a => {
    const d = await getTaskDetail(p, a.id)
    // 親の経路は、見える範囲(許可されたカテゴリ)の全タスクから作る
    const hier = buildHierarchy((await listTasks(p, { mode: d.task.mode, status: "all", limit: 2000 })).tasks, d.today)
    const settings = await loadSettings(p.userId)
    const planned = d.timeboxes.filter(b => b.status === "planned").reduce((s, b) => s + b.planned_minutes, 0)
    const done = d.timeboxes.filter(b => b.status === "done").reduce((s, b) => s + (b.actual_minutes ?? b.planned_minutes), 0)
    const est = d.task.estimate_minutes ?? null
    return {
      task: withNode(shapeTask(d.task, d.today), hier.get(d.task.id)),
      subtasks: d.children.map((c: TaskRow) => withNode(shapeTask(c, d.today), hier.get(c.id))),
      timeboxes: d.timeboxes.map(b => shapeBox(b, settings)),
      plan: { estimate_minutes: est, planned_minutes: planned, done_minutes: done, unplaced_minutes: est === null ? null : Math.max(0, est - planned - done) },
    }
  })

  tool("list_goals", "read", {
    title: "目標一覧", description: "目標と進捗(%)、ひも付いたタスクの完了数を返す。",
    inputSchema: { mode: modeEnum.optional() }, annotations: read,
  }, async a => ({ goals: (await listGoals(p, a.mode)).map(g => ({ id: g.id, text: g.text, mode: g.mode, due_date: g.due_date, progress_percent: g.pct, linked_tasks_total: g.linked_total, linked_tasks_done: g.linked_done })) }))

  tool("get_goal_progress", "read", {
    title: "目標の進捗", description: "目標の進捗(%)と、ひも付いたタスクの内訳を返す。", inputSchema: { id: z.string() }, annotations: read,
  }, async a => getGoalProgress(p, a.id))

  tool("list_timeboxes", "read", {
    title: "予定(タイムボックス)一覧", description: "タスクの予定を取得する。期間・タスクで絞れる。",
    inputSchema: { mode: modeEnum.optional(), from: ymd.optional(), to: ymd.optional(), task_id: z.string().optional(), status: z.enum(["planned", "done", "active"]).optional() },
    annotations: read,
  }, async a => {
    const settings = await loadSettings(p.userId)
    const rows = await listTimeboxes(p, a)
    const titles = await titlesFor(p, rows.map(b => b.task_id))
    return { count: rows.length, timeboxes: rows.map(b => shapeBox(b, settings, titles)) }
  })

  tool("get_schedule", "read", {
    title: "期間のスケジュール", description: "指定期間(最大62日)の固定予定・予定・余白の警告をまとめて返す。『今週の予定を確認して無理のない計画を提案して』に使う。",
    inputSchema: { mode: modeEnum.optional(), from: ymd, to: ymd }, annotations: read,
  }, async a => {
    const r = await getSchedule(p, { mode: a.mode, from: a.from, to: a.to })
    const label = (s: number, e: number) => windowLabel(r.settings, s, e)
    return {
      today: r.today, from: r.from, to: r.to,
      fixed_events: r.fixedEvents.map(f => ({ date: f.date, mode: f.mode, title: f.title, start: minutesToHhmm(f.start_min), end: minutesToHhmm(f.end_min), allows_tasks: !!f.allows_tasks })),
      timeboxes: r.timeboxes.map(b => shapeBox(b, r.settings)),
      warnings: Object.entries(r.analysis).flatMap(([m, days]) => (days ?? []).flatMap(d => d.warnings.map(w => ({ mode: m, date: d.date, message: describeWarning(w, label) })))),
      free_minutes_by_day: Object.fromEntries(Object.entries(r.analysis).map(([m, days]) => [m, (days ?? []).map(d => ({ date: d.date, free_minutes: d.freeMinutes, planned_minutes: d.plannedMinutes }))])),
    }
  })

  tool("get_completion_history", "read", {
    title: "完了履歴", description: "指定期間に完了したタスクの履歴。予定の時間帯の中で完了できたか(kept_window)も含む。履歴は新機能の開始以降のみ。",
    inputSchema: { mode: modeEnum.optional(), from: ymd, to: ymd }, annotations: read,
  }, async a => completionHistory(p, a))

  tool("get_postponements", "read", {
    title: "先送りの状況", description: "指定期間に予定を後ろの日へ動かした回数を、タスクごとに多い順で返す。",
    inputSchema: { mode: modeEnum.optional(), from: ymd, to: ymd }, annotations: read,
  }, async a => postponements(p, a))

  tool("get_summary", "read", {
    title: "週次・月次の集計", description: "期限のあるタスクの完了率・完了数・先送りが多いタスク・予定の実施状況を集計する。period=week(既定)/month。",
    inputSchema: { mode: modeEnum.optional(), period: z.enum(["week", "month"]).optional(), date: ymd.optional().describe("集計の基準日。省略すると今日") }, annotations: read,
  }, async a => summary(p, a))

  // ================= 書き込み =================
  tool("add_task", "task_add", {
    title: "タスクを追加", description: "新しいタスクを追加する。mode を省略すると許可されたカテゴリの先頭。サブタスクは parent_id を指定する。",
    inputSchema: {
      text: z.string(), mode: modeEnum.optional(), priority: z.enum(["high", "mid", "low"]).optional(), start_date: ymd.optional(), due_date: ymd.optional(),
      estimate_minutes: z.number().int().min(1).max(1440).optional(), is_recurring: z.boolean().optional(), recurring_days: z.string().optional().describe('空=毎日 / "1,3,5"=月水金 (0=日..6=土)'),
      parent_id: z.string().optional(), goal_id: z.string().optional(), memo: z.string().optional(),
    },
    annotations: create,
  }, async a => {
    const t = await addTask(p, a)
    return { ok: true, task: shapeTask(t, nowInTz((await loadSettings(p.userId)).timezone).date) }
  })

  tool("update_task", "task_edit", {
    title: "タスクを編集", description: "タスクの内容を変更する（名前・優先度・日付・見積り・メモ・繰り返し）。完了は complete_task、カテゴリは change_task_category を使う。",
    inputSchema: {
      id: z.string(), text: z.string().optional(), priority: z.enum(["high", "mid", "low"]).optional(), start_date: z.string().nullable().optional().describe("YYYY-MM-DD / null でクリア"),
      due_date: z.string().nullable().optional().describe("YYYY-MM-DD / null でクリア"), estimate_minutes: z.number().int().min(1).max(1440).nullable().optional(),
      memo: z.string().optional(), is_recurring: z.boolean().optional(), recurring_days: z.string().optional(),
    },
    annotations: modify,
  }, async ({ id, ...patch }) => {
    const t = await updateTask(p, id, patch)
    return { ok: true, task: shapeTask(t, nowInTz((await loadSettings(p.userId)).timezone).date) }
  })

  tool("complete_task", "complete", {
    title: "タスクを完了", description: "タスクを完了にする（done=false で未完了に戻す）。今日の予定が実施済みになり、残りの予定は計画から外れる。",
    inputSchema: { id: z.string(), done: z.boolean().optional() }, annotations: create,
  }, async a => {
    const r = await completeTask(p, a.id, a.done !== false)
    return { ok: true, task: shapeTask(r.task, r.today), timebox_marked_done: !!r.timebox, kept_planned_window: r.timebox?.kept_window ?? null, released_future_timeboxes: r.releasedTimeboxes }
  })

  tool("change_task_category", "task_edit", {
    title: "タスクの所属カテゴリを変更", description: "仕事⇄プライベートを移す。サブタスクと予定も一緒に移る。移動先のカテゴリへのアクセス権も必要。多数に影響する場合は confirm:true が必要。",
    inputSchema: { id: z.string(), mode: modeEnum, confirm: z.boolean().optional() }, annotations: modify,
  }, async a => {
    const r = await changeTaskCategory(p, a.id, a.mode, { confirm: a.confirm })
    if (!("task" in r) || !r.task) return r
    return { ...r, task: shapeTask(r.task, nowInTz((await loadSettings(p.userId)).timezone).date) }
  })

  tool("link_task_to_goal", "task_edit", {
    title: "タスクを目標にひも付ける", description: "同じカテゴリの目標にひも付ける。goal_id=null で解除。",
    inputSchema: { task_id: z.string(), goal_id: z.string().nullable() }, annotations: modify,
  }, async a => {
    const t = await linkTaskToGoal(p, a.task_id, a.goal_id)
    return { ok: true, task_id: t.id, goal_id: t.goal_id ?? null }
  })

  tool("create_timebox", "schedule", {
    title: "予定(タイムボックス)を作成", description: "タスクを『この日の、この時間帯のどこかで、○分』として予定に入れる。時間帯は slot(朝/昼/夜) か start_time+end_time(HH:MM)で指定。開始時刻の確定は不要。1つのタスクに複数作れる。",
    inputSchema: { task_id: z.string(), date: ymd, minutes: z.number().int().min(1).max(1440), slot: slotEnum.optional(), start_time: z.string().optional().describe("HH:MM"), end_time: z.string().optional().describe("HH:MM") },
    annotations: create,
  }, async a => {
    const settings = await loadSettings(p.userId)
    const w = resolveWindow(a, settings)
    if (!w) throw new ServiceError(400, "bad_request", "slot か start_time+end_time で時間帯を指定してください")
    const r = await createTimebox(p, { task_id: a.task_id, date: a.date, window_start: w.start, window_end: w.end, planned_minutes: a.minutes })
    const label = (s: number, e: number) => windowLabel(settings, s, e)
    return { ok: true, timebox: shapeBox(r.timebox, settings, await titlesFor(p, [r.timebox.task_id])), warnings: r.analysis.warnings.map(x => describeWarning(x, label)) }
  })

  tool("move_timebox", "schedule", {
    title: "予定を移動", description: "予定を別の日・時間帯へ動かす。後ろの日付への移動は『先送り』として記録される。",
    inputSchema: { id: z.string(), date: ymd.optional(), slot: slotEnum.optional(), start_time: z.string().optional(), end_time: z.string().optional() }, annotations: modify,
  }, async a => {
    const settings = await loadSettings(p.userId)
    const w = resolveWindow(a, settings)
    const patch: Record<string, unknown> = {}
    if (a.date) patch.date = a.date
    if (w) { patch.window_start = w.start; patch.window_end = w.end }
    const r = await updateTimebox(p, a.id, patch)
    const label = (s: number, e: number) => windowLabel(settings, s, e)
    return { ok: true, timebox: shapeBox(r.timebox, settings, await titlesFor(p, [r.timebox.task_id])), warnings: r.analysis.warnings.map(x => describeWarning(x, label)) }
  })

  tool("resize_timebox", "schedule", {
    title: "予定の作業時間を変更", description: "予定の作業時間(分)を変える。時間帯の長さを超えることはできない。",
    inputSchema: { id: z.string(), minutes: z.number().int().min(1).max(1440) }, annotations: modify,
  }, async a => {
    const settings = await loadSettings(p.userId)
    const r = await updateTimebox(p, a.id, { planned_minutes: a.minutes })
    const label = (s: number, e: number) => windowLabel(settings, s, e)
    return { ok: true, timebox: shapeBox(r.timebox, settings, await titlesFor(p, [r.timebox.task_id])), warnings: r.analysis.warnings.map(x => describeWarning(x, label)) }
  })

  tool("split_timebox", "schedule", {
    title: "予定を分割", description: "予定の一部(分)を別の日・時間帯へ分ける。例: 120分を 30分/60分/30分 に。",
    inputSchema: { id: z.string(), minutes: z.number().int().min(1), date: ymd.optional(), slot: slotEnum.optional() }, annotations: modify,
  }, async a => {
    const settings = await loadSettings(p.userId)
    const w = resolveWindow(a, settings)
    const r = await splitTimebox(p, a.id, { minutes: a.minutes, date: a.date, ...(w ? { window_start: w.start, window_end: w.end } : {}) })
    const titles = await titlesFor(p, [r.original.task_id, r.created.task_id])
    return { ok: true, original: shapeBox(r.original, settings, titles), created: shapeBox(r.created, settings, titles) }
  })

  tool("unplace_task", "schedule", {
    title: "予定を外して未配置に戻す", description: "タスクの予定(未実施分)をすべて外す。タスク自体は残る。", inputSchema: { task_id: z.string() }, annotations: modify,
  }, async a => ({ ok: true, ...(await unplaceTask(p, a.task_id)) }))

  tool("delete_task", "delete", {
    title: "タスクを削除", description: "タスクを削除する（サブタスクと予定も一緒に消える）。最初は confirm なしで呼び、返ってきた内容をユーザーに見せて、明示的に承認されたら confirm:true で再実行する。",
    inputSchema: { id: z.string(), confirm: z.boolean().optional() }, annotations: modify,
  }, async a => deleteTask(p, a.id, { confirm: a.confirm === true }))
}
