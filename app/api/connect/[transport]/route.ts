import { createMcpHandler } from "mcp-handler"
import { z } from "zod"
import { db } from "@/lib/db"
import { USER_ID, uid, tokyoToday, isTaskDone, getTask, shapeTask } from "@/lib/gpt"

export const maxDuration = 60

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }
}

const mcpHandler = createMcpHandler(
  (server) => {
    // --- 取得（読み取り専用） ---
    server.registerTool(
      "list_tasks",
      {
        title: "タスク一覧",
        description:
          "MyFlow のタスクを取得する。status=active(未完了,既定)/done(完了)/all。mode=work/private(省略で両方)。q=タスク名の部分一致。変更・削除の前に id を特定する目的にも使う。",
        inputSchema: {
          mode: z.enum(["work", "private"]).optional(),
          status: z.enum(["active", "done", "all"]).optional(),
          q: z.string().optional().describe("タスク名のキーワード（部分一致）"),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ mode, status, q }) => {
        const filters: Record<string, string> = { user_id: USER_ID }
        if (mode) filters.mode = mode
        const today = tokyoToday()
        const rows: any[] = await db.select("tasks", filters)
        let tasks = Array.isArray(rows) ? rows : []
        const st = status || "active"
        if (st === "active") tasks = tasks.filter(t => !isTaskDone(t, today))
        else if (st === "done") tasks = tasks.filter(t => isTaskDone(t, today))
        if (q) tasks = tasks.filter(t => (t.text || "").toLowerCase().includes(q.toLowerCase()))
        return textResult({ count: tasks.length, tasks: tasks.map(t => shapeTask(t, today)) })
      }
    )

    // --- 追加（即時） ---
    server.registerTool(
      "add_task",
      {
        title: "タスク追加",
        description: "新しいタスクを追加する。",
        inputSchema: {
          text: z.string().describe("タスク名（必須）"),
          mode: z.enum(["work", "private"]).optional().describe("既定は work"),
          priority: z.enum(["high", "mid", "low"]).optional().describe("既定は mid"),
          start_date: z.string().optional().describe("開始日 YYYY-MM-DD"),
          due_date: z.string().optional().describe("期限日 YYYY-MM-DD"),
          is_recurring: z.boolean().optional(),
          recurring_days: z.string().optional().describe('空=毎日, "1,3,5"=月水金 (0=日..6=土)'),
          parent_id: z.string().optional().describe("親タスクID（サブタスクにする場合）"),
        },
      },
      async (a) => {
        if (!a.text || !a.text.trim()) return textResult({ error: "text は必須です" })
        const insert: Record<string, unknown> = {
          id: uid(),
          user_id: USER_ID,
          mode: a.mode === "private" ? "private" : "work",
          text: a.text.trim(),
          priority: a.priority || "mid",
          due_date: a.due_date || null,
          parent_id: a.parent_id || null,
          done: false,
          is_recurring: !!a.is_recurring,
          recurring_days: a.is_recurring ? (a.recurring_days ?? "") : "",
        }
        if (a.start_date) insert.start_date = a.start_date
        const created = await db.insert("tasks", insert)
        return textResult({ ok: true, task: shapeTask(created, tokyoToday()) })
      }
    )

    // --- 完了 / 未完了戻し（即時） ---
    server.registerTool(
      "complete_task",
      {
        title: "タスク完了",
        description: "タスクを完了にする（done=false で未完了に戻す）。繰り返しは当日分を記録する。",
        inputSchema: {
          id: z.string(),
          done: z.boolean().optional().describe("true=完了(既定) / false=未完了に戻す"),
        },
      },
      async ({ id, done }) => {
        const task = await getTask(id)
        if (!task) return textResult({ error: "タスクが見つかりません", id })
        const isDone = done === false ? false : true
        const today = tokyoToday()
        const updates = task.is_recurring
          ? { recurring_done_date: isDone ? today : null }
          : { done: isDone }
        const updated = await db.update("tasks", id, updates)
        return textResult({ ok: true, task: shapeTask(updated, today) })
      }
    )

    // --- 変更（破壊的。ChatGPT が実行前に確認する） ---
    server.registerTool(
      "update_task",
      {
        title: "タスク変更",
        description: "タスクの内容を変更する。実行前にユーザーへ変更内容を確認すること。",
        inputSchema: {
          id: z.string(),
          text: z.string().optional(),
          priority: z.enum(["high", "mid", "low"]).optional(),
          start_date: z.string().optional().describe("YYYY-MM-DD（空文字でクリア）"),
          due_date: z.string().optional().describe("YYYY-MM-DD（空文字でクリア）"),
          memo: z.string().optional(),
          mode: z.enum(["work", "private"]).optional(),
        },
        annotations: { destructiveHint: true },
      },
      async (a) => {
        const task = await getTask(a.id)
        if (!task) return textResult({ error: "タスクが見つかりません", id: a.id })
        const updates: Record<string, unknown> = {}
        if (typeof a.text === "string") updates.text = a.text
        if (a.priority) updates.priority = a.priority
        if ("start_date" in a) updates.start_date = a.start_date || null
        if ("due_date" in a) updates.due_date = a.due_date || null
        if (typeof a.memo === "string") updates.memo = a.memo
        if (a.mode) updates.mode = a.mode
        if (Object.keys(updates).length === 0) return textResult({ error: "変更内容がありません" })
        const updated = await db.update("tasks", a.id, updates)
        return textResult({ ok: true, task: shapeTask(updated, tokyoToday()) })
      }
    )

    // --- 削除（破壊的。ChatGPT が実行前に確認する） ---
    server.registerTool(
      "delete_task",
      {
        title: "タスク削除",
        description: "タスクを削除する。実行前にユーザーへ対象を確認すること。指定 id のみ削除する。",
        inputSchema: { id: z.string() },
        annotations: { destructiveHint: true },
      },
      async ({ id }) => {
        const task = await getTask(id)
        if (!task) return textResult({ error: "タスクが見つかりません", id })
        await db.delete("tasks", id)
        return textResult({ ok: true, deleted_id: id, deleted_text: task.text })
      }
    )
  },
  {
    serverInfo: { name: "myflow", version: "1.0.0" },
  },
  {
    basePath: "/api/connect",
    maxDuration: 60,
    verboseLogs: false,
  }
)

// ---- Token 認証（ChatGPTコネクタの "Token" 方式 = Authorization: Bearer）----
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function authed(req: Request): Promise<Response> {
  const configured = process.env.GPT_API_KEY ?? ""
  if (!configured) {
    return new Response(JSON.stringify({ error: "GPT_API_KEY 未設定" }), {
      status: 503, headers: { "content-type": "application/json" },
    })
  }
  const header = req.headers.get("authorization") || ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token || !safeEqual(token, configured)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", "WWW-Authenticate": "Bearer" },
    })
  }
  return mcpHandler(req)
}

export { authed as GET, authed as POST, authed as DELETE }
