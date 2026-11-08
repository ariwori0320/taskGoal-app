// テスト・ローカル確認用の「PostgREST 互換」インメモリDB。本番の Supabase には接続しない。
// 使い方: import { createMockSupabase } from "./mock-supabase.mjs"
//         単体起動:  node scripts/mock-supabase-cli.mjs [port]

import http from "node:http"

const LEGACY_TABLES = ["tasks", "goals", "memos", "highlights"]
const NEW_TABLES = ["myflow_timeboxes", "myflow_fixed_events", "myflow_events", "myflow_settings", "myflow_ai_tokens"]
const PK = { myflow_settings: "user_id" }
const RESERVED = new Set(["select", "order", "limit", "offset"])

function cmpEq(v, raw) {
  if (v === null || v === undefined) return false
  if (typeof v === "boolean") return String(v) === raw
  if (typeof v === "number") return Number(raw) === v
  return String(v) === raw
}

function cmpOrder(v, raw) {
  if (v === null || v === undefined) return null
  if (typeof v === "number") return v - Number(raw)
  return v < raw ? -1 : v > raw ? 1 : 0
}

function parseIn(raw) {
  // (a,b) または ("a","b")
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "")
  if (inner === "") return []
  return inner.split(",").map(s => s.trim().replace(/^"|"$/g, "").replace(/\\"/g, '"'))
}

function matches(row, col, expr) {
  const dot = expr.indexOf(".")
  const op = expr.slice(0, dot)
  const raw = expr.slice(dot + 1)
  const v = row[col]
  switch (op) {
    case "eq": return cmpEq(v, raw)
    case "neq": return !cmpEq(v, raw)
    case "gt": { const c = cmpOrder(v, raw); return c !== null && c > 0 }
    case "gte": { const c = cmpOrder(v, raw); return c !== null && c >= 0 }
    case "lt": { const c = cmpOrder(v, raw); return c !== null && c < 0 }
    case "lte": { const c = cmpOrder(v, raw); return c !== null && c <= 0 }
    case "in": return parseIn(raw).some(x => cmpEq(v, x))
    case "is": return raw === "null" ? v === null || v === undefined : cmpEq(v, raw)
    default: throw Object.assign(new Error(`unsupported operator: ${op}`), { status: 400 })
  }
}

function filterRows(rows, searchParams) {
  const conds = []
  for (const [k, v] of searchParams.entries()) if (!RESERVED.has(k)) conds.push([k, v])
  return rows.filter(r => conds.every(([k, v]) => matches(r, k, v)))
}

function sortRows(rows, order) {
  if (!order) return rows
  const keys = order.split(",").map(s => {
    const [col, dir = "asc"] = s.split(".")
    return { col, desc: dir === "desc" }
  })
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const av = a[col], bv = b[col]
      const an = av === null || av === undefined, bn = bv === null || bv === undefined
      if (an && bn) continue
      // Postgres の既定: ASC は NULL が最後、DESC は NULL が最初
      if (an) return desc ? -1 : 1
      if (bn) return desc ? 1 : -1
      if (av < bv) return desc ? 1 : -1
      if (av > bv) return desc ? -1 : 1
    }
    return 0
  })
}

/**
 * @param {object} opts
 * @param {boolean} [opts.newTables=true]  false にするとマイグレーション未適用(新テーブル無し)を再現
 * @param {string[]} [opts.missingColumns] 指定した列を含む書き込みを 400(PGRST204) にする（tasks のみ）
 */
export function createMockSupabase(opts = {}) {
  const newTables = opts.newTables !== false
  const missingColumns = opts.missingColumns ?? []
  const allowed = new Set([...LEGACY_TABLES, ...(newTables ? NEW_TABLES : [])])
  /** @type {Record<string, any[]>} */
  const store = {}
  for (const t of allowed) store[t] = []
  const log = [] // リクエスト履歴（テストで「本番を叩いていない」等の確認に使う）
  /** @type {{ table: string, status: number, body: unknown }[]} 次の1回だけ、指定テーブルへのリクエストを失敗させる（異常系のテスト用） */
  const injected = [] // { table, status, body, after } after=その前に通すリクエスト数

  const send = (res, status, body) => {
    const text = body === undefined ? "" : JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(text)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      const m = /^\/rest\/v1\/([^/]+)$/.exec(url.pathname)
      if (!m) return send(res, 404, { message: "not found" })
      const table = m[1]
      log.push({ method: req.method, table, query: url.search })
      if (!req.headers["apikey"]) return send(res, 401, { message: "No API key found in request" })
      const inj = injected.findIndex(r => r.table === table)
      if (inj !== -1) {
        if (injected[inj].after > 0) injected[inj].after--
        else { const [r] = injected.splice(inj, 1); return send(res, r.status, r.body) }
      }
      if (!allowed.has(table)) {
        return send(res, 404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` })
      }
      const pk = PK[table] ?? "id"
      const rows = store[table]
      const prefer = String(req.headers["prefer"] ?? "")
      const wantRep = prefer.includes("return=representation")

      let body = null
      if (req.method === "POST" || req.method === "PATCH") {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const text = Buffer.concat(chunks).toString("utf8")
        body = text ? JSON.parse(text) : {}
        if (table === "tasks") {
          const items = Array.isArray(body) ? body : [body]
          for (const it of items) {
            for (const col of missingColumns) {
              if (col in it) return send(res, 400, { code: "PGRST204", message: `Could not find the '${col}' column of 'tasks' in the schema cache` })
            }
          }
        }
      }

      if (req.method === "GET") {
        let out = filterRows(rows, url.searchParams)
        out = sortRows(out, url.searchParams.get("order"))
        const limit = url.searchParams.get("limit")
        if (limit) out = out.slice(0, Number(limit))
        return send(res, 200, out.map(r => ({ ...r })))
      }

      if (req.method === "POST") {
        const items = Array.isArray(body) ? body : [body]
        const inserted = []
        for (const it of items) {
          if (rows.some(r => r[pk] === it[pk]) && it[pk] !== undefined) {
            return send(res, 409, { code: "23505", message: `duplicate key value violates unique constraint on ${pk}` })
          }
          if (table === "myflow_ai_tokens" && rows.some(r => r.token_hash === it.token_hash)) {
            return send(res, 409, { code: "23505", message: "duplicate token_hash" })
          }
          const now = new Date().toISOString()
          const row = { created_at: now, ...it }
          if (table.startsWith("myflow_") && table !== "myflow_events" && !("updated_at" in row)) row.updated_at = now
          rows.push(row)
          inserted.push({ ...row })
        }
        return wantRep ? send(res, 201, inserted) : send(res, 201)
      }

      if (req.method === "PATCH") {
        const targets = filterRows(rows, url.searchParams)
        if (![...url.searchParams.keys()].some(k => !RESERVED.has(k))) return send(res, 400, { message: "PATCH requires filters" })
        for (const r of targets) Object.assign(r, body)
        return wantRep ? send(res, 200, targets.map(r => ({ ...r }))) : send(res, 204)
      }

      if (req.method === "DELETE") {
        if (![...url.searchParams.keys()].some(k => !RESERVED.has(k))) return send(res, 400, { message: "DELETE requires filters" })
        const targets = new Set(filterRows(rows, url.searchParams))
        const remaining = rows.filter(r => !targets.has(r))
        rows.length = 0
        rows.push(...remaining)
        return send(res, 204)
      }

      return send(res, 405, { message: "method not allowed" })
    } catch (e) {
      return send(res, e.status ?? 500, { message: e.message })
    }
  })

  return {
    server,
    store,
    log,
    listen: (port = 0) => new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(() => resolve())),
    /** 次の1回、table へのリクエストを status/body で失敗させる */
    failNext(table, status = 500, body = { message: "injected failure" }, after = 0) { injected.push({ table, status, body, after }) },
    reset() { for (const t of allowed) store[t].length = 0; log.length = 0; injected.length = 0 },
  }
}
