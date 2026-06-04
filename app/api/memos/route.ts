import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/db"

const USER_ID = "default"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function GET(req: Request) {
  const mode = new URL(req.url).searchParams.get("mode") || "work"
  const { data, error } = await getSupabase()
    .from("memos")
    .select("*")
    .eq("user_id", USER_ID)
    .eq("mode", mode)
    .order("updated_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const { title, content, mode } = await req.json()
  const { data, error } = await getSupabase()
    .from("memos")
    .insert({ id: uid(), user_id: USER_ID, mode, title: title || "", content: content || "" })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
