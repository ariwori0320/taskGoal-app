import { NextResponse } from "next/server"
import { checkAdmin } from "./ai-auth"
import { errorResponse } from "./http"

/** 管理用 API の共通処理: 管理キーを検証してから fn を実行する */
export async function adminRespond<T>(req: Request, fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  const auth = checkAdmin(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined })
  try {
    return NextResponse.json(await fn(), { status, headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return errorResponse(e)
  }
}
