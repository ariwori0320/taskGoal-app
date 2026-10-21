import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { USER_ID, uid, checkGptAuth, tokyoToday, isTaskDone, shapeTask } from "@/lib/gpt"

// GET /api/gpt/tasks?mode=work|private&status=active|done|all&q=検索語
// タスク一覧の取得（読み取り専用・即時）
export async function GET(req: Request) {
  const unauth = checkGptAuth(req)
  if (unauth) return unauth
  try {
    const sp = new URL(req.url).searchParams
    const mode = sp.get("mode") // 省略時は全モード
    const status = (sp.get("status") || "active").toLowerCase()
    const q = (sp.get("q") || "").trim().toLowerCase()

    const filters: Record<string, string> = { user_id: USER_ID }
    if (mode === "work" || mode === "private") filters.mode = mode

    const today = tokyoToday()
    const rows: any[] = await db.select("tasks", filters)
    let tasks = Array.isArray(rows) ? rows : []

    if (status === "active") tasks = tasks.filter(t => !isTaskDone(t, today))
    else if (status === "done") tasks = tasks.filter(t => isTaskDone(t, today))
    // "all" は絞らない

    if (q) tasks = tasks.filter(t => (t.text || "").toLowerCase().includes(q))

    return NextResponse.json({ count: tasks.length, tasks: tasks.map(t => shapeTask(t, today)) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// POST /api/gpt/tasks  タスクの追加（即時。確認不要）
export async function POST(req: Request) {
  const unauth = checkGptAuth(req)
  if (unauth) return unauth
  try {
    const body = await req.json().catch(() => ({}))
    const { text, mode, priority, start_date, due_date, is_recurring, recurring_days, parent_id } = body
    if (!text || !String(text).trim()) {
      return NextResponse.json({ error: "text は必須です" }, { status: 400 })
    }
    const insert: Record<string, unknown> = {
      id: uid(),
      user_id: USER_ID,
      mode: mode === "private" ? "private" : "work",
      text: String(text).trim(),
      priority: ["high", "mid", "low"].includes(priority) ? priority : "mid",
      due_date: due_date || null,
      parent_id: parent_id || null,
      done: false,
      is_recurring: !!is_recurring,
      recurring_days: is_recurring ? (recurring_days ?? "") : "",
    }
    if (start_date) insert.start_date = start_date

    const created = await db.insert("tasks", insert)
    return NextResponse.json({ ok: true, task: shapeTask(created, tokyoToday()) }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
