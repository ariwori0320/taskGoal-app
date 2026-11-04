"use client"

import { useEffect, useState } from "react"
import { fmtMdDow } from "@/lib/time"
import { relDay } from "./format"
import { useSheets } from "./sheets"
import { useStore } from "./store"

function YearBanner({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  if (editing) {
    return (
      <div style={{ padding: "14px 4px", borderBottom: "1px solid var(--line)" }}>
        <label className="label" htmlFor="yg">今年の目標</label>
        <textarea id="yg" autoFocus className="textarea" rows={2} value={v} placeholder="今年はどんな一年にしたいですか" onChange={e => setV(e.target.value)} />
        <div className="chips" style={{ marginTop: 8 }}>
          <button type="button" className="btn sm primary" onClick={() => { onSave(v); setEditing(false) }}>保存</button>
          <button type="button" className="btn sm" onClick={() => { setV(value); setEditing(false) }}>キャンセル</button>
        </div>
      </div>
    )
  }
  return (
    <button type="button" className="banner" style={{ width: "100%" }} onClick={() => setEditing(true)} aria-label="今年の目標を編集">
      <span className="k">今年の目標</span>
      <span className={`v${value ? "" : " placeholder"}`}>{value || "タップして設定"}</span>
    </button>
  )
}

export default function GoalsView() {
  const s = useStore()
  const sheets = useSheets()
  const [text, setText] = useState("")
  const [due, setDue] = useState("")
  const [busy, setBusy] = useState(false)

  const add = async () => {
    const name = text.trim()
    if (!name || busy) return
    setBusy(true)
    if (await s.addGoal(name, due)) { setText(""); setDue("") }
    setBusy(false)
  }

  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">目標</h1></div>
      <YearBanner value={s.yearGoal} onSave={s.saveYearGoal} />

      <div className="adder" style={{ margin: "22px 0 8px" }}>
        <input className="input" aria-label="新しい目標" placeholder="新しい目標を追加" value={text} maxLength={200}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add() }} />
        <input type="date" className="input" aria-label="期日" style={{ maxWidth: 160 }} value={due} onChange={e => setDue(e.target.value)} />
        <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={add}>追加</button>
      </div>

      <div>
        {s.loading && s.goals.length === 0 && <p className="empty">読み込み中…</p>}
        {!s.loading && s.goals.length === 0 && <p className="empty">目標はまだありません。</p>}
        {s.goals.map(g => (
          <div key={g.id} className="goal-row">
            <div className="goal-top">
              <span className="goal-name" style={g.pct >= 100 ? { color: "var(--done)", textDecoration: "line-through" } : undefined}>{g.text}</span>
              <span className="goal-pct num">{g.pct}%</span>
              <button type="button" className="btn sm quiet" aria-label={`${g.text} を編集`} onClick={() => sheets.open({ kind: "goal", goalId: g.id })}>編集</button>
            </div>
            <div className="meter" style={{ ["--pct" as string]: `${g.pct}%` }}><i /></div>
            <input type="range" min={0} max={100} value={g.pct} aria-label={`${g.text} の進捗`} onChange={e => s.setGoalPct(g.id, Number(e.target.value))} />
            <div className="goal-meta">
              {g.due_date && <span>期日 {fmtMdDow(g.due_date)}（{relDay(g.due_date, s.today)}）</span>}
              {(g.linked_total ?? 0) > 0 && <span className="num">紐づくタスク {g.linked_done}/{g.linked_total} 完了</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
