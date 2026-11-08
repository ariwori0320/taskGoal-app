// OAuth（claude.ai / ChatGPT のコネクタ用）: 登録 → 承認 → 交換 → MCP 利用 までと、悪用されそうな場面を検証する。

import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { startMock } from "./helpers"

let mock: Awaited<ReturnType<typeof startMock>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let R: Record<string, any>
let O: typeof import("../lib/oauth")

const ADMIN_KEY = "test-admin-key-0123456789"
const REDIRECT = "https://claude.ai/api/mcp/auth_callback"
const rows = (t: string) => mock.store[t] as any[] // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  mock = await startMock()
  R = {
    register: await import("../app/api/oauth/register/route"),
    authorize: await import("../app/api/oauth/authorize/route"),
    token: await import("../app/api/oauth/token/route"),
    meta: await import("../app/.well-known/oauth-authorization-server/route"),
    resource: await import("../app/.well-known/oauth-protected-resource/[[...path]]/route"),
    mcp: await import("../app/api/connect/[transport]/route"),
  }
  O = await import("../lib/oauth")
})
after(async () => { await mock.close() })
beforeEach(async () => {
  mock.reset(); process.env.MYFLOW_ADMIN_KEY = ADMIN_KEY
  ;(await import("../lib/throttle")).resetThrottle()
})

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") } }
const BASE = "http://localhost"

async function register(uris: unknown = [REDIRECT]) {
  const res = await R.register.POST(new Request(`${BASE}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: uris }) }))
  return { status: res.status, json: await res.json() }
}
const authUrl = (p: Record<string, string>) => `${BASE}/api/oauth/authorize?` + new URLSearchParams({ response_type: "code", code_challenge_method: "S256", ...p }).toString()
async function approve(fields: Record<string, string | string[]>, ip = "203.0.113.5") {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x)
  return R.authorize.POST(new Request(`${BASE}/api/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body }))
}
async function exchange(fields: Record<string, string>) {
  const res = await R.token.POST(new Request(`${BASE}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", ...fields }) }))
  return { status: res.status, json: await res.json() }
}
async function toolNames(token: string) {
  const res = await R.mcp.POST(new Request(`${BASE}/api/connect/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), { params: { transport: "mcp" } })
  const m = /data: (.*)/.exec(await res.text())
  return ((m ? JSON.parse(m[1]) : {}).result?.tools ?? []).map((t: { name: string }) => t.name) as string[]
}

/** 正しい手順で、認可コードまで進める */
async function getCode(extra: Record<string, string | string[]> = {}) {
  const c = (await register()).json.client_id as string
  const { verifier, challenge } = pkce()
  const res = await approve({ client_id: c, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, code_challenge_method: "S256", admin_key: ADMIN_KEY, mode: "private", scope: "read", ...extra })
  return { c, verifier, challenge, res }
}

test("メタデータ: 認可サーバーと保護対象の情報を返し、MCP の 401 がそこを指す", async () => {
  const m = await (await R.meta.GET(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json()
  assert.equal(m.token_endpoint, `${BASE}/api/oauth/token`)
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"])
  const r = await (await R.resource.GET(new Request(`${BASE}/.well-known/oauth-protected-resource/api/connect/mcp`))).json()
  assert.deepEqual([r.resource, r.authorization_servers], [`${BASE}/api/connect/mcp`, [BASE]])
  const res = await R.mcp.POST(new Request(`${BASE}/api/connect/mcp`, { method: "POST" }), { params: { transport: "mcp" } })
  assert.equal(res.status, 401)
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource"/)
})

test("正しい手順: 登録 → 同意画面 → 承認 → 交換 → その鍵で MCP が使え、権限は承認した範囲だけ。一覧に出て取り消せる", async () => {
  const c = (await register()).json.client_id as string
  const { verifier, challenge } = pkce()
  const page = await R.authorize.GET(new Request(authUrl({ client_id: c, redirect_uri: REDIRECT, state: "s1", code_challenge: challenge })))
  assert.equal(page.status, 200)
  assert.match(await page.text(), /管理キー/)

  const ok = await approve({ client_id: c, redirect_uri: REDIRECT, state: "s1", code_challenge: challenge, code_challenge_method: "S256", admin_key: ADMIN_KEY, mode: "private", scope: ["read", "task_add"] })
  assert.equal(ok.status, 303)
  const loc = new URL(ok.headers.get("location")!)
  assert.equal(`${loc.origin}${loc.pathname}`, REDIRECT)
  assert.equal(loc.searchParams.get("state"), "s1")

  const tok = await exchange({ code: loc.searchParams.get("code")!, client_id: c, redirect_uri: REDIRECT, code_verifier: verifier })
  assert.equal(tok.status, 200)
  assert.equal(tok.json.token_type, "Bearer")
  assert.match(tok.json.access_token, /^mf_/)
  const names = await toolNames(tok.json.access_token)
  assert.ok(names.includes("list_tasks") && names.includes("add_task"))
  assert.ok(!names.includes("delete_task") && !names.includes("create_timebox"), "承認していない操作は見えない")

  const row = rows("myflow_ai_tokens")[0]
  assert.equal(row.allowed_modes, "private"); assert.ok(row.name.startsWith("OAuth: Claude")); assert.ok(row.expires_at)
  row.revoked_at = new Date().toISOString() // 取り消すと使えなくなる
  assert.equal((await toolNames(tok.json.access_token)).length, 0)
})

test("管理キーが違えば承認されない（コードは出ない）。失敗が続くとブロックされる", async () => {
  const c = (await register()).json.client_id as string
  const { challenge } = pkce()
  const base = { client_id: c, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", mode: "private", scope: "read" }
  const bad = await approve({ ...base, admin_key: "wrong" })
  assert.equal(bad.status, 200)
  assert.ok(!bad.headers.get("location"))
  for (let i = 0; i < 12; i++) await approve({ ...base, admin_key: "wrong" })
  assert.equal((await approve({ ...base, admin_key: ADMIN_KEY })).status, 429, "ブロック中は正しいキーでも通らない")
  assert.equal((await approve({ ...base, admin_key: ADMIN_KEY }, "198.51.100.9")).status, 303, "別の接続元は通る")
})

test("登録していないリダイレクト先・不正な client_id には、リダイレクトせずエラーを出す（攻撃者の URL へコードを渡さない）", async () => {
  const c = (await register()).json.client_id as string
  const { challenge } = pkce()
  const evil = await R.authorize.GET(new Request(authUrl({ client_id: c, redirect_uri: "https://evil.example/cb", code_challenge: challenge })))
  assert.equal(evil.status, 400)
  const forged = await R.authorize.GET(new Request(authUrl({ client_id: c.slice(0, -2) + "xx", redirect_uri: REDIRECT, code_challenge: challenge })))
  assert.equal(forged.status, 400)
  const post = await approve({ client_id: c, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256", admin_key: ADMIN_KEY, mode: "private" })
  assert.equal(post.status, 400); assert.ok(!post.headers.get("location"))
  assert.equal((await register(["http://evil.example/cb"])).status, 400, "http（ループバック以外）は登録できない")
  assert.equal((await register(["javascript:alert(1)"])).status, 400)
  assert.equal((await register([])).status, 400)
})

test("PKCE: S256 が必須。verifier が違う・コードが改ざん・期限切れ・別クライアント では交換できない", async () => {
  const c = (await register()).json.client_id as string
  const noPkce = await R.authorize.GET(new Request(`${BASE}/api/oauth/authorize?response_type=code&client_id=${c}&redirect_uri=${encodeURIComponent(REDIRECT)}`))
  assert.equal(noPkce.status, 400)
  const plain = await R.authorize.GET(new Request(authUrl({ client_id: c, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "plain" })))
  assert.equal(plain.status, 400)

  const g = await getCode()
  const code = new URL(g.res.headers.get("location")!).searchParams.get("code")!
  const base = { code, client_id: g.c, redirect_uri: REDIRECT }
  assert.equal((await exchange({ ...base, code_verifier: pkce().verifier })).json.error, "invalid_grant", "verifier 違い")
  assert.equal((await exchange({ ...base, code: code.slice(0, -2) + "xx", code_verifier: g.verifier })).json.error, "invalid_grant", "改ざん")
  assert.equal((await exchange({ ...base, redirect_uri: "https://claude.ai/other", code_verifier: g.verifier })).json.error, "invalid_grant", "redirect_uri 違い")
  const other = (await register(["https://claude.ai/other-client"])).json.client_id
  assert.equal((await exchange({ ...base, client_id: other, code_verifier: g.verifier })).json.error, "invalid_grant", "別クライアント")
  assert.equal(rows("myflow_ai_tokens").length, 0, "失敗では鍵は発行されない")

  const expired = O.sign({ t: "code", cid: g.c, uri: REDIRECT, cc: g.challenge, name: "Claude", modes: ["private"], scopes: ["read"] }, 600, Date.now() - 3600_000)
  assert.equal((await exchange({ code: expired, client_id: g.c, redirect_uri: REDIRECT, code_verifier: g.verifier })).json.error, "invalid_grant", "期限切れ")
  assert.equal((await exchange({ ...base, code_verifier: g.verifier })).status, 200, "正しい組み合わせなら交換できる")
})

test("承認画面の入力は検証される: カテゴリ未選択は不可、不正な scope は無視、read は常に付く。管理キー未設定なら全て停止", async () => {
  const none = await getCode({ mode: [] })
  assert.equal(none.res.status, 200, "カテゴリ無しは承認されない（画面に戻る）")
  const g = await getCode({ mode: ["private", "work", "bogus"], scope: ["task_add", "root", "delete"] })
  const code = new URL(g.res.headers.get("location")!).searchParams.get("code")!
  const tok = await exchange({ code, client_id: g.c, redirect_uri: REDIRECT, code_verifier: g.verifier })
  assert.equal(tok.json.scope, "read task_add delete")
  assert.equal(rows("myflow_ai_tokens")[0].allowed_modes, "private,work")

  delete process.env.MYFLOW_ADMIN_KEY
  assert.equal((await register()).status, 503)
  assert.equal((await R.authorize.GET(new Request(authUrl({ client_id: "x", redirect_uri: REDIRECT, code_challenge: "y" })))).status, 503)
  assert.equal((await exchange({ code: "x" })).status, 503)
})

test("同意画面は、クライアント名に含まれる HTML を無害化する", async () => {
  const res = await R.register.POST(new Request(`${BASE}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "<script>alert(1)</script>", redirect_uris: [REDIRECT] }) }))
  const c = (await res.json()).client_id
  const page = await (await R.authorize.GET(new Request(authUrl({ client_id: c, redirect_uri: REDIRECT, code_challenge: pkce().challenge })))).text()
  assert.ok(!page.includes("<script>alert(1)</script>"))
  assert.ok(page.includes("&lt;script&gt;"))
})
