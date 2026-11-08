// AI 連携トークンの管理（管理キーを持つ人だけが使う）。

import { DEFAULT_MODES, DEFAULT_SCOPES, generateToken, publicToken, type TokenRow } from "../ai-auth"
import { db, isMissingTable } from "../db"
import { recordEvent } from "../events"
import { newId } from "../id"
import { badRequest, isMode, isScope, migrationRequired, notFound, USER_ID, type Mode, type Scope } from "../principal"
import type { EventRow } from "../types"

const ADMIN = { userId: USER_ID, actor: "admin" }

function pickModes(v: unknown): Mode[] {
  if (v === undefined) return [...DEFAULT_MODES]
  if (!Array.isArray(v) || !v.every(isMode)) throw badRequest("modes は work / private の配列で指定してください")
  return Array.from(new Set(v))
}

function pickScopes(v: unknown): Scope[] {
  if (v === undefined) return [...DEFAULT_SCOPES]
  if (!Array.isArray(v) || !v.every(isScope)) throw badRequest("scopes は read / task_add / task_edit / schedule / complete / delete の配列で指定してください")
  return Array.from(new Set(v))
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : ""
  if (!s) throw badRequest("名前を入力してください")
  if (s.length > 60) throw badRequest("名前は60文字以内にしてください")
  return s
}

async function getRow(id: string): Promise<TokenRow> {
  let rows: TokenRow[]
  try {
    rows = (await db.find("myflow_ai_tokens", [["user_id", "eq", USER_ID], ["id", "eq", id]], { limit: 1 })) as TokenRow[]
  } catch (e) {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  }
  if (!rows[0]) throw notFound("トークンが見つかりません")
  return rows[0]
}

export async function listTokens() {
  try {
    const rows = (await db.find("myflow_ai_tokens", [["user_id", "eq", USER_ID]], { order: "created_at.desc", limit: 200 })) as TokenRow[]
    return rows.map(publicToken)
  } catch (e) {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  }
}

/** 発行。平文のトークンは、この戻り値で1回だけ返す（以後は取得できない）。 */
export async function createToken(input: { name?: unknown; modes?: unknown; scopes?: unknown; expires_in_days?: unknown }) {
  const name = cleanName(input.name)
  const modes = pickModes(input.modes)
  const scopes = pickScopes(input.scopes)
  let expiresAt: string | null = null
  if (input.expires_in_days !== undefined && input.expires_in_days !== null) {
    const d = input.expires_in_days
    if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 3650) throw badRequest("有効期限は1〜3650日の整数で指定してください")
    expiresAt = new Date(Date.now() + (d as number) * 86400_000).toISOString()
  }
  const { token, hash, prefix } = generateToken()
  let row: TokenRow
  try {
    row = (await db.insert("myflow_ai_tokens", {
      id: newId("tk_"), user_id: USER_ID, name, token_hash: hash, token_prefix: prefix,
      allowed_modes: modes.join(","), scopes: scopes.join(","), expires_at: expiresAt,
    })) as TokenRow
  } catch (e) {
    if (isMissingTable(e)) throw migrationRequired()
    throw e
  }
  await recordEvent(ADMIN, { type: "token_created", payload: { token_id: row.id, name, modes, scopes } })
  return { token, ...publicToken(row) }
}

/** 権限・カテゴリの変更（再発行は不要。取り消し済みのトークンは変更できない）。 */
export async function updateToken(id: string, patch: { name?: unknown; modes?: unknown; scopes?: unknown }) {
  const cur = await getRow(id)
  if (cur.revoked_at) throw badRequest("取り消し済みのトークンは変更できません")
  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) updates.name = cleanName(patch.name)
  if (patch.modes !== undefined) updates.allowed_modes = pickModes(patch.modes).join(",")
  if (patch.scopes !== undefined) updates.scopes = pickScopes(patch.scopes).join(",")
  if (Object.keys(updates).length === 0) throw badRequest("変更内容が指定されていません")
  const row = (await db.update("myflow_ai_tokens", id, updates)) as TokenRow
  await recordEvent(ADMIN, { type: "token_updated", payload: { token_id: id, updated: Object.keys(updates) } })
  return publicToken(row)
}

/** 取り消し（行は消さず revoked_at を入れる。以後その場で使えなくなり、履歴は残る）。 */
export async function revokeToken(id: string) {
  const cur = await getRow(id)
  if (cur.revoked_at) return publicToken(cur)
  const row = (await db.update("myflow_ai_tokens", id, { revoked_at: new Date().toISOString() })) as TokenRow
  await recordEvent(ADMIN, { type: "token_revoked", payload: { token_id: id, name: cur.name } })
  return publicToken(row)
}

/** 操作履歴（新しい順）。AI からの操作だけに絞ることもできる。 */
export async function listAudit(opts: { limit?: number; aiOnly?: boolean } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  let rows: EventRow[]
  try {
    rows = (await db.find("myflow_events", [["user_id", "eq", USER_ID]], { order: "created_at.desc", limit: opts.aiOnly ? 500 : limit })) as EventRow[]
  } catch (e) {
    if (isMissingTable(e)) return []
    throw e
  }
  if (opts.aiOnly) rows = rows.filter(r => r.actor.startsWith("ai:") || r.actor === "admin")
  return rows.slice(0, limit).map(r => ({ id: r.id, at: r.created_at, actor: r.actor, type: r.type, mode: r.mode, task_id: r.task_id, payload: r.payload }))
}
