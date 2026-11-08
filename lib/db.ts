// 既定は本番の Supabase。テスト・ローカル確認では SUPABASE_REST_URL でモックDBへ向ける。
const SUPABASE_URL = process.env.SUPABASE_REST_URL ?? "https://giormjyjrdyzcbsrmoeb.supabase.co/rest/v1"

function getHeaders() {
  const key = process.env.SB_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  }
}

// 1リクエストで取得する最大件数（際限なく取得しないための上限）
const DEFAULT_LIMIT = 500

/** Supabase(PostgREST) のエラー。status と code を保持する。 */
export class DbError extends Error {
  status: number
  code: string
  constructor(status: number, body: string) {
    super(body)
    this.name = "DbError"
    this.status = status
    let code = ""
    try { code = JSON.parse(body)?.code ?? "" } catch { /* 本文がJSONでない場合は無視 */ }
    this.code = code
  }
}

async function fail(res: Response): Promise<never> {
  throw new DbError(res.status, await res.text())
}

/** テーブルがまだ作成されていない（マイグレーション未適用）か */
export function isMissingTable(e: unknown): boolean {
  if (!(e instanceof DbError)) return false
  return e.code === "PGRST205" || e.code === "42P01" || (e.status === 404 && /relation|table/i.test(e.message))
}

/** 列がまだ追加されていない（マイグレーション未適用）か */
export function isMissingColumn(e: unknown): boolean {
  if (!(e instanceof DbError)) return false
  return e.code === "PGRST204" || e.code === "42703"
}

export type CondOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is"
export type Cond = [col: string, op: CondOp, value: string | number | boolean | null | Array<string | number>]

function condParams(conds: Cond[]): URLSearchParams {
  const params = new URLSearchParams()
  for (const [col, op, value] of conds) {
    if (op === "in") {
      const list = (Array.isArray(value) ? value : [value]).map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(",")
      params.append(col, `in.(${list})`)
    } else if (op === "is") {
      params.append(col, `is.${value === null ? "null" : String(value)}`)
    } else {
      params.append(col, `${op}.${String(value)}`)
    }
  }
  return params
}

function requireConds(conds: Cond[], what: string) {
  // 条件なしの更新・削除は全件に及ぶため、ここで必ず止める
  if (!Array.isArray(conds) || conds.length === 0) throw new Error(`${what}: 条件が必要です（全件への操作は禁止）`)
}

export const db = {
  /**
   * @param opts.order 並び順。既定は "created_at.desc"。
   *                   created_at 列を持たないテーブルでは明示的に指定すること。
   * @param opts.limit 取得件数の上限。既定は DEFAULT_LIMIT。
   */
  async select(
    table: string,
    filters: Record<string, string>,
    opts?: { order?: string; limit?: number }
  ) {
    const params = new URLSearchParams(
      Object.entries(filters).map(([k, v]) => [k, `eq.${v}`])
    )
    params.set("order", opts?.order ?? "created_at.desc")
    params.set("limit", String(opts?.limit ?? DEFAULT_LIMIT))
    const res = await fetch(`${SUPABASE_URL}/${table}?${params}`, {
      headers: getHeaders(),
      cache: "no-store",
    })
    if (!res.ok) await fail(res)
    return res.json()
  },

  /** 範囲・IN など任意の条件で取得する */
  async find(table: string, conds: Cond[], opts?: { order?: string; limit?: number }) {
    const params = condParams(conds)
    if (opts?.order) params.set("order", opts.order)
    params.set("limit", String(opts?.limit ?? DEFAULT_LIMIT))
    const res = await fetch(`${SUPABASE_URL}/${table}?${params}`, {
      headers: getHeaders(),
      cache: "no-store",
    })
    if (!res.ok) await fail(res)
    return res.json()
  },

  async insert(table: string, data: Record<string, unknown>) {
    const res = await fetch(`${SUPABASE_URL}/${table}`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(data),
    })
    if (!res.ok) await fail(res)
    const json = await res.json()
    return Array.isArray(json) ? json[0] : json
  },

  async update(table: string, id: string, data: Record<string, unknown>) {
    const res = await fetch(`${SUPABASE_URL}/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify(data),
    })
    if (!res.ok) await fail(res)
    const json = await res.json()
    return Array.isArray(json) ? json[0] : json
  },

  /** 条件に一致する行をまとめて更新する（条件は必須） */
  async updateWhere(table: string, conds: Cond[], data: Record<string, unknown>) {
    requireConds(conds, "updateWhere")
    const res = await fetch(`${SUPABASE_URL}/${table}?${condParams(conds)}`, {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify(data),
    })
    if (!res.ok) await fail(res)
    return (await res.json()) as unknown[]
  },

  async delete(table: string, id: string) {
    const res = await fetch(`${SUPABASE_URL}/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { ...getHeaders(), "Prefer": "" },
    })
    if (!res.ok) await fail(res)
    return { ok: true }
  },

  /** 条件に一致する行をまとめて削除する（条件は必須） */
  async deleteWhere(table: string, conds: Cond[]) {
    requireConds(conds, "deleteWhere")
    const res = await fetch(`${SUPABASE_URL}/${table}?${condParams(conds)}`, {
      method: "DELETE",
      headers: { ...getHeaders(), "Prefer": "" },
    })
    if (!res.ok) await fail(res)
    return { ok: true }
  },
}
