import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { checkGptAuth, tokyoToday, getTask, shapeTask } from "@/lib/gpt"

// POST /api/gpt/tasks/complete  body: { id, done? }
// タスクの完了 / 未完了戻し（即時）。繰り返しタスクは当日分の完了を記録する。
export async function POST(req: Request) {
  const unauth = checkGptAuth(req)
  if (unauth) return unauth
  try {
    const body = await req.json().catch(() => ({}))
    const id = body.id
    const done = body.done === false ? false : true // 既定は完了
    if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 })

    const task = await getTask(id)
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 })

    const today = tokyoToday()
    const updates = task.is_recurring
      ? { recurring_done_date: done ? today : null }
      : { done }

    const updated = await db.update("tasks", id, updates)
    return NextResponse.json({ ok: true, task: shapeTask(updated, today) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
