import { safeEqual } from "@/lib/ai-auth"
import { errorResponse } from "@/lib/http"
import { oauthEnabled, oauthError, pkceChallenge, TOKEN_DAYS, verify } from "@/lib/oauth"
import { createToken } from "@/lib/services/ai-tokens"

export const dynamic = "force-dynamic"

// 認可コード + PKCE の verifier を、合い鍵(mf_…)に交換する。発行された鍵は、設定の「AI 連携」画面の一覧に出て、取り消せる。
export async function POST(req: Request) {
  if (!oauthEnabled()) return oauthError("server_error", "OAuth は未設定です", 503)
  const fd = await req.formData().catch(() => null)
  const g = (k: string) => (fd && typeof fd.get(k) === "string" ? (fd.get(k) as string) : "")
  if (g("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "authorization_code のみ対応しています")
  const c = verify<{ cid: string; uri: string; cc: string; name: string; modes: string[]; scopes: string[] }>(g("code"), "code")
  if (!c) return oauthError("invalid_grant", "認可コードが不正、または期限切れです")
  if (c.cid !== g("client_id") || c.uri !== g("redirect_uri")) return oauthError("invalid_grant", "client_id または redirect_uri が一致しません")
  const verifier = g("code_verifier")
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(pkceChallenge(verifier), c.cc)) return oauthError("invalid_grant", "code_verifier が一致しません")
  try {
    const t = await createToken({ name: `OAuth: ${c.name}`, modes: c.modes, scopes: c.scopes, expires_in_days: TOKEN_DAYS })
    return new Response(JSON.stringify({ access_token: t.token, token_type: "Bearer", expires_in: TOKEN_DAYS * 86400, scope: c.scopes.join(" ") }), {
      headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" },
    })
  } catch (e) {
    return errorResponse(e)
  }
}
