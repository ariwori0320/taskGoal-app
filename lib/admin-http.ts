import { NextResponse } from "next/server"
import { checkAdmin } from "./ai-auth"
import { errorResponse } from "./http"
import { blockedSeconds, clearFailures, clientKey, recordFailure } from "./throttle"

/** 管理用 API の共通処理: 管理キーを検証してから fn を実行する（失敗が続く接続元は一定時間ブロック） */
export async function adminRespond<T>(req: Request, fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  const key = clientKey(req)
  const wait = blockedSeconds(key)
  if (wait > 0) {
    return NextResponse.json({ error: "試行回数が多すぎます。しばらくしてからやり直してください", code: "too_many_attempts" }, { status: 429, headers: { "Retry-After": String(wait), "Cache-Control": "no-store" } })
  }
  const auth = checkAdmin(req)
  if (!auth.ok) {
    if (auth.status === 401) recordFailure(key) // 未設定(503)は試行ではないので数えない
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined })
  }
  clearFailures(key)
  try {
    return NextResponse.json(await fn(), { status, headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return errorResponse(e)
  }
}
