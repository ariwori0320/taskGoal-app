const SUPABASE_URL = "https://giormjyjrdyzcbsrmoeb.supabase.co/rest/v1"

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
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },

  async insert(table: string, data: Record<string, unknown>) {
    const res = await fetch(`${SUPABASE_URL}/${table}`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(await res.text())
    const json = await res.json()
    return Array.isArray(json) ? json[0] : json
  },

  async update(table: string, id: string, data: Record<string, unknown>) {
    const res = await fetch(`${SUPABASE_URL}/${table}?id=eq.${id}`, {
      method: "PATCH",
      headers: getHeaders(),
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(await res.text())
    const json = await res.json()
    return Array.isArray(json) ? json[0] : json
  },

  async delete(table: string, id: string) {
    const res = await fetch(`${SUPABASE_URL}/${table}?id=eq.${id}`, {
      method: "DELETE",
      headers: { ...getHeaders(), "Prefer": "" },
    })
    if (!res.ok) throw new Error(await res.text())
    return { ok: true }
  },
}
