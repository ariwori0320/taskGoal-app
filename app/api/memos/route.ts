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
    const { title, content, mode } = await req.json()
    const memo = await db.insert("memos", {
      id: uid(), user_id: USER_ID, mode: mode || "work",
      title: title || "", content: content || "",
    })
    return NextResponse.json(memo, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
