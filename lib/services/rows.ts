// 行の取得（認可チェック付き）。権限の無いカテゴリの行は「存在しない」として扱い、存在を漏らさない。

import { db } from "../db"
import { notFound, requireVisible, type Principal } from "../principal"
import type { GoalRow, TaskRow, TimeboxDb } from "../types"

export async function getTaskRow(p: Principal, id: string): Promise<TaskRow> {
  const rows = await db.find("tasks", [["user_id", "eq", p.userId], ["id", "eq", id]], { limit: 1 })
  const t = rows[0] as TaskRow | undefined
  if (!t) throw notFound("タスクが見つかりません")
  requireVisible(p, t.mode)
  return t
}

export async function getGoalRow(p: Principal, id: string): Promise<GoalRow> {
  const rows = await db.find("goals", [["user_id", "eq", p.userId], ["id", "eq", id]], { limit: 1 })
  const g = rows[0] as GoalRow | undefined
  if (!g) throw notFound("目標が見つかりません")
  requireVisible(p, g.mode)
  return g
}

export async function getTimeboxRow(p: Principal, id: string): Promise<TimeboxDb> {
  const rows = await db.find("myflow_timeboxes", [["user_id", "eq", p.userId], ["id", "eq", id]], { limit: 1 })
  const b = rows[0] as TimeboxDb | undefined
  if (!b) throw notFound("予定が見つかりません")
  requireVisible(p, b.mode)
  return b
}

/** root の子孫タスク（最大5階層まで）。root 自身は含まない。 */
export async function collectDescendants(userId: string, rootId: string): Promise<TaskRow[]> {
  const out: TaskRow[] = []
  let frontier = [rootId]
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const rows = (await db.find("tasks", [["user_id", "eq", userId], ["parent_id", "in", frontier]], { limit: 1000 })) as TaskRow[]
    out.push(...rows)
    frontier = rows.map(r => r.id)
  }
  return out
}

/** タスクの階層の深さ（ルート=0）。 */
export async function taskDepth(userId: string, task: TaskRow): Promise<number> {
  let depth = 0
  let cur: TaskRow | undefined = task
  while (cur?.parent_id && depth < 10) {
    const rows = (await db.find("tasks", [["user_id", "eq", userId], ["id", "eq", cur.parent_id]], { limit: 1 })) as TaskRow[]
    cur = rows[0]
    depth++
  }
  return depth
}
