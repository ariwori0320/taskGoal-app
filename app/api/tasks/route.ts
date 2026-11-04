import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { errorResponse, readBody, respond } from "@/lib/http"
import { UI_PRINCIPAL, USER_ID } from "@/lib/principal"
import { addTask } from "@/lib/services/tasks"

// 毎回のリクエストで処理する（ビルド時に静的化しない）
export const dynamic = "force-dynamic"

// 取得（従来どおり。画面は全列を受け取る）
export async function GET(req: Request) {
  try {
    const mode = new URL(req.url).searchParams.get("mode") || "work"
    const data = await db.select("tasks", { user_id: USER_ID, mode })
    return NextResponse.json(data)
  } catch (e) {
    return errorResponse(e)
  }
}

// 追加（検証・親子のカテゴリ継承・階層上限はサービス層で行う）
export async function POST(req: Request) {
  return respond(async () => addTask(UI_PRINCIPAL, await readBody(req)), 201)
}
