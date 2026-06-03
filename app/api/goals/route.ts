import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getSupabase } from "@/lib/db"

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const mode = new URL(req.url).searchParams.get("mode") || "work"
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("goals")
    .select("*")
    .eq("user_id", session.user.id)
    .eq("mode", mode)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { text, due_date, mode } = await req.json()
  if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 })

  const supabase = getSupabase()
  const { data, error } = await supabase
    .from("goals")
    .insert({
      id: uid(),
      user_id: session.user.id,
      mode,
      text: text.trim(),
      due_date: due_date || null,
      pct: 0,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
