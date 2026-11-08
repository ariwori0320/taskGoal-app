// 「誰が操作しているか」と、その権限。UI も AI も同じサービス層を通り、ここで認可を強制する。

export type Mode = "work" | "private"
export const ALL_MODES: Mode[] = ["work", "private"]

/** 権限（スコープ）: 閲覧・分析 / タスク追加 / タスク編集 / 予定変更 / 完了処理 / 削除 */
export type Scope = "read" | "task_add" | "task_edit" | "schedule" | "complete" | "delete"
export const ALL_SCOPES: Scope[] = ["read", "task_add", "task_edit", "schedule", "complete", "delete"]

export const SCOPE_LABELS: Record<Scope, string> = {
  read: "閲覧・分析",
  task_add: "タスク追加",
  task_edit: "タスク編集",
  schedule: "予定変更",
  complete: "完了処理",
  delete: "削除",
}

export interface Principal {
  kind: "ui" | "ai"
  userId: string
  modes: Mode[]
  scopes: Scope[]
  /** 履歴に残す操作者名: 'ui' / 'ai:<トークン名>' */
  actor: string
  tokenId?: string
}

export const USER_ID = "default"

/** アプリ本体の画面（従来どおり無認証。全カテゴリ・全権限） */
export const UI_PRINCIPAL: Principal = {
  kind: "ui",
  userId: USER_ID,
  modes: [...ALL_MODES],
  scopes: [...ALL_SCOPES],
  actor: "ui",
}

export function isMode(v: unknown): v is Mode {
  return v === "work" || v === "private"
}

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (ALL_SCOPES as string[]).includes(v)
}

export function parseCsv<T extends string>(csv: string | null | undefined, valid: (v: unknown) => v is T): T[] {
  if (!csv) return []
  return Array.from(new Set(csv.split(",").map(s => s.trim()).filter(valid)))
}

// ---------- エラー ----------

export class ServiceError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ServiceError"
    this.status = status
    this.code = code
  }
}
export const badRequest = (m: string) => new ServiceError(400, "bad_request", m)
export const forbidden = (m: string) => new ServiceError(403, "forbidden", m)
export const notFound = (m = "見つかりません") => new ServiceError(404, "not_found", m)
export const migrationRequired = () =>
  new ServiceError(503, "migration_required", "データベースの更新が必要です（db/migrations/001_myflow_renewal.sql を実行してください）")

// ---------- 認可 ----------

export function canMode(p: Principal, mode: string): boolean {
  return isMode(mode) && p.modes.includes(mode)
}

export function requireScope(p: Principal, scope: Scope) {
  if (!p.scopes.includes(scope)) {
    throw forbidden(`この操作に必要な権限がありません（${SCOPE_LABELS[scope]}）`)
  }
}

/** このカテゴリへのアクセスを要求する。許可が無ければ 403。 */
export function requireMode(p: Principal, mode: string) {
  if (!canMode(p, mode)) throw forbidden(`このカテゴリ（${mode === "work" ? "仕事" : mode === "private" ? "プライベート" : mode}）へのアクセスは許可されていません`)
}

/** 既存データの所属カテゴリを検査する。権限が無い場合は「存在しない」ものとして扱い、存在を漏らさない。 */
export function requireVisible(p: Principal, mode: string | null | undefined): void {
  if (!mode || !canMode(p, mode)) throw notFound()
}

/**
 * 参照対象のカテゴリ一覧を決める。
 *  - 指定なし  → 許可されているカテゴリすべて
 *  - 指定あり  → 許可されていなければ 403
 */
export function resolveModes(p: Principal, requested?: string | null): Mode[] {
  if (requested === undefined || requested === null || requested === "") return [...p.modes]
  if (!isMode(requested)) throw badRequest("mode は work か private を指定してください")
  requireMode(p, requested)
  return [requested]
}
