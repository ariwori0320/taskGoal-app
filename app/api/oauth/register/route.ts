import { isAllowedRedirect, oauthEnabled, oauthError, sign } from "@/lib/oauth"

export const dynamic = "force-dynamic"

// 動的クライアント登録（RFC 7591）。登録内容は署名つきの client_id に入れるだけで、DB には何も保存しない。
// 登録しただけでは何もできない（承認は、管理キーを持つ人が同意画面で行う）。
export async function POST(req: Request) {
  if (!oauthEnabled()) return oauthError("server_error", "MYFLOW_ADMIN_KEY が未設定のため、OAuth は使えません", 503)
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* 空でも可 */ }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  if (uris.length === 0 || uris.length > 5 || !uris.every(isAllowedRedirect)) return oauthError("invalid_redirect_uri", "redirect_uris は https（または localhost）の URL を1〜5件指定してください")
  const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "AI クライアント").slice(0, 60)
  const client_id = sign({ t: "client", name, uris })
  return new Response(JSON.stringify({
    client_id, client_name: name, redirect_uris: uris,
    grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
  }), { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
