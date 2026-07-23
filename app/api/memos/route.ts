import { NextResponse } from "next/server"
import { db } from "@/lib/db"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function GET(req: Request) {
  try {
    const mode = new URL(req.url).searchParams.get("mode") || "work"
    const data = await db.select("memos", { user_id: USER_ID, mode })
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { title, content, mode, tags } = await req.json()
    const insert: Record<string, unknown> = {
      id: uid(), user_id: USER_ID, mode: mode || "work",
      title: title || "", content: content || "",
    }
    // tags は指定時のみ送る（列未追加の環境で作成を壊さない）
    if (tags) insert.tags = tags
    const memo = await db.insert("memos", insert)
    return NextResponse.json(memo, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
