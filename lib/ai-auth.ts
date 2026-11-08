// AI 連携のトークン認証。
//  - トークンの平文は保存しない（SHA-256 のハッシュのみ DB に置く）。発行時に1回だけ表示する。
//  - 権限（スコープ）とアクセスできるカテゴリはトークンごと。取り消し(revoked_at)・期限(expires_at)に対応。
//  - 既定は「プライベートのみ・閲覧のみ」。仕事のデータは、明示的に許可されるまで AI に公開しない。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { db, isMissingTable } from "./db"
import { isMode, isScope, parseCsv, USER_ID, type Mode, type Principal, type Scope } from "./principal"

export const TOKEN_PREFIX = "mf_"
export const DEFAULT_MODES: Mode[] = ["private"]
export const DEFAULT_SCOPES: Scope[] = ["read"]

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function generateToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url")
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) }
}

/** 文字列の定数時間比較（長さの違いからも情報を漏らさないよう、ハッシュ同士で比べる） */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())
}

export interface TokenRow {
  id: string
  user_id: string
  name: string
  token_hash: string
  token_prefix: string
  allowed_modes: string
  scopes: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

/** 一覧などに返す形（ハッシュは絶対に返さない） */
export function publicToken(t: TokenRow) {
  return {
    id: t.id, name: t.name, prefix: t.token_prefix,
    modes: parseCsv(t.allowed_modes, isMode), scopes: parseCsv(t.scopes, isScope),
    expires_at: t.expires_at, last_used_at: t.last_used_at, revoked_at: t.revoked_at, created_at: t.created_at,
  }
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 503; error: string }

const UNAUTHORIZED: AuthResult = { ok: false, status: 401, error: "unauthorized" }

/** 旧方式の共有キー(GPT_API_KEY)。互換のため残すが、権限はプライベートのみ・削除不可に制限する。 */
const LEGACY_SCOPES: Scope[] = ["read", "task_add", "task_edit", "schedule", "complete"]

export async function authenticateAi(req: Request): Promise<AuthResult> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")
  const token = m?.[1].trim()
  if (!token) return UNAUTHORIZED

  if (token.startsWith(TOKEN_PREFIX)) {
    let row: TokenRow | undefined
    try {
      row = (await db.find("myflow_ai_tokens", [["token_hash", "eq", hashToken(token)]], { limit: 1 }))[0]
    } catch (e) {
      if (isMissingTable(e)) return { ok: false, status: 503, error: "AI連携のための準備（データベースの更新）が済んでいません" }
      throw e
    }
    if (!row) return UNAUTHORIZED
    if (row.revoked_at) return UNAUTHORIZED // 取り消し済み。取り消しはその場で効く
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return UNAUTHORIZED

    // 最終利用日時（補助情報。更新に失敗しても認証は成功させる。1分に1回まで）
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) {
      db.update("myflow_ai_tokens", row.id, { last_used_at: new Date().toISOString() }).catch(() => { /* 無視 */ })
    }
    return {
      ok: true,
      principal: {
        kind: "ai", userId: row.user_id || USER_ID, tokenId: row.id, actor: `ai:${row.name}`,
        modes: parseCsv(row.allowed_modes, isMode), scopes: parseCsv(row.scopes, isScope),
      },
    }
  }

  const legacy = process.env.GPT_API_KEY ?? ""
  if (legacy && safeEqual(token, legacy)) {
    return { ok: true, principal: { kind: "ai", userId: USER_ID, actor: "ai:legacy-key", modes: ["private"], scopes: [...LEGACY_SCOPES] } }
  }
  return UNAUTHORIZED
}

/** 管理用 API の認証。MYFLOW_ADMIN_KEY を知っている人だけがトークンを発行・取り消せる。未設定なら全て拒否。 */
export function checkAdmin(req: Request): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const configured = process.env.MYFLOW_ADMIN_KEY ?? ""
  if (!configured) return { ok: false, status: 503, error: "管理キー(MYFLOW_ADMIN_KEY)がサーバーに設定されていません" }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")
  if (!m || !safeEqual(m[1].trim(), configured)) return { ok: false, status: 401, error: "管理キーが違います" }
  return { ok: true }
}
