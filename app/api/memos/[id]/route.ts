import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/db"

const USER_ID = "default"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { title, content } = await req.json()
  const { data, error } = await getSupabase()
    .from("memos")
    .update({ title, content, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("user_id", USER_ID)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { error } = await getSupabase()
    .from("memos")
    .delete()
    .eq("id", params.id)
    .eq("user_id", USER_ID)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
