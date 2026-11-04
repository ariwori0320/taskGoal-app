import { db } from "@/lib/db"
import { readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL } from "@/lib/principal"
import { getTaskRow } from "@/lib/services/rows"
import { changeTaskCategory, deleteTask, updateTask } from "@/lib/services/tasks"
import { optYmd } from "@/lib/validate"

// サービス層で検証する項目（text / priority / 日付 / メモ / 所要時間 / 繰り返し / 目標）
const SERVICE_FIELDS = ["text", "priority", "start_date", "due_date", "memo", "estimate_minutes", "is_recurring", "recurring_days", "goal_id"] as const

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return respond(async () => {
    const body = await readBody(req)
    const id = params.id

    const fields: Record<string, unknown> = {}
    for (const k of SERVICE_FIELDS) if (k in body) fields[k] = body[k]
    if (Object.keys(fields).length > 0) await updateTask(UI_PRINCIPAL, id, fields)

    // カテゴリ変更はサブタスクと予定も一緒に移す
    if (body.mode !== undefined) await changeTaskCategory(UI_PRINCIPAL, id, body.mode)

    // 完了状態・並び順は従来どおり直接更新（完了は /api/tasks/[id]/complete も利用可）
    const raw: Record<string, unknown> = {}
    if (typeof body.done === "boolean") raw.done = body.done
    if ("recurring_done_date" in body) raw.recurring_done_date = optYmd(body.recurring_done_date, "完了日") ?? null
    if (typeof body.sort_order === "number") raw.sort_order = body.sort_order
    if (Object.keys(raw).length > 0) {
      await getTaskRow(UI_PRINCIPAL, id) // 存在確認
      await db.update("tasks", id, raw)
    }
    return getTaskRow(UI_PRINCIPAL, id)
  })
}

// 削除: サブタスクと予定も一緒に消す（従来は子タスクがDBに残っていた）
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return respond(async () => {
    const r = await deleteTask(UI_PRINCIPAL, params.id, { confirm: true })
    return { ok: true, ...r }
  })
}
