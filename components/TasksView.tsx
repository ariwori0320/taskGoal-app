"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { autoCompare, inDateRange, isTaskDone, manualCompare, nextRecurrenceText, recurrenceLabel } from "@/lib/task-utils"
import { DAY_LABELS, fmtMdDow } from "@/lib/time"
import type { TaskRow } from "@/lib/types"
import { fmtDuration, relDay, renderWithLinks, windowText } from "./format"
import { useSheets } from "./sheets"
import { useStore, type Store } from "./store"
import { Check, Icon, Menu } from "./ui"

type Filter = "active" | "done"
type Sort = "manual" | "auto"

// ---------- 長押し→ドラッグでの並び替え（マウス・タッチ共通） ----------

function useLongPressReorder(enabled: boolean, onReorder: (src: string, over: string) => void) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const dragRef = useRef<string | null>(null)
  const overRef = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const cleanup = useRef<(() => void) | null>(null)
  const suppress = useRef(false)
  const reorderRef = useRef(onReorder); reorderRef.current = onReorder

  const reset = useCallback((didDrag: boolean) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    cleanup.current?.(); cleanup.current = null
    if (didDrag) { suppress.current = true; setTimeout(() => { suppress.current = false }, 300) }
    dragRef.current = null; overRef.current = null
    setDragId(null); setOverId(null)
  }, [])

  const pointAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-root-id]")?.getAttribute("data-root-id") ?? null

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    if ((e.target as HTMLElement).closest("button, input, textarea, a, select, [role=checkbox], [role=menu]")) return
    reset(false)
    start.current = { x: e.clientX, y: e.clientY }
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) {
        // 長押しが確定する前に動いた = スクロールしたい意図。ドラッグはしない
        if (Math.abs(ev.clientX - start.current.x) > 8 || Math.abs(ev.clientY - start.current.y) > 8) reset(false)
        return
      }
      const over = pointAt(ev.clientX, ev.clientY)
      if (over !== overRef.current) { overRef.current = over; setOverId(over) }
    }
    const onUp = (ev: PointerEvent) => {
      const src = dragRef.current
      const over = src ? pointAt(ev.clientX, ev.clientY) : null
      reset(!!src)
      if (src && over && over !== src) reorderRef.current(src, over)
    }
    const onCancel = () => reset(!!dragRef.current) // OS のジェスチャ等で中断されたとき、ドラッグ状態を残さない
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    cleanup.current = () => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel)
    }
    timer.current = setTimeout(() => { dragRef.current = id; setDragId(id); navigator.vibrate?.(15) }, 280)
  }, [reset])

  useEffect(() => {
    const block = (ev: TouchEvent) => { if (dragRef.current) ev.preventDefault() } // ドラッグ中はスクロールさせない
    document.addEventListener("touchmove", block, { passive: false })
    return () => document.removeEventListener("touchmove", block)
  }, [])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); cleanup.current?.() }, [])

  return { dragId, overId, onPointerDown: enabled ? onPointerDown : undefined, wasDragged: () => suppress.current }
}

// ---------- 名前のその場編集 ----------

function Rename({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <input
      autoFocus className="input sm" aria-label="タスク名を編集" value={v} maxLength={300}
      onChange={e => setV(e.target.value)} onBlur={() => onSave(v)}
      onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") onSave(v); if (e.key === "Escape") onCancel() }}
    />
  )
}

// ---------- 1行（親子は再帰） ----------

interface NodeProps {
  task: TaskRow
  depth: number
  s: Store
  collapsed: Set<string>
  toggleFold: (id: string) => void
  editingId: string | null
  setEditingId: (id: string | null) => void
  longPress: ReturnType<typeof useLongPressReorder>
  manual: boolean
}

function TaskNode({ task: t, depth, s, collapsed, toggleFold, editingId, setEditingId, longPress, manual }: NodeProps) {
  const sheets = useSheets()
  const kids = s.childrenOf.get(t.id) ?? []
  const isOpen = !collapsed.has(t.id)
  const done = isTaskDone(t, s.today)
  const planned = (s.boxesByTask.get(t.id) ?? []).filter(b => b.status === "planned").sort((a, b) => a.date.localeCompare(b.date) || a.window_start - b.window_start)
  const kidsDone = kids.filter(k => isTaskDone(k, s.today)).length
  const isRoot = depth === 0
  const leaving = isRoot && done && s.flash.has(t.id)

  const del = async () => {
    const needs = kids.length > 0 || planned.length > 0
    if (needs && !confirm(`「${t.text}」を削除しますか？\n${kids.length > 0 ? "サブタスクと" : ""}予定も一緒に消えます。`)) return
    await s.deleteTask(t.id)
  }

  return (
    <li>
      <div
        className={`row${depth > 0 ? " is-child" : ""}${longPress.dragId === t.id ? " is-dragging" : ""}${isRoot && longPress.overId === t.id && longPress.dragId !== t.id ? " is-drop" : ""}${leaving ? " is-leaving" : ""}`}
        {...(isRoot && manual ? { "data-root-id": t.id } : {})}
        onPointerDown={isRoot && manual ? e => longPress.onPointerDown?.(e, t.id) : undefined}
        style={isRoot && manual ? { touchAction: "pan-y", userSelect: "none" } : undefined}
      >
        {kids.length > 0
          ? <button type="button" className="fold" aria-expanded={isOpen} aria-label={isOpen ? "サブタスクを折りたたむ" : "サブタスクを開く"} onClick={() => toggleFold(t.id)}>▶</button>
          : <span className="fold-spacer" />}
        <Check small={depth > 0} checked={done} label={`${t.text} を${done ? "未完了に戻す" : "完了にする"}`} onChange={() => s.toggleTask(t)} />
        <div className="row-main">
          {editingId === t.id ? (
            <Rename initial={t.text} onCancel={() => setEditingId(null)} onSave={v => { setEditingId(null); if (v.trim() && v.trim() !== t.text) s.saveTask(t.id, { text: v.trim() }) }} />
          ) : (
            <span className={`row-title${done ? " is-done" : ""}`} onClick={() => { if (!longPress.wasDragged()) setEditingId(t.id) }} title="クリックで名前を編集">
              {t.priority === "high" && <i className="dot high" title="優先度 高" />}{t.priority === "low" && <i className="dot low" title="優先度 低" />}{t.text}
            </span>
          )}
          <div className="row-meta">
            {t.is_recurring ? <span>{recurrenceLabel(t)}の繰り返し・次回 {nextRecurrenceText(t, s.today)}</span> : <>
              {t.start_date && t.due_date && <span>{fmtMdDow(t.start_date)} 〜 {fmtMdDow(t.due_date)}</span>}
              {t.start_date && !t.due_date && <span>{fmtMdDow(t.start_date)} から</span>}
              {t.due_date && !t.start_date && <span className={!done && t.due_date < s.today ? "late" : undefined}>期限 {fmtMdDow(t.due_date)}（{relDay(t.due_date, s.today)}）</span>}
              {t.start_date && t.due_date && !done && t.due_date < s.today && <span className="late">{relDay(t.due_date, s.today)}</span>}
            </>}
            {t.estimate_minutes ? <span>{fmtDuration(t.estimate_minutes)}</span> : null}
            {planned[0] && <span>予定 {fmtMdDow(planned[0].date)} {windowText(s.settings, planned[0].window_start, planned[0].window_end, true).split(" ")[0]}{planned.length > 1 ? ` ほか${planned.length - 1}` : ""}</span>}
            {kids.length > 0 && <span>サブ {kidsDone}/{kids.length}</span>}
          </div>
          {t.memo && <div className="row-meta" style={{ whiteSpace: "pre-wrap", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{renderWithLinks(t.memo)}</div>}
        </div>
        <div className="row-actions">
          {depth < 2 && <button type="button" className="btn icon" aria-label={`${t.text} にサブタスクを追加`} title="サブタスクを追加" onClick={() => sheets.open({ kind: "edit", parentId: t.id })}><Icon name="plus" /></button>}
          <Menu label={`${t.text} の操作`} items={[
            { label: "編集", onClick: () => sheets.open({ kind: "edit", taskId: t.id }) },
            ...(!t.is_recurring && !done ? [{ label: "予定に入れる", onClick: () => sheets.open({ kind: "schedule", taskId: t.id }) }] : []),
            { label: "詳細を見る", onClick: () => sheets.open({ kind: "detail", taskId: t.id }) },
            { label: "削除", onClick: del, danger: true, divider: false },
          ]} />
        </div>
      </div>
      {kids.length > 0 && isOpen && (
        <ul className="tree">
          {kids.map(k => <TaskNode key={k.id} task={k} depth={depth + 1} s={s} collapsed={collapsed} toggleFold={toggleFold} editingId={editingId} setEditingId={setEditingId} longPress={longPress} manual={manual} />)}
        </ul>
      )}
    </li>
  )
}

// ---------- 画面 ----------

export default function TasksView() {
  const s = useStore()
  const [filter, setFilter] = useState<Filter>("active")
  const [sort, setSort] = useState<Sort>("auto")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [range, setRange] = useState({ from: "", to: "" })
  const [editingId, setEditingId] = useState<string | null>(null)
  const prefs = useRef(false)

  // 追加欄
  const [text, setText] = useState("")
  const [priority, setPriority] = useState<"high" | "mid" | "low">("mid")
  const [startD, setStartD] = useState("")
  const [dueD, setDueD] = useState("")
  const [est, setEst] = useState("")
  const [rec, setRec] = useState(false)
  const [days, setDays] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const adding = useRef(false)

  useEffect(() => {
    try {
      const so = localStorage.getItem(s.sortKey); if (so === "manual" || so === "auto") setSort(so)
      const fi = localStorage.getItem(s.filterKey); if (fi === "active" || fi === "done") setFilter(fi)
      const fo = JSON.parse(localStorage.getItem(s.foldKey) || "[]"); if (Array.isArray(fo)) setCollapsed(new Set(fo))
    } catch { /* 保存された表示設定が読めなくても既定で動く */ }
    prefs.current = true
  }, [s.sortKey, s.filterKey, s.foldKey])
  useEffect(() => {
    if (!prefs.current) return
    try {
      localStorage.setItem(s.sortKey, sort); localStorage.setItem(s.filterKey, filter)
      localStorage.setItem(s.foldKey, JSON.stringify(Array.from(collapsed)))
    } catch { /* 保存できなくても動作には影響しない */ }
  }, [sort, filter, collapsed, s.sortKey, s.filterKey, s.foldKey])

  const roots = useMemo(() => s.tasks.filter(t => !t.parent_id), [s.tasks])
  const sortedRoots = useMemo(() => [...roots].sort(sort === "auto" ? autoCompare : manualCompare), [roots, sort])
  const ranged = sortedRoots.filter(t => inDateRange(t, range.from, range.to))
  const visible = ranged.filter(t => (filter === "done" ? isTaskDone(t, s.today) : !isTaskDone(t, s.today) || s.flash.has(t.id)))
  const manual = sort === "manual"

  const longPress = useLongPressReorder(manual, (src, over) => { s.reorderTasks(src, over, visible, sortedRoots) })
  const toggleFold = (id: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const estNum = est.trim() === "" ? null : Number(est)
  const estBad = estNum !== null && (!Number.isInteger(estNum) || estNum < 1 || estNum > 1440)
  const dateBad = !!startD && !!dueD && startD > dueD

  const add = async () => {
    const name = text.trim()
    if (!name || adding.current || estBad || dateBad) return
    adding.current = true; setBusy(true)
    const body: Record<string, unknown> = { text: name, priority }
    if (startD) body.start_date = startD
    if (dueD) body.due_date = dueD
    if (estNum !== null) body.estimate_minutes = estNum
    if (rec) { body.is_recurring = true; body.recurring_days = days.join(",") }
    const row = await s.addTask(body)
    if (row) { setText(""); setPriority("mid"); setStartD(""); setDueD(""); setEst(""); setRec(false); setDays([]) }
    adding.current = false; setBusy(false)
  }

  const activeCount = roots.filter(t => !isTaskDone(t, s.today)).length

  return (
    <div className="page">
      <div className="page-head"><h1 className="page-title">タスク</h1><span className="page-sub num">未完了 {activeCount}</span></div>

      <div className="adder">
        <input className="input" aria-label="タスクを追加" placeholder="タスクを追加（名前だけでOK）" value={text} maxLength={300}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add() }} />
        <button type="button" className="btn primary" disabled={!text.trim() || busy || estBad || dateBad} onClick={add}>追加</button>
      </div>
      <details className="fold-box">
        <summary>くわしく設定する（優先度・日付・所要時間・繰り返し）</summary>
        <div className="adder-more">
          <div className="chips" role="group" aria-label="優先度">
            {([["high", "高"], ["mid", "中"], ["low", "低"]] as const).map(([v, l]) => <button key={v} type="button" className="chip" aria-pressed={priority === v} onClick={() => setPriority(v)}>優先度 {l}</button>)}
          </div>
          <div className="field-row">
            <div><label className="label" htmlFor="ad-start">開始日</label><input id="ad-start" type="date" className="input" value={startD} onChange={e => setStartD(e.target.value)} /></div>
            <div><label className="label" htmlFor="ad-due">期限日</label><input id="ad-due" type="date" className="input" value={dueD} onChange={e => setDueD(e.target.value)} /></div>
          </div>
          {dateBad && <div className="notice danger" role="alert">開始日は期限日より前にしてください</div>}
          <div>
            <label className="label" htmlFor="ad-est">所要時間（任意・分）</label>
            <input id="ad-est" type="number" className="input" min={1} max={1440} placeholder="例 30" value={est} style={{ maxWidth: 140 }} onChange={e => setEst(e.target.value)} />
            {estBad && <p className="hint" style={{ color: "var(--danger)" }}>1〜1440分の整数で入力してください</p>}
          </div>
          <div>
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={rec} onChange={e => { setRec(e.target.checked); if (!e.target.checked) setDays([]) }} /> 繰り返す</label>
            {rec && (
              <div className="chips" style={{ marginTop: 8 }}>
                <button type="button" className="chip" aria-pressed={days.length === 0} onClick={() => setDays([])}>毎日</button>
                {[1, 2, 3, 4, 5, 6, 0].map(d => <button key={d} type="button" className="chip" aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d])}>{DAY_LABELS[d]}</button>)}
              </div>
            )}
          </div>
        </div>
      </details>

      <div className="toolbar">
        <div className="chips" role="group" aria-label="表示">
          <button type="button" className="chip" aria-pressed={filter === "active"} onClick={() => setFilter("active")}>未完了</button>
          <button type="button" className="chip" aria-pressed={filter === "done"} onClick={() => setFilter("done")}>完了</button>
        </div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="並び順">
          <button type="button" aria-pressed={sort === "auto"} onClick={() => setSort("auto")} title="期限が早い順、そのあと優先度順">自動</button>
          <button type="button" aria-pressed={sort === "manual"} onClick={() => setSort("manual")} title="長押ししてドラッグで並び替え">手動</button>
        </div>
      </div>
      {manual && <p className="hint" style={{ marginBottom: 6 }}>行を長押ししてドラッグすると並び替えできます（繰り返しは常に先頭）。</p>}
      <details className="fold-box" style={{ marginBottom: 4 }}>
        <summary>期間で絞り込む{(range.from || range.to) ? "（適用中）" : ""}</summary>
        <div className="field-row" style={{ alignItems: "flex-end", padding: "8px 0" }}>
          <div><label className="label" htmlFor="rg-from">開始</label><input id="rg-from" type="date" className="input sm" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} /></div>
          <div><label className="label" htmlFor="rg-to">終了</label><input id="rg-to" type="date" className="input sm" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} /></div>
          {(range.from || range.to) && <button type="button" className="btn sm" style={{ flex: "none" }} onClick={() => setRange({ from: "", to: "" })}>クリア</button>}
        </div>
      </details>

      <ul className="list">
        {s.loading && visible.length === 0 && <li className="empty">読み込み中…</li>}
        {!s.loading && visible.length === 0 && <li className="empty">{filter === "done" ? "完了したタスクはまだありません。" : "タスクはありません。上の欄から追加できます。"}</li>}
        {visible.map(t => <TaskNode key={t.id} task={t} depth={0} s={s} collapsed={collapsed} toggleFold={toggleFold} editingId={editingId} setEditingId={setEditingId} longPress={longPress} manual={manual} />)}
      </ul>
    </div>
  )
}
