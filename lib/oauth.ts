// claude.ai / ChatGPT など、OAuth でコネクタをつなぐクライアント向けの認可サーバー（最小構成）。
//  - 保存先を増やさない: クライアント登録と認可コードは、MYFLOW_ADMIN_KEY から作った鍵で署名した文字列（ステートレス）。
//  - 承認できるのは管理キーを知っている人だけ（同意画面で管理キーを入力する）。パスワード方式のログインは作らない。
//  - 最終的に発行するのは、これまでと同じ「合い鍵(mf_…)」。取り消し・権限・期限・監査ログはそのまま使える。
//  - PKCE(S256)必須、認可コードの有効期間は10分、リダイレクト先は登録済みのものだけ。

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const CODE_TTL_SEC = 600
export const TOKEN_DAYS = 90

function secret(): Buffer | null {
  const k = process.env.MYFLOW_ADMIN_KEY
  return k ? createHmac("sha256", k).update("myflow-oauth-v1").digest() : null
}

export function oauthEnabled(): boolean { return secret() !== null }

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url")

/** 署名つきの文字列を作る。exp は秒（省略で無期限） */
export function sign(payload: Record<string, unknown>, ttlSec?: number, nowMs: number = Date.now()): string {
  const key = secret()
  if (!key) throw new Error("oauth disabled")
  const body = b64(JSON.stringify({ ...payload, ...(ttlSec ? { exp: Math.floor(nowMs / 1000) + ttlSec } : {}) }))
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`
}

/** 署名・期限・種類(t)を検証して、中身を返す。不正なら null */
export function verify<T extends Record<string, unknown>>(token: unknown, type: string, nowMs: number = Date.now()): T | null {
  const key = secret()
  if (!key || typeof token !== "string") return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const want = createHmac("sha256", key).update(body).digest()
  let got: Buffer
  try { got = Buffer.from(sig, "base64url") } catch { return null }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number; t?: string }
    if (p.t !== type) return null
    if (typeof p.exp === "number" && p.exp * 1000 < nowMs) return null
    return p
  } catch { return null }
}

/** リダイレクト先として許すか: https か、手元の開発クライアント用のループバック(http) */
export function isAllowedRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 500) return false
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash) return false
  if (u.protocol === "https:") return true
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export function origin(req: Request): string {
  const u = new URL(req.url)
  const host = req.headers.get("x-forwarded-host") ?? u.host
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "")
  return `${proto.split(",")[0]}://${host.split(",")[0]}`
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))

export function oauthError(error: string, description: string, status = 400) {
  return new Response(JSON.stringify({ error, error_description: description }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
