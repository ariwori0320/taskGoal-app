"use client"

import { useMemo, useState } from "react"
import { parseTags } from "./format"
import { useSheets } from "./sheets"
import { useStore } from "./store"

export default function MemosView() {
  const s = useStore()
  const sheets = useSheets()
  const [q, setQ] = useState("")
  const [tag, setTag] = useState<string | null>(null)

  const allTags = useMemo(() => Array.from(new Set(s.memos.flatMap(m => parseTags(m.tags)))).sort(), [s.memos])
  const needle = q.trim().toLowerCase()
  const list = s.memos.filter(m => {
    if (tag && !parseTags(m.tags).includes(tag)) return false
    if (!needle) return true
    return (m.title || "").toLowerCase().includes(needle) || (m.content || "").toLowerCase().includes(needle) || (m.tags || "").toLowerCase().includes(needle)
  })

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">メモ</h1>
        <button type="button" className="btn primary" onClick={() => sheets.open({ kind: "memo" })}>＋ 新しいメモ</button>
      </div>

      <div className="adder">
        <input className="input" type="search" aria-label="メモを検索" placeholder="タイトル・本文・タグで検索" value={q} onChange={e => setQ(e.target.value)} />
        {(q || tag) && <button type="button" className="btn" onClick={() => { setQ(""); setTag(null) }}>クリア</button>}
      </div>
      {allTags.length > 0 && (
        <div className="chips" style={{ margin: "10px 0 6px" }} role="group" aria-label="タグで絞り込む">
          {allTags.map(t => <button key={t} type="button" className="chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>{t}</button>)}
        </div>
      )}

      <div className="list" style={{ marginTop: 10 }}>
        {s.loading && s.memos.length === 0 && <p className="empty">読み込み中…</p>}
        {!s.loading && s.memos.length === 0 && <p className="empty">メモはまだありません。</p>}
        {!s.loading && s.memos.length > 0 && list.length === 0 && <p className="empty">該当するメモがありません。</p>}
        {list.map(m => (
          <button key={m.id} type="button" className="memo-row" onClick={() => sheets.open({ kind: "memo", memoId: m.id })}>
            <div className="t">{m.title || "（無題）"}</div>
            {parseTags(m.tags).length > 0 && <div style={{ margin: "3px 0" }}>{parseTags(m.tags).map(t => <span key={t} className="tag">{t}</span>)}</div>}
            <div className="p">{m.content}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
