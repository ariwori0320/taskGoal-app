import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getSupabase } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("tasks")
    .update({ done: body.done })
    .eq("id", params.id)
    .eq("user_id", session.user.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const supabase = getSupabase()
  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", params.id)
    .eq("user_id", session.user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
