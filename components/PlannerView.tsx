"use client"

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { describeWarning, type DayAnalysis } from "@/lib/planning"
import { isTaskDone } from "@/lib/task-utils"
import { addDays, DAY_LABELS, eachDay, fmtMdDow, minutesToHhmm, parseYmd, weekStart } from "@/lib/time"
import type { TaskRow, TimeboxDb } from "@/lib/types"
import { fmtDuration } from "./format"
import { slotLoad as slotLoadOf } from "./load"
import { suggestMinutes, TaskDetail, useSheets } from "./sheets"
import { useStore } from "./store"
import { Check, Icon } from "./ui"

type Box = TimeboxDb & { task_text?: string | null }
const MIME = "application/x-myflow"

/** 画面幅の判定。初回の描画から実際の幅で判定し（matchMedia を直接読む）、リサイズも監視する。サーバー描画時は false。 */
function useMedia(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(query)
    mq.addEventListener("change", cb)
    window.addEventListener("resize", cb)
    return () => { mq.removeEventListener("change", cb); window.removeEventListener("resize", cb) }
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

interface Slot { key: string; label: string; start: number; end: number; custom?: boolean }

export default function PlannerView() {
  const s = useStore()
  const sheets = useSheets()
  const wide = useMedia("(min-width: 1100px)")
  const [selTask, setSelTask] = useState<string | null>(null)
  const [selDate, setSelDate] = useState<string>("")
  const [over, setOver] = useState<string | null>(null)

  const from = s.weekFrom || weekStart(s.today)
  const days = useMemo(() => eachDay(from, addDays(from, 6)), [from])
  const sched = s.weekSched
  const analysisByDate = useMemo(() => {
    const m = new Map<string, DayAnalysis>()
    for (const a of sched?.analysis[s.mode] ?? []) m.set(a.date, a)
    return m
  }, [sched, s.mode])
  const boxes: Box[] = useMemo(() => (sched?.timeboxes ?? []) as Box[], [sched])
  const presets = s.settings.presets
  const buffer = s.settings.bufferMinutes

  // 表示中の日付（スマホ/タブレットで1日ずつ見るとき）
  // スマホの日付帯: 選択中の日付を帯の中央へ寄せる（週の後ろの日が右に隠れないように）。ページ全体はスクロールさせない。
  // 帯は読み込み後・画面幅の変化で後から描画されるため、effect ではなく ref コールバックで「現れた時／選択が変わった時」に合わせる
  const centered = useRef<{ el: HTMLElement; label: string } | null>(null)
  // 毎回の描画で呼ばれる（関数を安定させない）。帯の要素が変わった時／選択が変わった時だけ動かす
  const stripRef = (strip: HTMLDivElement | null) => {
    if (!strip) return
    const chip = strip.querySelector<HTMLElement>("[aria-pressed='true']")
    if (!chip) return
    const label = chip.getAttribute("aria-label") || ""
    if (centered.current && centered.current.el === strip && centered.current.label === label) return
    centered.current = { el: strip, label }
    strip.scrollLeft = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2
  }
  useEffect(() => { if (!selDate || !days.includes(selDate)) setSelDate(days.includes(s.today) ? s.today : days[0]) }, [days, s.today, selDate])

  const labelFor = (a: number, b: number) => presets.find(p => p.start === a && p.end === b)?.label ?? null
  const taskOf = (id: string): TaskRow | undefined => s.taskById.get(id)
  const slotsOf = (date: string): { slot: Slot; boxes: Box[] }[] => {
    const dayBoxes = boxes.filter(b => b.date === date)
    const out = presets.map(p => ({ slot: { key: p.key, label: p.label, start: p.start, end: p.end } as Slot, boxes: dayBoxes.filter(b => b.window_start === p.start && b.window_end === p.end) }))
    const matched = new Set(out.flatMap(o => o.boxes.map(b => b.id)))
    const rest = dayBoxes.filter(b => !matched.has(b.id))
    if (rest.length > 0) out.push({ slot: { key: "custom", label: "その他", start: 0, end: 0, custom: true }, boxes: rest })
    return out
  }

  // 時間帯ごとの空きと負荷（サーバーの警告と同じ計算: lib/planning.ts の computeWindowLoad）
  const slotLoad = (date: string, start: number, end: number) => (sched ? slotLoadOf(sched, s.mode, date, start, end) : { free: 0, used: 0, remain: 0, blocked: false })

  const dropOn = async (e: React.DragEvent, date: string, start: number, end: number) => {
    e.preventDefault(); setOver(null)
    let payload: { type: "task" | "box"; id: string } | null = null
    try { payload = JSON.parse(e.dataTransfer.getData(MIME)) } catch { /* ほかのドラッグは無視 */ }
    if (!payload) return
    const len = end - start
    if (payload.type === "task") {
      const t = taskOf(payload.id)
      if (!t) return
      const mins = Math.max(1, Math.min(suggestMinutes(t, s.boxesByTask.get(t.id) ?? []), len))
      await s.placeTask(t.id, { date, window_start: start, window_end: end, planned_minutes: mins })
      setSelTask(t.id)
    } else {
      const b = s.boxes.find(x => x.id === payload!.id)
      if (!b || (b.date === date && b.window_start === start && b.window_end === end)) return
      await s.moveBox(b.id, { date, window_start: start, window_end: end, planned_minutes: Math.min(b.planned_minutes, len) }, "予定の移動")
      setSelTask(b.task_id)
    }
  }

  const dragProps = (type: "task" | "box", id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(MIME, JSON.stringify({ type, id })); e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move" },
  })

  // ---- 1つの時間帯（朝・昼・夜・その他） ----
  // ⚠ 以下の slotCell / dayBody / unplacedList はコンポーネントではなく「関数呼び出し」で描画する。
  //    コンポーネントとして定義すると再描画のたびに作り直され、ドラッグ中(dragover)にDOMが入れ替わって操作が途切れる。
  const slotCell = (date: string, slot: Slot, list: Box[]) => {
    const key = `${date}|${slot.key}`
    const load = slot.custom ? null : slotLoad(date, slot.start, slot.end)
    const warned = !slot.custom && (analysisByDate.get(date)?.warnings ?? []).some(w => w.window && w.window.start === slot.start && w.window.end === slot.end && (w.code === "window_over" || w.code === "window_blocked"))
    const pct = load && load.free > 0 ? Math.min(100, Math.round((load.used / load.free) * 100)) : load ? 100 : 0
    return (
      <div
        className={`slot${warned ? " is-warn" : ""}${over === key ? " is-over" : ""}`}
        onDragOver={slot.custom ? undefined : e => { if (e.dataTransfer.types.includes(MIME)) { e.preventDefault(); setOver(key) } }}
        onDragLeave={() => setOver(o => (o === key ? null : o))}
        onDrop={slot.custom ? undefined : e => dropOn(e, date, slot.start, slot.end)}
      >
        <div className="slot-head">
          <b>{slot.label}{!slot.custom && !wide ? ` ${minutesToHhmm(slot.start)}–${minutesToHhmm(slot.end)}` : ""}</b>
          {load && <span className="free num" title="固定予定を除いた空きから、予定の作業時間（移動・休憩の余白込み）を引いた残り">{load.blocked ? "使えません" : load.remain < 0 ? `⚠ ${fmtDuration(-load.remain)}超過` : `残${fmtDuration(load.remain)}`}</span>}
        </div>
        {load && <div className="slot-load" style={{ ["--pct" as string]: `${pct}%` }}><i /></div>}
        {list.map(b => {
          const t = taskOf(b.task_id)
          const done = b.status === "done"
          return (
            <div key={b.id} className={`tbox${selTask === b.task_id ? " is-selected" : ""}${done ? " is-done" : ""}`} {...(b.status === "planned" ? dragProps("box", b.id) : {})}>
              {!wide && t && <Check small checked={isTaskDone(t, s.today)} label={`${t.text} を${isTaskDone(t, s.today) ? "未完了に戻す" : "完了にする"}`} onChange={() => s.toggleTask(t)} />}
              <button type="button" className="tt" style={{ flex: 1, minWidth: 0, textAlign: "left" }} onClick={() => { setSelTask(b.task_id); if (!wide) sheets.open({ kind: "detail", taskId: b.task_id }) }}>
                {t?.text ?? b.task_text ?? "（削除されたタスク）"}
                <span className="mm num">{slot.custom ? `${minutesToHhmm(b.window_start)}–${minutesToHhmm(b.window_end)} ・ ` : ""}{fmtDuration(b.planned_minutes)}{done ? " ・ 実施済み" : ""}</span>
              </button>
            </div>
          )
        })}
        {!slot.custom && <button type="button" className="slot-add" onClick={() => sheets.open({ kind: "pick", date, window: [slot.start, slot.end] })} aria-label={`${fmtMdDow(date)} ${slot.label}に予定を追加`}>＋ 追加</button>}
      </div>
    )
  }

  const dayBody = (date: string, showWarnings: boolean) => {
    const fixed = (sched?.fixedEvents ?? []).filter(f => f.date === date).sort((a, b) => a.start_min - b.start_min)
    const busy = s.showOther ? (sched?.otherBusy ?? []).filter(b => b.date === date).sort((a, b) => a.start - b.start) : []
    const warnings = analysisByDate.get(date)?.warnings ?? []
    return (
      <>
        {fixed.map(f => (
          <button key={f.event_id + f.date} type="button" className="fixed-line" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={() => sheets.open({ kind: "fixed", id: f.event_id })} aria-label={`固定予定 ${f.title} を編集`}>
            <b className="num">{minutesToHhmm(f.start_min)}–{minutesToHhmm(f.end_min)}</b>{f.title}
          </button>
        ))}
        {busy.map((b, i) => <div key={i} className="busy-line"><b className="num" style={{ fontWeight: 600 }}>{minutesToHhmm(b.start)}–{minutesToHhmm(b.end)}</b> 別カテゴリ{b.kind === "planned" ? "の作業枠" : "の予定"}</div>)}
        {showWarnings && warnings.length > 0 && <ul className="warn-list" role="status">{warnings.map((w, i) => <li key={i}>⚠ {describeWarning(w, labelFor)}</li>)}</ul>}
        {slotsOf(date).map(({ slot, boxes: list }) => <Fragment key={slot.key}>{slotCell(date, slot, list)}</Fragment>)}
        <button type="button" className="slot-add" style={{ opacity: 1, marginTop: 4 }} onClick={() => sheets.open({ kind: "fixed", date })}>＋ 固定予定</button>
      </>
    )
  }

  const range = `${fmtMdDow(days[0])} 〜 ${fmtMdDow(days[6])}`
  const unplaced = s.unplaced
  const goWeek = (d: string) => s.setWeekFrom(d)

  const unplacedList = () => (
    <ul>
      {unplaced.length === 0 && <li className="empty" style={{ padding: "10px 2px" }}>未配置のタスクはありません。</li>}
      {unplaced.map(t => (
        <li key={t.id}>
          <button
            type="button" className={`unplaced-item${selTask === t.id ? " is-selected" : ""}`} {...dragProps("task", t.id)}
            onClick={() => { setSelTask(t.id); if (!wide) sheets.open({ kind: "schedule", taskId: t.id, date: selDate || s.today }) }}
          >
            <span className="t">{t.priority === "high" && <i className="dot high" title="優先度 高" />}{t.text}</span>
            <span className="m num">{[t.due_date ? `期限 ${fmtMdDow(t.due_date)}` : "", t.estimate_minutes ? fmtDuration(t.estimate_minutes) : ""].filter(Boolean).join(" ・ ") || "　"}</span>
          </button>
        </li>
      ))}
    </ul>
  )

  const Bar = (
    <div className="planner-bar">
      <button type="button" className="btn icon" aria-label="前の週" onClick={() => goWeek(addDays(from, -7))}><Icon name="left" /></button>
      <button type="button" className="btn sm" onClick={() => goWeek(weekStart(s.today))}>今週</button>
      <button type="button" className="btn icon" aria-label="次の週" onClick={() => goWeek(addDays(from, 7))}><Icon name="right" /></button>
      <span className="range num">{range}</span>
      <span style={{ flex: 1 }} />
      <button type="button" className="btn sm" disabled={s.undoLen === 0} onClick={() => s.undo()} aria-label="直前の変更を元に戻す（Ctrl+Z）"><Icon name="undo" size={16} />元に戻す</button>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13.5, color: "var(--muted)" }} title="別カテゴリの予定の「時間」だけを薄く表示します（内容は表示しません）">
        <input type="checkbox" checked={s.showOther} onChange={e => s.setShowOther(e.target.checked)} /> 全体の時間を表示
      </label>
    </div>
  )

  if (!sched) return <div className="page wide"><div className="page-head"><h1 className="page-title">計画</h1></div>{Bar}<p className="empty">読み込み中…</p></div>

  // ===== スマホ・タブレット: 日付を横に選び、その日の予定を縦に表示 =====
  if (!wide) {
    const p = parseYmd(selDate)
    return (
      <div className="page">
        <div className="page-head"><h1 className="page-title">計画</h1></div>
        {Bar}
        <div className="daystrip" ref={stripRef} role="group" aria-label="日付">
          {days.map(d => {
            const n = boxes.filter(b => b.date === d).length
            return (
              <button key={d} type="button" className={`daychip${d === s.today ? " is-today" : ""}`} aria-pressed={selDate === d} onClick={() => setSelDate(d)} aria-label={fmtMdDow(d)}>
                <span className="dw">{DAY_LABELS[new Date(d + "T00:00:00Z").getUTCDay()]}</span>
                <span className="dn num">{Number(d.slice(8))}</span>
                <span className="mk">{Array.from({ length: Math.min(n, 3) }).map((_, i) => <i key={i} />)}</span>
              </button>
            )
          })}
        </div>
        {selDate && p && (
          <section className="day-panel" aria-label={`${fmtMdDow(selDate)} の予定`}>
            <h2 className="section-title" style={{ margin: "4px 0 8px" }}>{p.m}月{p.d}日 の予定</h2>
            {dayBody(selDate, true)}
          </section>
        )}
        <section className="section" style={{ marginTop: 28 }}>
          <div className="section-head"><h2 className="section-title">未配置のタスク<span className="count num">{unplaced.length}</span></h2></div>
          <p className="hint" style={{ marginBottom: 4 }}>タップして、{selDate ? fmtMdDow(selDate) : "日"}の時間帯に入れます。</p>
          {unplacedList()}
        </section>
      </div>
    )
  }

  // ===== PC: 週 | 右の列（未配置 + 詳細） =====
  const warnCount = (d: string) => analysisByDate.get(d)?.warnings.length ?? 0
  const weekNotes = days.flatMap(d => (analysisByDate.get(d)?.warnings ?? []).map(w => ({ d, text: describeWarning(w, labelFor) })))
  return (
    <div className="page wide">
      <div className="page-head"><h1 className="page-title">計画</h1><span className="page-sub">タスクを時間帯にドラッグして入れます。予定もドラッグで動かせます。</span></div>
      {Bar}
      {weekNotes.length > 0 && (
        <details className="notice warn week-notes">
          <summary>この週の注意 {weekNotes.length}件</summary>
          <ul>{weekNotes.map((n, i) => <li key={i}><b>{fmtMdDow(n.d)}</b> {n.text}</li>)}</ul>
        </details>
      )}
      <div className="planner">
        <div className="week" role="grid" aria-label="週間プランナー">
          {days.map(d => {
            const dt = parseYmd(d)!
            const dow = new Date(d + "T00:00:00Z").getUTCDay()
            return (
              <div key={d} className={`day-col${d === s.today ? " is-today" : ""}${dow === 0 || dow === 6 ? " is-weekend" : ""}`} role="gridcell">
                <div className="day-head"><div className="dow">{DAY_LABELS[dow]}</div><div className="d num" aria-label={`${dt.m}月${dt.d}日${warnCount(d) > 0 ? "（注意あり）" : ""}`}>{dt.d}{warnCount(d) > 0 && <span className="flag" aria-hidden="true">⚠</span>}</div></div>
                {dayBody(d, false)}
              </div>
            )
          })}
        </div>
        <aside className="panel" aria-label="未配置と詳細">
          <section aria-label="未配置のタスク">
            <div className="panel-title"><span>未配置のタスク</span><span className="num">{unplaced.length}</span></div>
            {unplacedList()}
          </section>
          <section aria-label="詳細">
            <div className="panel-title"><span>詳細</span></div>
            {selTask && taskOf(selTask) ? <TaskDetail taskId={selTask} /> : <p className="empty" style={{ padding: "6px 2px" }}>タスクか予定を選ぶと、ここに詳細が出ます。</p>}
          </section>
        </aside>
      </div>
    </div>
  )
}
