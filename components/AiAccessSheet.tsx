"use client"

import { useCallback, useEffect, useState } from "react"
import { ALL_SCOPES, SCOPE_LABELS, type Mode, type Scope } from "@/lib/principal"
import { MODE_LABEL } from "./format"
import { useSheets } from "./sheets"
import { api, ApiError } from "./store"
import { Sheet } from "./ui"

interface TokenInfo { id: string; name: string; prefix: string; modes: Mode[]; scopes: Scope[]; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string }
interface AuditEvent { id: string; at: string; actor: string; type: string; mode: string | null; payload: Record<string, unknown> }

const KEY = "myflow.admin"
const PRESETS: { label: string; hint: string; scopes: Scope[] }[] = [
  { label: "閲覧・分析のみ", hint: "見るだけ。いちばん安全", scopes: ["read"] },
  { label: "計画の相談", hint: "閲覧 + タスク追加 + 予定変更 + 完了", scopes: ["read", "task_add", "schedule", "complete"] },
  { label: "すべて（削除を除く）", hint: "編集もできる", scopes: ["read", "task_add", "task_edit", "schedule", "complete"] },
]

const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—")
const statusOf = (t: TokenInfo) => (t.revoked_at ? "取り消し済み" : t.expires_at && Date.parse(t.expires_at) <= Date.now() ? "期限切れ" : "有効")

function Picker({ modes, scopes, onModes, onScopes }: { modes: Mode[]; scopes: Scope[]; onModes: (m: Mode[]) => void; onScopes: (s: Scope[]) => void }) {
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])
  return (
    <>
      <div className="field">
        <span className="label">アクセスを許可するカテゴリ</span>
        <div className="chips">
          {(["private", "work"] as Mode[]).map(m => <button key={m} type="button" className="chip" aria-pressed={modes.includes(m)} onClick={() => onModes(toggle(modes, m))}>{MODE_LABEL[m]}</button>)}
        </div>
        {modes.includes("work") && <div className="notice warn" style={{ marginTop: 10 }}>仕事のデータには、会社の機密が含まれる可能性があります。必要なときだけ許可してください。</div>}
        {modes.length === 0 && <p className="hint" style={{ color: "var(--danger)" }}>カテゴリを1つも選ばないと、何も見えません。</p>}
      </div>
      <div className="field">
        <span className="label">許可する操作</span>
        <div className="chips" style={{ marginBottom: 8 }}>
          {PRESETS.map(p => <button key={p.label} type="button" className="chip" title={p.hint} aria-pressed={p.scopes.length === scopes.length && p.scopes.every(s => scopes.includes(s))} onClick={() => onScopes(p.scopes)}>{p.label}</button>)}
        </div>
        <div className="chips">
          {ALL_SCOPES.map(s => <button key={s} type="button" className="chip" aria-pressed={scopes.includes(s)} onClick={() => onScopes(toggle(scopes, s))}>{SCOPE_LABELS[s]}</button>)}
        </div>
        {scopes.includes("delete") && <div className="notice warn" style={{ marginTop: 10 }}>削除を許可すると、AI がタスクを消せるようになります（実行前に必ず確認を挟む作りです）。</div>}
      </div>
    </>
  )
}

export function AiAccessSheet() {
  const sheets = useSheets()
  const [adminKey, setAdminKey] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null)
  const [audit, setAudit] = useState<AuditEvent[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  // 新規発行フォーム
  const [name, setName] = useState("Claude")
  const [modes, setModes] = useState<Mode[]>(["private"])
  const [scopes, setScopes] = useState<Scope[]>(["read", "task_add", "schedule", "complete"])
  const [days, setDays] = useState<string>("")
  // 編集フォーム
  const [eModes, setEModes] = useState<Mode[]>([])
  const [eScopes, setEScopes] = useState<Scope[]>([])

  useEffect(() => { try { setAdminKey(sessionStorage.getItem(KEY)) } catch { /* 保存できない環境では毎回入力 */ } }, [])
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  const auth = useCallback(() => ({ Authorization: `Bearer ${adminKey}` }), [adminKey])

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) { try { sessionStorage.removeItem(KEY) } catch { /* 無視 */ } setAdminKey(null); setTokens(null); setErr("管理キーが違います。") }
    else setErr(e instanceof ApiError ? e.message : "通信に失敗しました。")
  }, [])

  const load = useCallback(async () => {
    if (!adminKey) return
    setErr(null)
    try {
      const t = await api<{ tokens: TokenInfo[] }>("/api/admin/ai-tokens", { headers: auth() })
      setTokens(t.tokens)
      const a = await api<{ events: AuditEvent[] }>("/api/admin/audit?ai=1&limit=30", { headers: auth() })
      setAudit(a.events)
    } catch (e) { fail(e) }
  }, [adminKey, auth, fail])
  useEffect(() => { load() }, [load])

  const connect = () => {
    const k = keyInput.trim()
    if (!k) return
    try { sessionStorage.setItem(KEY, k) } catch { /* 無視 */ }
    setAdminKey(k); setKeyInput("")
  }

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      const body: Record<string, unknown> = { name: name.trim(), modes, scopes }
      if (days) body.expires_in_days = Number(days)
      const r = await api<{ token: string; name: string }>("/api/admin/ai-tokens", { method: "POST", body, headers: auth() })
      setCreated({ token: r.token, name: r.name }); setCopied(false)
      await load()
    } catch (e) { fail(e) }
    setBusy(false)
  }

  const revoke = async (t: TokenInfo) => {
    if (!confirm(`「${t.name}」を取り消しますか？\nそのトークンを使っている AI は、すぐに使えなくなります。`)) return
    try { await api(`/api/admin/ai-tokens/${t.id}`, { method: "DELETE", headers: auth() }); await load() } catch (e) { fail(e) }
  }

  const saveEdit = async (t: TokenInfo) => {
    try { await api(`/api/admin/ai-tokens/${t.id}`, { method: "PATCH", body: { modes: eModes, scopes: eScopes }, headers: auth() }); setEditing(null); await load() } catch (e) { fail(e) }
  }

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true) } catch { setErr("コピーできませんでした。手で選んでコピーしてください。") }
  }

  const mcpUrl = `${origin}/api/connect/mcp`

  return (
    <Sheet title="AI 連携" onClose={sheets.close} wide footer={<button type="button" className="btn" onClick={sheets.close}>閉じる</button>}>
      <p className="hint" style={{ marginBottom: 14 }}>
        Claude や ChatGPT から MyFlow のタスクを見たり、追加・変更したりするための「合鍵」を管理します。合鍵ごとに、見せるカテゴリ（仕事／プライベート）と許す操作を決められ、いつでも取り消せます。
      </p>
      {err && <div className="notice danger" role="alert">{err}</div>}

      {!adminKey && (
        <div className="field">
          <label className="label" htmlFor="ai-admin">管理キー</label>
          <div className="adder">
            <input id="ai-admin" type="password" className="input" autoComplete="off" value={keyInput} placeholder="サーバーに設定した MYFLOW_ADMIN_KEY" onChange={e => setKeyInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") connect() }} />
            <button type="button" className="btn primary" disabled={!keyInput.trim()} onClick={connect}>開く</button>
          </div>
          <p className="hint">合鍵の発行・取り消しができる人だけが知っているキーです。このブラウザを閉じるまでの間だけ覚えます。サーバーに MYFLOW_ADMIN_KEY を設定していない場合は、先に設定してください。</p>
        </div>
      )}

      {adminKey && created && (
        <div className="notice info" role="status" style={{ display: "block" }}>
          <b>「{created.name}」の合鍵を発行しました。この画面を閉じると、二度と表示できません。</b>
          <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
            <input className="input" readOnly value={created.token} aria-label="発行された合鍵" onFocus={e => e.currentTarget.select()} />
            <button type="button" className="btn primary" onClick={() => copy(created.token)}>{copied ? "コピーしました" : "コピー"}</button>
          </div>
          <div className="hint" style={{ color: "inherit" }}>接続先（MCP サーバー）: <code>{mcpUrl}</code></div>
          <details className="fold-box" style={{ marginTop: 8 }}>
            <summary>Claude Code につなぐコマンド</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12.5, background: "var(--surface)", padding: 10, borderRadius: 8, margin: "6px 0" }}>{`claude mcp add --transport http --scope user myflow ${mcpUrl} --header "Authorization: Bearer ${created.token}"`}</pre>
            <button type="button" className="btn sm" onClick={() => copy(`claude mcp add --transport http --scope user myflow ${mcpUrl} --header "Authorization: Bearer ${created.token}"`)}>コマンドをコピー</button>
          </details>
          <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={() => setCreated(null)}>控えたので閉じる</button>
        </div>
      )}

      {adminKey && tokens && (
        <>
          <div className="section-title" style={{ margin: "8px 0 4px" }}>発行済みの合鍵</div>
          <ul className="list" style={{ marginBottom: 20 }}>
            {tokens.length === 0 && <li className="empty" style={{ padding: "12px 2px" }}>まだありません。下から発行できます。</li>}
            {tokens.map(t => (
              <li key={t.id} className="row" style={{ display: "block" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <b>{t.name}</b><code style={{ fontSize: 12.5, color: "var(--muted)" }}>{t.prefix}…</code>
                  <span className="tag" style={statusOf(t) !== "有効" ? { background: "var(--danger-soft)", color: "var(--danger)" } : undefined}>{statusOf(t)}</span>
                </div>
                <div className="row-meta">
                  <span>カテゴリ: {t.modes.length ? t.modes.map(m => MODE_LABEL[m]).join("・") : "なし"}</span>
                  <span>操作: {t.scopes.map(s => SCOPE_LABELS[s]).join("・") || "なし"}</span>
                  <span>最終利用: {fmtAt(t.last_used_at)}</span>
                  {t.expires_at && <span>期限: {fmtAt(t.expires_at)}</span>}
                </div>
                {!t.revoked_at && editing !== t.id && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    <button type="button" className="btn sm" onClick={() => { setEditing(t.id); setEModes(t.modes); setEScopes(t.scopes) }}>権限を変更</button>
                    <button type="button" className="btn sm danger" onClick={() => revoke(t)}>取り消す</button>
                  </div>
                )}
                {editing === t.id && (
                  <div style={{ marginTop: 10 }}>
                    <Picker modes={eModes} scopes={eScopes} onModes={setEModes} onScopes={setEScopes} />
                    <div className="chips"><button type="button" className="btn sm primary" onClick={() => saveEdit(t)}>保存</button><button type="button" className="btn sm" onClick={() => setEditing(null)}>キャンセル</button></div>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="section-title" style={{ marginBottom: 8 }}>新しい合鍵を発行</div>
          <div className="field"><label className="label" htmlFor="ai-name">名前（どの AI 用か分かるように）</label><input id="ai-name" className="input" value={name} maxLength={60} onChange={e => setName(e.target.value)} /></div>
          <Picker modes={modes} scopes={scopes} onModes={setModes} onScopes={setScopes} />
          <div className="field">
            <label className="label" htmlFor="ai-days">有効期限</label>
            <select id="ai-days" className="select" value={days} onChange={e => setDays(e.target.value)}>
              <option value="">なし（取り消すまで有効）</option><option value="30">30日</option><option value="90">90日</option><option value="365">1年</option>
            </select>
          </div>
          <button type="button" className="btn primary" disabled={busy || !name.trim() || scopes.length === 0 || modes.length === 0} onClick={create}>合鍵を発行する</button>

          <details className="fold-box" style={{ marginTop: 24 }}>
            <summary>操作履歴（AI からの操作・合鍵の発行/取り消し）</summary>
            <ul className="list" style={{ marginTop: 6 }}>
              {(audit ?? []).length === 0 && <li className="empty" style={{ padding: "10px 2px" }}>まだ記録がありません。</li>}
              {(audit ?? []).map(e => (
                <li key={e.id} className="row" style={{ padding: "7px 2px", fontSize: 13.5 }}>
                  <span className="num" style={{ color: "var(--muted)", width: 96, flex: "none" }}>{fmtAt(e.at)}</span>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                    <b>{e.actor}</b>　{e.type === "ai_call" ? `${String(e.payload.tool)}${e.payload.ok === false ? `（失敗: ${String(e.payload.error)}）` : ""}` : e.type}{e.mode ? `　[${MODE_LABEL[e.mode as Mode] ?? e.mode}]` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <p className="hint" style={{ marginTop: 14 }}>
            接続のしかた: Claude Code は上の「コマンド」で、ChatGPT はコネクタの「トークン（APIキー）」欄に合鍵を入れます。claude.ai やスマホ版は、リクエストヘッダーの設定が使えるアカウントのみ対応です。
          </p>
        </>
      )}
    </Sheet>
  )
}
