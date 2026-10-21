import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { checkGptAuth, tokyoToday, getTask, shapeTask } from "@/lib/gpt"

// POST /api/gpt/tasks/update
// body: { id, confirm?, text?, priority?, start_date?, due_date?, memo?, mode?, is_recurring?, recurring_days? }
// タスク内容の変更。confirm !== true のときは実行せずプレビューを返す（確認後に再送してもらう）。
export async function POST(req: Request) {
  const unauth = checkGptAuth(req)
  if (unauth) return unauth
  try {
    const body = await req.json().catch(() => ({}))
    const id = body.id
    if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 })

    const task = await getTask(id)
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 })

    // 指定されたフィールドだけ変更対象にする
    const updates: Record<string, unknown> = {}
    if (typeof body.text === "string") updates.text = body.text
    if (["high", "mid", "low"].includes(body.priority)) updates.priority = body.priority
    if ("start_date" in body) updates.start_date = body.start_date || null
    if ("due_date" in body) updates.due_date = body.due_date || null
    if (typeof body.memo === "string") updates.memo = body.memo
    if (body.mode === "work" || body.mode === "private") updates.mode = body.mode
    if (typeof body.is_recurring === "boolean") updates.is_recurring = body.is_recurring
    if (typeof body.recurring_days === "string") updates.recurring_days = body.recurring_days

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "変更内容が指定されていません" }, { status: 400 })
    }

    const today = tokyoToday()

    // --- 確認ゲート ---
    if (body.confirm !== true) {
      return NextResponse.json({
        needsConfirmation: true,
        action: "update",
        message: "以下の内容で変更します。ユーザーに確認し、同意が得られたら confirm:true を付けて再送してください。",
        current: shapeTask(task, today),
        changes: updates,
      })
    }

    const updated = await db.update("tasks", id, updates)
    return NextResponse.json({ ok: true, task: shapeTask(updated, today) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
