import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { checkGptAuth, tokyoToday, getTask, shapeTask } from "@/lib/gpt"

// POST /api/gpt/tasks/delete  body: { id, confirm? }
// タスクの削除。confirm !== true のときは実行せず、削除対象のプレビューを返す。
// 注意: 子タスク(サブタスク)も UI 上は一緒に消える扱い。ここでは指定 id のみ削除する。
export async function POST(req: Request) {
  const unauth = checkGptAuth(req)
  if (unauth) return unauth
  try {
    const body = await req.json().catch(() => ({}))
    const id = body.id
    if (!id) return NextResponse.json({ error: "id は必須です" }, { status: 400 })

    const task = await getTask(id)
    if (!task) return NextResponse.json({ error: "タスクが見つかりません" }, { status: 404 })

    const today = tokyoToday()

    // --- 確認ゲート ---
    if (body.confirm !== true) {
      return NextResponse.json({
        needsConfirmation: true,
        action: "delete",
        message: "このタスクを削除します。ユーザーに確認し、同意が得られたら confirm:true を付けて再送してください。",
        target: shapeTask(task, today),
      })
    }

    await db.delete("tasks", id)
    return NextResponse.json({ ok: true, deleted_id: id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
