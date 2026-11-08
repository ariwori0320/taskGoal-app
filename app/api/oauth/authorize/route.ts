import { safeEqual } from "@/lib/ai-auth"
import { CODE_TTL_SEC, esc, isAllowedRedirect, oauthEnabled, oauthError, sign, verify } from "@/lib/oauth"
import { isMode, isScope } from "@/lib/principal"
import { blockedSeconds, clearFailures, clientKey, recordFailure } from "@/lib/throttle"

export const dynamic = "force-dynamic"

interface ClientInfo { name: string; uris: string[] }
interface Params { client_id: string; redirect_uri: string; state: string; code_challenge: string }

const SCOPES: { v: string; label: string; checked?: boolean; locked?: boolean }[] = [
  { v: "read", label: "閲覧・分析", checked: true, locked: true },
  { v: "task_add", label: "タスクの追加" },
  { v: "task_edit", label: "タスクの編集" },
  { v: "schedule", label: "予定の変更" },
  { v: "complete", label: "完了処理" },
  { v: "delete", label: "削除（実行前に必ず確認を挟みます）" },
]

const STYLE = "body{font:16px/1.6 system-ui,sans-serif;background:#F7F6F2;color:#28372F;margin:0;padding:24px 16px}main{max-width:480px;margin:0 auto}h1{font-size:20px}fieldset{border:1px solid #E5E8E0;border-radius:8px;margin:16px 0;padding:8px 14px;background:#fff}legend{font-weight:600;padding:0 6px}label{display:block;padding:4px 0}.warn{color:#8a5a00;font-size:14px}.err{color:#b3261e}input[type=password]{width:100%;padding:10px;border:1px solid #7C8F81;border-radius:6px;font-size:16px;box-sizing:border-box}button{background:#48745D;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;cursor:pointer}small{color:#5F6F66}"

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>MyFlow への接続を許可</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } },
  )

/** client_id と redirect_uri を検証する。不正なら、リダイレクトせず画面にエラーを出す（攻撃者の URL へ飛ばさない） */
function validate(p: Record<string, string | null>): { ok: true; client: ClientInfo; params: Params } | { ok: false; message: string } {
  const client = verify<ClientInfo & Record<string, unknown>>(p.client_id, "client")
  if (!client || !Array.isArray(client.uris)) return { ok: false, message: "クライアントが登録されていません（client_id が不正です）。" }
  if (!isAllowedRedirect(p.redirect_uri) || !client.uris.includes(p.redirect_uri)) return { ok: false, message: "リダイレクト先が登録されたものと一致しません。" }
  if (p.response_type && p.response_type !== "code") return { ok: false, message: "response_type は code のみ対応しています。" }
  if (!p.code_challenge || p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return { ok: false, message: "PKCE（S256）が必要です。" }
  return { ok: true, client: { name: client.name, uris: client.uris }, params: { client_id: p.client_id as string, redirect_uri: p.redirect_uri, state: p.state ?? "", code_challenge: p.code_challenge } }
}

function form(client: ClientInfo, p: Params, error?: string) {
  const host = new URL(p.redirect_uri).host
  const scopes = SCOPES.map(s => `<label><input type="checkbox" name="scope" value="${s.v}"${s.checked ? " checked" : ""}${s.locked ? " disabled" : ""}> ${esc(s.label)}</label>`).join("\n")
  return html(`<h1>「${esc(client.name)}」が MyFlow への接続を求めています</h1>
<p><small>接続先: ${esc(host)}。心当たりがなければ、この画面を閉じてください。</small></p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/api/oauth/authorize">
<input type="hidden" name="client_id" value="${esc(p.client_id)}"><input type="hidden" name="redirect_uri" value="${esc(p.redirect_uri)}">
<input type="hidden" name="state" value="${esc(p.state)}"><input type="hidden" name="code_challenge" value="${esc(p.code_challenge)}"><input type="hidden" name="code_challenge_method" value="S256">
<fieldset><legend>アクセスを許可するカテゴリ</legend>
<label><input type="checkbox" name="mode" value="private" checked> プライベート</label>
<label><input type="checkbox" name="mode" value="work"> 仕事 <span class="warn">（会社の機密が含まれる可能性があります。必要なときだけ）</span></label></fieldset>
<fieldset><legend>許可する操作</legend>
${scopes}
<input type="hidden" name="scope" value="read"></fieldset>
<label for="k"><b>管理キー</b>（承認できるのは、管理キーを知っている人だけです）</label>
<input id="k" type="password" name="admin_key" autocomplete="off" required>
<p><button type="submit">許可する</button></p></form>`)
}

export async function GET(req: Request) {
  if (!oauthEnabled()) return html("<h1>OAuth は未設定です</h1><p>サーバーに MYFLOW_ADMIN_KEY が設定されていません。</p>", 503)
  const sp = new URL(req.url).searchParams
  const v = validate({
    client_id: sp.get("client_id"), redirect_uri: sp.get("redirect_uri"), response_type: sp.get("response_type"),
    state: sp.get("state"), code_challenge: sp.get("code_challenge"), code_challenge_method: sp.get("code_challenge_method"),
  })
  if (!v.ok) return html(`<h1>接続できません</h1><p class="err">${esc(v.message)}</p>`, 400)
  return form(v.client, v.params)
}

export async function POST(req: Request) {
  if (!oauthEnabled()) return oauthError("server_error", "OAuth は未設定です", 503)
  const fd = await req.formData().catch(() => null)
  if (!fd) return html(`<h1>接続できません</h1><p class="err">フォームを読み取れませんでした。</p>`, 400)
  const g = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : null)
  const v = validate({
    client_id: g("client_id"), redirect_uri: g("redirect_uri"), state: g("state"),
    code_challenge: g("code_challenge"), code_challenge_method: g("code_challenge_method"),
  })
  if (!v.ok) return html(`<h1>接続できません</h1><p class="err">${esc(v.message)}</p>`, 400)

  const who = clientKey(req)
  if (blockedSeconds(who) > 0) return html(`<h1>しばらくお待ちください</h1><p class="err">試行回数が多すぎます。</p>`, 429)
  if (!safeEqual(g("admin_key") ?? "", process.env.MYFLOW_ADMIN_KEY ?? "")) {
    recordFailure(who)
    return form(v.client, v.params, "管理キーが違います。")
  }
  clearFailures(who)

  const modes = fd.getAll("mode").filter((m): m is string => typeof m === "string" && isMode(m))
  const scopes = Array.from(new Set(fd.getAll("scope").filter((s): s is string => typeof s === "string" && isScope(s))))
  if (modes.length === 0) return form(v.client, v.params, "カテゴリを1つ以上選んでください。")
  if (!scopes.includes("read")) scopes.unshift("read")

  const code = sign({ t: "code", cid: v.params.client_id, uri: v.params.redirect_uri, cc: v.params.code_challenge, name: v.client.name, modes, scopes }, CODE_TTL_SEC)
  const dest = new URL(v.params.redirect_uri)
  dest.searchParams.set("code", code)
  if (v.params.state) dest.searchParams.set("state", v.params.state)
  return new Response(null, { status: 303, headers: { Location: dest.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } })
}
