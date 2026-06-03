import { NextResponse } from "next/server"
import { createSession } from "@/lib/session"

export async function POST(req: Request) {
  const { password } = await req.json()

  if (password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: "パスワードが違います" }, { status: 401 })
  }

  await createSession()
  return NextResponse.json({ ok: true })
}
