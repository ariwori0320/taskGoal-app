import { NextResponse } from "next/server"
import { getSupabase } from "@/lib/db"

const USER_ID = "default"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { data, error } = await getSupabase()
    .from("tasks")
    .update({ done: body.done })
    .eq("id", params.id)
    .eq("user_id", USER_ID)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { error } = await getSupabase()
    .from("tasks")
    .delete()
    .eq("id", params.id)
    .eq("user_id", USER_ID)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
