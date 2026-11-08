"use client"

import { useEffect, useMemo, useState } from "react"
import { describeWarning } from "@/lib/planning"
import { isTaskDone, recurrenceLabel, recursOn } from "@/lib/task-utils"
import { addDays, DAY_LABELS, fmtMdDow, minutesToHhmm, parseYmd } from "@/lib/time"
import type { TaskRow, TimeboxDb } from "@/lib/types"
import { fmtDuration, relDay, windowText } from "./format"
import { useSheets } from "./sheets"
import { useStore } from "./store"
import { Check, Menu } from "./ui"

type WorkRow = { key: string; task: TaskRow; box?: TimeboxDb }

function useSecondTick(active: boolean) {
  const [, setT] = useState(0)
  useEffect(() => {
    if (!active) return
    const i = setInterval(() => setT(x => x + 1), 1000)
    return () => clearInterval(i)
  }, [active])
}

export default function HomeView() {
  const s = useStore()
  const sheets = useSheets()
  const { today, now, settings, mode } = s
  const [quick, setQuick] = useState("")
  useSecondTick(!!s.session)

  const p = parseYmd(today)!
  const dayAnalysis = s.homeSched?.analysis[mode]?.find(a => a.date === today)
  const labelFor = (a: number, b: number) => settings.presets.find(x => x.start === a && x.end === b)?.label ?? null

  const fixedToday = (s.homeSched?.fixedEvents ?? []).filter(f => f.date === today).sort((a, b) => a.start_min - b.start_min)
  const otherToday = (s.homeSched?.otherBusy ?? []).filter(b => b.date === today && b.kind === "fixed").sort((a, b) => a.start - b.start)

  const rows = useMemo<WorkRow[]>(() => {
    const boxRows: WorkRow[] = s.boxes
      .filter(b => b.date === today && b.status !== "released")
      .sort((a, b) => a.window_start - b.window_start || a.created_at.localeCompare(b.created_at))
      .map(b => ({ key: b.id, box: b, task: s.taskById.get(b.task_id) as TaskRow }))
      .filter(r => !!r.task)
    const withBox = new Set(boxRows.map(r => r.task.id))
    const rec: WorkRow[] = s.tasks
      .filter(t => !t.parent_id && t.is_recurring && recursOn(t, today) && !withBox.has(t.id))
      .map(t => ({ key: "r-" + t.id, task: t }))
    return [...boxRows, ...rec]
  }, [s.boxes, s.tasks, s.taskById, today])

  const isRowDone = (r: WorkRow) => isTaskDone(r.task, today) || r.box?.status === "done"
  const ordered = [...rows.filter(r => !isRowDone(r) || s.flash.has(r.task.id)), ...rows.filter(r => isRowDone(r) && !s.flash.has(r.task.id))]
  const doneCount = rows.filter(isRowDone).length
  const pct = rows.length ? Math.round((doneCount / rows.length) * 100) : 0

  const hasPlanned = (id: string) => (s.boxesByTask.get(id) ?? []).some(b => b.status === "planned")
  const byDue = (a: TaskRow, b: TaskRow) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || ({ high: 0, mid: 1, low: 2 }[a.priority] - { high: 0, mid: 1, low: 2 }[b.priority])
  const unplaced = s.unplaced
  const nearDue = s.tasks
    .filter(t => !t.is_recurring && !isTaskDone(t, today) && t.due_date && t.due_date <= addDays(today, 3))
    .sort(byDue)
  const missed = s.boxes.filter(b => b.status === "planned" && (b.date < today || (b.date === today && b.window_end <= now.minutes))).length

  const active = s.tasks.filter(t => !isTaskDone(t, today) && !t.parent_id).length
  const completed = s.tasks.filter(t => isTaskDone(t, today) && !t.parent_id).length
  const overdue = s.tasks.filter(t => !t.is_recurring && !isTaskDone(t, today) && t.due_date && t.due_date < today).length
  const avgGoal = s.goals.length ? Math.round(s.goals.reduce((a, g) => a + g.pct, 0) / s.goals.length) : 0

  const sess = s.session
  const elapsed = sess ? Math.max(0, Math.floor((Date.now() - sess.startedAt) / 1000)) : 0
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`

  const addQuick = async () => {
    const text = quick.trim()
    if (!text) return
    setQuick("")
    const row = await s.addTask({ text })
    if (!row) setQuick(text)
  }

  const finishSession = async (complete: boolean) => {
    if (!sess) return
    const task = s.taskById.get(sess.taskId)
    const minutes = Math.max(1, Math.round((Date.now() - sess.startedAt) / 60000))
    s.setSession(null)
    if (complete && task) await s.toggleTask(task)
    else await s.completeBox(sess.boxId, minutes)
  }

  const rowMenu = (r: WorkRow) => {
    const t = r.task
    const items = []
    if (r.box && r.box.status === "planned") {
      items.push({ label: "予定を変更", onClick: () => sheets.open({ kind: "schedule", taskId: t.id, boxId: r.box!.id }) })
      items.push({ label: "明日に移動", onClick: () => s.moveBox(r.box!.id, { date: addDays(today, 1) }, "明日へ移動") })
      items.push({ label: "未配置に戻す", onClick: () => s.releaseBox(r.box!.id) })
    } else if (!t.is_recurring) {
      items.push({ label: "予定に入れる", onClick: () => sheets.open({ kind: "schedule", taskId: t.id }) })
    }
    items.push({ label: "編集", onClick: () => sheets.open({ kind: "edit", taskId: t.id }) })
    items.push({ label: "詳細を見る", onClick: () => sheets.open({ kind: "detail", taskId: t.id }) })
    return items
  }

  return (
    <div className="page">
      <header className="today-head">
        <h1 className="today-date">{p.m}月{p.d}日（{DAY_LABELS[now.dow]}）</h1>
        <p className="today-cat"><span className="cat-dot" data-mode={mode} />{mode === "work" ? "仕事" : "プライベート"}</p>
        {rows.length > 0 && (
          <div className="today-progress" aria-label={`今日の作業 ${doneCount}/${rows.length} 完了`}>
            <div className="meter" style={{ ["--pct" as string]: `${pct}%` }}><i /></div>
            <b className="num">{doneCount} / {rows.length}</b>
          </div>
        )}
      </header>

      {sess && (
        <div className="session" role="status">
          <div className="what"><small>取り組み中</small><strong>{sess.text}</strong></div>
          <div className="clock num" aria-label="経過時間">{clock}</div>
          <div className="chips">
            <button type="button" className="btn sm solid" onClick={() => finishSession(true)}>完了にする</button>
            <button type="button" className="btn sm" onClick={() => finishSession(false)}>今日はここまで</button>
            <button type="button" className="btn sm" onClick={() => s.setSession(null)}>やめる</button>
          </div>
        </div>
      )}

      {dayAnalysis && dayAnalysis.warnings.length > 0 && (
        <div className="notice warn" role="status">
          <div>
            <b>今日の予定に無理がありそうです</b>
            <ul>{dayAnalysis.warnings.map((w, i) => <li key={i}>{describeWarning(w, labelFor)}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="adder" style={{ marginBottom: 26 }}>
        <input className="input" aria-label="タスクを追加" placeholder="やることを追加（名前だけでOK）" value={quick} maxLength={300}
          onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) addQuick() }} />
        <button type="button" className="btn primary" disabled={!quick.trim()} onClick={addQuick}>追加</button>
      </div>

      <section className="section" aria-labelledby="h-fixed">
        <div className="section-head">
          <h2 className="section-title" id="h-fixed">今日の固定予定</h2>
          <button type="button" className="btn sm quiet" onClick={() => sheets.open({ kind: "fixed", date: today })}>＋ 追加</button>
        </div>
        <div className="list">
          {fixedToday.length === 0 && otherToday.length === 0 && <p className="empty">固定の予定はありません。</p>}
          {fixedToday.map(f => (
            <div key={f.event_id + f.date} className="fixed-row">
              <span className="t num">{minutesToHhmm(f.start_min)}–{minutesToHhmm(f.end_min)}</span>
              <span className="name">{f.title}</span>
              <button type="button" className="btn sm quiet" aria-label={`${f.title} を編集`} onClick={() => sheets.open({ kind: "fixed", id: f.event_id })}>編集</button>
            </div>
          ))}
          {otherToday.map((b, i) => (
            <div key={i} className="fixed-row" style={{ color: "var(--muted)" }}>
              <span className="t num">{minutesToHhmm(b.start)}–{minutesToHhmm(b.end)}</span>
              <span className="name">別カテゴリの予定あり</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="h-work">
        <div className="section-head">
          <h2 className="section-title" id="h-work">今日の作業<span className="count num">{rows.length}</span></h2>
          <button type="button" className="btn sm quiet" onClick={() => sheets.open({ kind: "replan" })}>
            予定を立て直す{missed > 0 ? `（${missed}）` : ""}
          </button>
        </div>
        <ul className="list">
          {ordered.length === 0 && <li className="empty">今日の作業はまだありません。下の「未配置のタスク」から選んで、今日に入れましょう。</li>}
          {ordered.map(r => {
            const t = r.task
            const done = isRowDone(r)
            const taskDone = isTaskDone(t, today)
            const partial = !taskDone && r.box?.status === "done" // 今日の分は実施したが、タスクは未完了
            const passed = r.box && r.box.status === "planned" && r.box.window_end <= now.minutes
            return (
              <li key={r.key} className="row">
                <Check checked={taskDone} mixed={partial} label={`${t.text} を${taskDone ? "未完了に戻す" : partial ? "完了にする（今日の分は実施済み）" : "完了にする"}`} onChange={() => s.toggleTask(t)} />
                <div className="row-main">
                  <span className={`row-title${taskDone ? " is-done" : ""}`}>{t.priority === "high" && <i className="dot high" title="優先度 高" />}{t.text}</span>
                  <div className="row-meta">
                    {r.box ? <>
                      <span className="num">{windowText(settings, r.box.window_start, r.box.window_end)}</span>
                      <span>{fmtDuration(r.box.planned_minutes)}</span>
                      {r.box.status === "done" && <span style={{ color: "var(--accent-hover)", fontWeight: 600 }}>今日の分は実施済み{r.box.kept_window === false ? "（時間帯の外）" : ""}</span>}
                      {passed && <span className="soon">時間帯を過ぎました</span>}
                    </> : <span>{recurrenceLabel(t)}の繰り返し</span>}
                    {t.due_date && !done && <span className={t.due_date < today ? "late" : undefined}>期限 {relDay(t.due_date, today)}</span>}
                  </div>
                </div>
                <div className="row-actions always">
                  {r.box?.status === "planned" && !done && s.session?.boxId !== r.box.id && (
                    <button type="button" className="btn sm" onClick={() => s.startNow(r.box!.id)}>今から始める</button>
                  )}
                  <Menu label={`${t.text} の操作`} items={rowMenu(r)} />
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="section" aria-labelledby="h-unplaced">
        <div className="section-head">
          <h2 className="section-title" id="h-unplaced">未配置のタスク<span className="count num">{unplaced.length}</span></h2>
          <button type="button" className="btn sm quiet" onClick={() => s.setTab("planner")}>週の計画を開く</button>
        </div>
        <ul className="list">
          {unplaced.length === 0 && <li className="empty">未配置のタスクはありません。</li>}
          {unplaced.slice(0, 6).map(t => (
            <li key={t.id} className="row">
              <Check checked={false} label={`${t.text} を完了にする`} onChange={() => s.toggleTask(t)} />
              <div className="row-main">
                <span className="row-title">{t.priority === "high" && <i className="dot high" title="優先度 高" />}{t.text}</span>
                <div className="row-meta">
                  {t.due_date && <span className={t.due_date < today ? "late" : undefined}>期限 {fmtMdDow(t.due_date)}（{relDay(t.due_date, today)}）</span>}
                  {t.estimate_minutes ? <span>{fmtDuration(t.estimate_minutes)}</span> : null}
                </div>
              </div>
              <div className="row-actions always">
                <button type="button" className="btn sm" onClick={() => sheets.open({ kind: "schedule", taskId: t.id, date: today })}>今日に入れる</button>
                <Menu label={`${t.text} の操作`} items={[
                  { label: "予定に入れる", onClick: () => sheets.open({ kind: "schedule", taskId: t.id }) },
                  { label: "編集", onClick: () => sheets.open({ kind: "edit", taskId: t.id }) },
                  { label: "詳細を見る", onClick: () => sheets.open({ kind: "detail", taskId: t.id }) },
                ]} />
              </div>
            </li>
          ))}
        </ul>
        {unplaced.length > 6 && <p className="hint" style={{ marginTop: 8 }}>ほか {unplaced.length - 6} 件は「タスク」または週の計画で確認できます。</p>}
      </section>

      <section className="section" aria-labelledby="h-due">
        <div className="section-head"><h2 className="section-title" id="h-due">期限が近いタスク<span className="count num">{nearDue.length}</span></h2></div>
        <ul className="list">
          {nearDue.length === 0 && <li className="empty">3日以内に期限のタスクはありません。</li>}
          {nearDue.slice(0, 6).map(t => (
            <li key={t.id} className="row">
              <Check checked={false} label={`${t.text} を完了にする`} onChange={() => s.toggleTask(t)} />
              <div className="row-main">
                <span className="row-title">{t.text}</span>
                <div className="row-meta"><span className={t.due_date! < today ? "late" : "soon"}>{relDay(t.due_date, today)}</span><span>{fmtMdDow(t.due_date!)}</span>{hasPlanned(t.id) ? <span>予定あり</span> : <span>未配置</span>}</div>
              </div>
              <div className="row-actions always">
                {!hasPlanned(t.id) && <button type="button" className="btn sm" onClick={() => sheets.open({ kind: "schedule", taskId: t.id })}>予定に入れる</button>}
                <Menu label={`${t.text} の操作`} items={[
                  { label: "編集", onClick: () => sheets.open({ kind: "edit", taskId: t.id }) },
                  { label: "詳細を見る", onClick: () => sheets.open({ kind: "detail", taskId: t.id }) },
                ]} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <details className="fold-box">
        <summary>統計を見る</summary>
        <div className="stats">
          <div className="stat"><b>{active}</b><span>未完了</span></div>
          <div className="stat"><b>{completed}</b><span>完了</span></div>
          <div className="stat"><b>{overdue}</b><span>期限超過</span></div>
          <div className="stat"><b>{avgGoal}%</b><span>目標の進捗</span></div>
        </div>
      </details>
    </div>
  )
}

