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

export const db = {
  async select(table: string, filters: Record<string, string>) {
    const params = new URLSearchParams(
      Object.entries(filters).map(([k, v]) => [k, `eq.${v}`])
    )
    params.set("order", "created_at.desc")
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
