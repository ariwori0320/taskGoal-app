import { db, isMissingColumn } from "../db"
import { requireScope, resolveModes, type Principal } from "../principal"
import { nowInTz } from "../time"
import type { GoalRow, TaskRow } from "../types"
import { loadSettings } from "./settings"
import { getGoalRow } from "./rows"
import { isTaskDone, shapeTask, updateTask } from "./tasks"

async function linkedTasks(p: Principal, goalIds: string[]): Promise<TaskRow[]> {
  if (goalIds.length === 0) return []
  try {
    return (await db.find("tasks", [["user_id", "eq", p.userId], ["goal_id", "in", goalIds], ["mode", "in", p.modes]], { limit: 2000 })) as TaskRow[]
  } catch (e) {
    if (isMissingColumn(e)) return [] // goal_id 列がまだ無い（マイグレーション前）
    throw e
  }
}

export async function listGoals(p: Principal, mode?: string | null) {
  requireScope(p, "read")
  const modes = resolveModes(p, mode)
  if (modes.length === 0) return []
  const goals = (await db.find("goals", [["user_id", "eq", p.userId], ["mode", "in", modes]], { order: "created_at.desc", limit: 500 })) as GoalRow[]
  const settings = await loadSettings(p.userId)
  const today = nowInTz(settings.timezone).date
  const tasks = await linkedTasks(p, goals.map(g => g.id))
  return goals.map(g => {
    const mine = tasks.filter(t => t.goal_id === g.id)
    return { ...g, linked_total: mine.length, linked_done: mine.filter(t => isTaskDone(t, today)).length }
  })
}

export async function getGoalProgress(p: Principal, id: string) {
  requireScope(p, "read")
  const goal = await getGoalRow(p, id)
  const settings = await loadSettings(p.userId)
  const today = nowInTz(settings.timezone).date
  const tasks = await linkedTasks(p, [id])
  const done = tasks.filter(t => isTaskDone(t, today))
  return {
    goal: { id: goal.id, text: goal.text, mode: goal.mode, due_date: goal.due_date, progress_percent: goal.pct },
    linked_tasks: {
      total: tasks.length,
      done: done.length,
      rate: tasks.length === 0 ? null : Math.round((done.length / tasks.length) * 100),
      items: tasks.map(t => shapeTask(t, today)),
    },
  }
}

/** タスクを目標にひも付ける（goalId=null で解除）。同じカテゴリの目標にのみひも付けられる。 */
export async function linkTaskToGoal(p: Principal, taskId: string, goalId: string | null) {
  return updateTask(p, taskId, { goal_id: goalId })
}
