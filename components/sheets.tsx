"use client"

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { presetForWindow } from "@/lib/settings"
import { isTaskDone, recurrenceLabel } from "@/lib/task-utils"
import { addDays, DAY_LABELS, fmtMdDow, hhmmToMinutes, minutesToHhmm } from "@/lib/time"
import type { TaskRow, TimeboxDb } from "@/lib/types"
import { fmtDuration, parseTags, relDay, renderWithLinks, windowText } from "./format"
import { slotLoad as slotLoadOf } from "./load"
import { api, useStore, type MemoRow, type Schedule } from "./store"
import { Check, Menu, Sheet } from "./ui"

// ============ シートを開く共通の仕組み ============

export type SheetState =
  | { kind: "edit"; taskId?: string; parentId?: string }
  | { kind: "schedule"; taskId: string; boxId?: string; date?: string; window?: [number, number] }
  | { kind: "replan" }
  | { kind: "detail"; taskId: string }
  | { kind: "split"; boxId: string }
  | { kind: "pick"; date: string; window: [number, number] }
  | { kind: "fixed"; id?: string; date?: string }
  | { kind: "settings" }
  | { kind: "goal"; goalId?: string }
  | { kind: "memo"; memoId?: string }

interface SheetsApi { open: (s: SheetState) => void; close: () => void }
const SheetsCtx = createContext<SheetsApi | null>(null)
export const useSheets = () => { const v = useContext(SheetsCtx); if (!v) throw new Error("SheetsProvider が必要です"); return v }

export function SheetsProvider({ children }: { children: ReactNode }) {
  const [cur, setCur] = useState<SheetState | null>(null)
  const apiObj = useMemo<SheetsApi>(() => ({ open: setCur, close: () => setCur(null) }), [])
  return (
    <SheetsCtx.Provider value={apiObj}>
      {children}
      {cur?.kind === "edit" && <TaskEditSheet key={cur.taskId ?? "new-" + cur.parentId} taskId={cur.taskId} parentId={cur.parentId} />}
      {cur?.kind === "schedule" && <ScheduleSheet key={`${cur.taskId}-${cur.boxId ?? "new"}`} {...cur} />}
      {cur?.kind === "replan" && <ReplanSheet />}
      {cur?.kind === "detail" && <DetailSheet taskId={cur.taskId} />}
      {cur?.kind === "split" && <SplitSheet boxId={cur.boxId} />}
      {cur?.kind === "pick" && <PickTaskSheet date={cur.date} window={cur.window} />}
      {cur?.kind === "fixed" && <FixedEventSheet key={cur.id ?? "new"} id={cur.id} date={cur.date} />}
      {cur?.kind === "settings" && <SettingsSheet />}
      {cur?.kind === "goal" && <GoalSheet key={cur.goalId ?? "new"} goalId={cur.goalId} />}
      {cur?.kind === "memo" && <MemoSheet key={cur.memoId ?? "new"} memoId={cur.memoId} />}
    </SheetsCtx.Provider>
  )
}

// ============ 共通部品 ============

function TimeField({ label, minutes, onChange, isEnd }: { label: string; minutes: number; onChange: (m: number) => void; isEnd?: boolean }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      <input
        type="time" className="input" step={300}
        value={minutesToHhmm(minutes === 1440 ? 0 : minutes)}
        onChange={e => {
          const m = hhmmToMinutes(e.target.value)
          if (m === null) return
          onChange(isEnd && m === 0 ? 1440 : m) // 終了が 0:00 なら「24:00（日付の終わり）」として扱う
        }}
      />
    </div>
  )
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; label: string }[] }) {
  return (
    <div className="chips">
      {options.map(o => <button key={o.v} type="button" className="chip" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  )
}

/** 見積りに対して、まだ予定に入っていない時間（無ければ 30 分） */
export function suggestMinutes(task: TaskRow | undefined, boxes: TimeboxDb[]): number {
  const est = task?.estimate_minutes
  if (typeof est === "number" && est > 0) {
    const used = boxes.filter(b => b.status !== "released").reduce((s, b) => s + (b.status === "done" ? (b.actual_minutes ?? b.planned_minutes) : b.planned_minutes), 0)
    const remain = est - used
    if (remain > 0) return Math.min(remain, 240)
  }
  return 30
}

// ============ 予定に入れる / 予定を変更 ============

function ScheduleSheet({ taskId, boxId, date: d0, window: w0 }: { taskId: string; boxId?: string; date?: string; window?: [number, number] }) {
  const s = useStore()
  const sheets = useSheets()
  const task = s.taskById.get(taskId)
  const box = boxId ? s.boxes.find(b => b.id === boxId) : undefined
  const mine = s.boxesByTask.get(taskId) ?? []
  const night = s.settings.presets.find(p => p.key === "night")!
  const [date, setDate] = useState(box?.date ?? d0 ?? s.today)
  const [win, setWin] = useState<{ start: number; end: number }>(
    box ? { start: box.window_start, end: box.window_end } : w0 ? { start: w0[0], end: w0[1] } : { start: night.start, end: night.end }
  )
  const [minutes, setMinutes] = useState<number>(box?.planned_minutes ?? suggestMinutes(task, mine))
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ free: number; used: number; remain: number } | null>(null)

  const preset = presetForWindow(s.settings, win.start, win.end)
  const winLen = win.end - win.start
  const invalid = !(win.start < win.end) ? "開始は終了より前にしてください" : minutes < 1 ? "作業時間は1分以上にしてください" : minutes > winLen ? `この時間帯(${fmtDuration(winLen)})より長い作業時間は設定できません` : null

  // 選んだ日・時間帯の空きをプレビュー（固定予定と、すでに入っている予定を引く）
  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await api<Schedule>(`/api/planner?mode=${s.mode}&from=${date}&to=${date}&includeOther=1`)
        if (!alive || !(win.start < win.end)) return
        // サーバーの警告・週間表と同じ計算（動かす予定自身は除く）
        const load = slotLoadOf(r, s.mode, date, win.start, win.end, boxId)
        setPreview({ free: load.free, used: load.used, remain: load.remain - (minutes + r.settings.bufferMinutes) })
      } catch { if (alive) setPreview(null) }
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [date, win.start, win.end, minutes, boxId, s.mode])

  if (!task) return null
  const quick = [0, 1, 2].map(i => addDays(s.today, i))
  const submit = async () => {
    if (invalid || busy) return
    setBusy(true)
    const input = { date, window_start: win.start, window_end: win.end, planned_minutes: minutes }
    const ok = box ? await s.moveBox(box.id, input, "予定の変更") : await s.placeTask(task.id, input)
    setBusy(false)
    if (ok) sheets.close()
  }

  return (
    <Sheet
      title={box ? "予定を変更" : "予定に入れる"}
      onClose={sheets.close}
      footer={<>
        {box && <button type="button" className="btn quiet left" onClick={async () => { await s.releaseBox(box.id); sheets.close() }}>未配置に戻す</button>}
        <button type="button" className="btn" onClick={sheets.close}>キャンセル</button>
        <button type="button" className="btn primary" disabled={!!invalid || busy} onClick={submit}>{box ? "変更を保存" : "予定に入れる"}</button>
      </>}
    >
      <p style={{ fontWeight: 600, marginBottom: 16, overflowWrap: "anywhere" }}>{task.text}</p>

      <div className="field">
        <span className="label">日</span>
        <div className="chips" style={{ marginBottom: 8 }}>
          {quick.map((d, i) => <button key={d} type="button" className="chip" aria-pressed={date === d} onClick={() => setDate(d)}>{["今日", "明日", "あさって"][i]}</button>)}
        </div>
        <input type="date" className="input" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label="日付" />
        <p className="hint">{fmtMdDow(date)}</p>
      </div>

      <div className="field">
        <span className="label">時間帯（この間のどこかで）</span>
        <div className="chips">
          {s.settings.presets.map(p => (
            <button key={p.key} type="button" className="chip" aria-pressed={preset?.key === p.key} onClick={() => setWin({ start: p.start, end: p.end })}>
              {p.label} {minutesToHhmm(p.start)}–{minutesToHhmm(p.end)}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={!preset} onClick={() => { if (preset) setWin({ start: win.start, end: Math.min(win.end, win.start + 180) || win.end }) }}>カスタム</button>
        </div>
        {!preset && (
          <div className="field-row" style={{ marginTop: 10 }}>
            <TimeField label="開始" minutes={win.start} onChange={m => setWin(w => ({ ...w, start: m }))} />
            <TimeField label="終了" minutes={win.end} onChange={m => setWin(w => ({ ...w, end: m }))} isEnd />
          </div>
        )}
        <p className="hint">開始時刻は決めなくてOK。この時間帯のどこかで取り組みます。</p>
      </div>

      <div className="field">
        <span className="label">作業時間</span>
        <div className="chips" style={{ marginBottom: 8 }}>
          {[15, 30, 45, 60, 90, 120].map(m => <button key={m} type="button" className="chip" aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{fmtDuration(m)}</button>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="number" className="input" min={1} max={1440} value={minutes} style={{ maxWidth: 110 }} aria-label="作業時間（分）" onChange={e => setMinutes(Math.round(Number(e.target.value)) || 0)} />
          <span>分</span>
        </div>
        {typeof task.estimate_minutes === "number" && <p className="hint">このタスクの見積り: {fmtDuration(task.estimate_minutes)}</p>}
      </div>

      {invalid ? <div className="notice danger" role="alert">{invalid}</div> : preview && (
        <div className={`notice ${preview.remain < 0 ? "warn" : "info"}`} aria-live="polite">
          <div>
            {preview.free === 0
              ? <>この時間帯は固定予定で埋まっていて、<b>作業時間が取れません</b>（そのまま入れることもできます）</>
              : preview.remain < 0
              ? <>この時間帯は固定予定を除いて空き{fmtDuration(preview.free)}、すでに予定{fmtDuration(preview.used)}。<b>{fmtDuration(-preview.remain)}足りません</b>（そのまま入れることもできます）</>
              : <>この時間帯の空き{fmtDuration(preview.free)}（固定予定を除く）／すでに予定{fmtDuration(preview.used)}。入れても<b>{fmtDuration(preview.remain)}の余裕</b>があります</>}
          </div>
        </div>
      )}
    </Sheet>
  )
}

// ============ 枠に入れるタスクを選ぶ ============

function PickTaskSheet({ date, window: win }: { date: string; window: [number, number] }) {
  const s = useStore()
  const sheets = useSheets()
  const [q, setQ] = useState("")
  const needle = q.trim().toLowerCase()
  const placedIds = new Set(s.unplaced.map(t => t.id))
  const others = s.tasks.filter(t => !t.is_recurring && !isTaskDone(t, s.today) && !(s.childrenOf.get(t.id)?.length) && !placedIds.has(t.id))
  const match = (t: TaskRow) => !needle || t.text.toLowerCase().includes(needle)
  const pick = (t: TaskRow) => sheets.open({ kind: "schedule", taskId: t.id, date, window: win })
  const Item = ({ t, sub }: { t: TaskRow; sub?: string }) => (
    <li><button type="button" className="unplaced-item" onClick={() => pick(t)}>
      <span className="t">{t.text}</span>
      <span className="m">{[t.due_date ? `期限 ${fmtMdDow(t.due_date)}` : "", t.estimate_minutes ? fmtDuration(t.estimate_minutes) : "", sub ?? ""].filter(Boolean).join(" ・ ")}</span>
    </button></li>
  )
  return (
    <Sheet title={`${fmtMdDow(date)} ${windowText(s.settings, win[0], win[1])} に入れるタスク`} onClose={sheets.close}>
      <div className="field"><input className="input" aria-label="タスクを検索" placeholder="タスクを検索" value={q} onChange={e => setQ(e.target.value)} /></div>
      <div className="section-title" style={{ marginBottom: 4 }}>未配置</div>
      <ul className="list">
        {s.unplaced.filter(match).map(t => <Item key={t.id} t={t} />)}
        {s.unplaced.filter(match).length === 0 && <li className="empty" style={{ padding: "12px 2px" }}>該当する未配置のタスクはありません。</li>}
      </ul>
      {others.filter(match).length > 0 && <>
        <div className="section-title" style={{ margin: "16px 0 4px" }}>すでに予定があるタスク</div>
        <ul className="list">{others.filter(match).map(t => <Item key={t.id} t={t} sub="予定あり" />)}</ul>
      </>}
    </Sheet>
  )
}

// ============ 予定を分ける ============

function SplitSheet({ boxId }: { boxId: string }) {
  const s = useStore()
  const sheets = useSheets()
  const box = s.boxes.find(b => b.id === boxId)
  const task = box ? s.taskById.get(box.task_id) : undefined
  const [minutes, setMinutes] = useState(box ? Math.max(1, Math.floor(box.planned_minutes / 2 / 5) * 5 || 1) : 15)
  const [date, setDate] = useState(box ? addDays(box.date, 1) : s.today)
  const [win, setWin] = useState({ start: box?.window_start ?? 0, end: box?.window_end ?? 60 })
  const [busy, setBusy] = useState(false)
  if (!box || !task) return null
  const err = minutes < 1 || minutes >= box.planned_minutes ? `1分以上、${box.planned_minutes}分より短くしてください` : minutes > win.end - win.start ? "この時間帯に入りきりません" : null
  return (
    <Sheet title="予定を分ける" onClose={sheets.close} footer={<>
      <button type="button" className="btn" onClick={sheets.close}>キャンセル</button>
      <button type="button" className="btn primary" disabled={!!err || busy} onClick={async () => {
        setBusy(true)
        const ok = await s.splitBox(box.id, { minutes, date, window_start: win.start, window_end: win.end })
        setBusy(false)
        if (ok) sheets.close()
      }}>分ける</button>
    </>}>
      <p style={{ fontWeight: 600, marginBottom: 6, overflowWrap: "anywhere" }}>{task.text}</p>
      <p className="hint" style={{ marginBottom: 16 }}>いまの予定: {fmtMdDow(box.date)} {windowText(s.settings, box.window_start, box.window_end)} · {fmtDuration(box.planned_minutes)}</p>
      <div className="field">
        <label className="label">別の日へ移す時間（分）</label>
        <input type="number" className="input" min={1} max={box.planned_minutes - 1} value={minutes} style={{ maxWidth: 120 }} onChange={e => setMinutes(Math.round(Number(e.target.value)) || 0)} />
        <p className="hint">残り {Math.max(0, box.planned_minutes - minutes)}分 は元の予定に残ります</p>
      </div>
      <div className="field"><label className="label">移す日</label><input type="date" className="input" value={date} onChange={e => e.target.value && setDate(e.target.value)} /></div>
      <div className="field">
        <span className="label">時間帯</span>
        <Seg value={String(presetForWindow(s.settings, win.start, win.end)?.key ?? "custom")} onChange={k => { const p = s.settings.presets.find(x => x.key === k); if (p) setWin({ start: p.start, end: p.end }) }}
          options={s.settings.presets.map(p => ({ v: p.key as string, label: p.label }))} />
      </div>
      {err && <div className="notice danger" role="alert">{err}</div>}
    </Sheet>
  )
}

// ============ 予定を立て直す ============

function ReplanSheet() {
  const s = useStore()
  const sheets = useSheets()
  const missed = s.boxes
    .filter(b => b.status === "planned" && (b.date < s.today || (b.date === s.today && b.window_end <= s.now.minutes)))
    .sort((a, b) => (a.date + String(a.window_start).padStart(4, "0")).localeCompare(b.date + String(b.window_start).padStart(4, "0")))
  const tomorrow = addDays(s.today, 1)

  return (
    <Sheet title="予定を立て直す" onClose={sheets.close} wide footer={<button type="button" className="btn" onClick={sheets.close}>閉じる</button>}>
      <p className="hint" style={{ marginBottom: 12 }}>時間帯が過ぎた予定です。終わっていなくても失敗ではありません。いまの気分に合う動かし方を選んでください。</p>
      {missed.length === 0 && <p className="empty">立て直す予定はありません。</p>}
      <ul className="list">
        {missed.map(b => {
          const t = s.taskById.get(b.task_id)
          if (!t) return null
          return (
            <li key={b.id} className="row" style={{ display: "block" }}>
              <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{t.text}</div>
              <div className="row-meta" style={{ marginBottom: 8 }}>
                <span>{fmtMdDow(b.date)} {windowText(s.settings, b.window_start, b.window_end)}</span><span>{fmtDuration(b.planned_minutes)}</span>
              </div>
              <div className="chips">
                <button type="button" className="btn sm primary" onClick={async () => { if (await s.startNow(b.id)) sheets.close() }}>今から始める</button>
                <button type="button" className="btn sm" onClick={async () => { if (await s.startNow(b.id, 10)) sheets.close() }}>10分だけ</button>
                <button type="button" className="btn sm" onClick={async () => { if (await s.startNow(b.id, 15)) sheets.close() }}>15分だけ</button>
                <button type="button" className="btn sm" onClick={() => s.moveBox(b.id, { date: tomorrow }, "明日へ移動")}>明日へ</button>
                <button type="button" className="btn sm" onClick={() => sheets.open({ kind: "schedule", taskId: t.id, boxId: b.id, date: s.today })}>別の時間帯へ</button>
                <button type="button" className="btn sm" onClick={() => s.releaseBox(b.id)}>未配置に戻す</button>
                <button type="button" className="btn sm" onClick={() => s.toggleTask(t)}>完了にする</button>
              </div>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}

// ============ タスクの詳細（ホーム/計画の両方で使う） ============

export function TaskDetail({ taskId }: { taskId: string }) {
  const s = useStore()
  const sheets = useSheets()
  const t = s.taskById.get(taskId)
  if (!t) return <p className="empty">タスクが見つかりません。</p>
  const done = isTaskDone(t, s.today)
  const boxes = (s.boxesByTask.get(t.id) ?? []).filter(b => b.status !== "released").sort((a, b) => a.date.localeCompare(b.date) || a.window_start - b.window_start)
  const planned = boxes.filter(b => b.status === "planned").reduce((x, b) => x + b.planned_minutes, 0)
  const doneMin = boxes.filter(b => b.status === "done").reduce((x, b) => x + (b.actual_minutes ?? b.planned_minutes), 0)
  const est = t.estimate_minutes ?? null
  const kids = s.childrenOf.get(t.id) ?? []
  const pct = est ? Math.min(100, Math.round(((planned + doneMin) / est) * 100)) : 0

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 6 }}>
        <Check checked={done} label={`${t.text} を${done ? "未完了に戻す" : "完了にする"}`} onChange={() => s.toggleTask(t)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 17, overflowWrap: "anywhere" }} className={done ? "row-title is-done" : undefined}>{t.text}</h3>
          <div className="row-meta">
            {t.priority === "high" && <span>優先度 高</span>}
            {t.is_recurring && <span>{recurrenceLabel(t)}の繰り返し</span>}
            {t.due_date && <span className={!done && t.due_date < s.today ? "late" : undefined}>期限 {fmtMdDow(t.due_date)}（{relDay(t.due_date, s.today)}）</span>}
            {t.start_date && <span>開始 {fmtMdDow(t.start_date)}</span>}
          </div>
        </div>
      </div>

      {est !== null && (
        <div style={{ margin: "14px 0" }}>
          <div className="row-meta" style={{ marginBottom: 6 }}>見積り {fmtDuration(est)} ／ 予定済み {fmtDuration(planned + doneMin)}{est - planned - doneMin > 0 ? `（あと${fmtDuration(est - planned - doneMin)}が未配置）` : ""}</div>
          <div className="meter thin" style={{ ["--pct" as string]: `${pct}%` }}><i /></div>
        </div>
      )}
      {t.memo && <p style={{ whiteSpace: "pre-wrap", fontSize: 14, margin: "12px 0", overflowWrap: "anywhere" }}>{renderWithLinks(t.memo)}</p>}

      {kids.length > 0 && (
        <div style={{ margin: "14px 0" }}>
          <div className="section-title" style={{ marginBottom: 4 }}>サブタスク</div>
          <ul className="list">
            {kids.map(k => (
              <li key={k.id} className="row" style={{ alignItems: "center", padding: "6px 2px" }}>
                <Check small checked={isTaskDone(k, s.today)} label={`${k.text} を${isTaskDone(k, s.today) ? "未完了に戻す" : "完了にする"}`} onChange={() => s.toggleTask(k)} />
                <span className={isTaskDone(k, s.today) ? "row-title is-done" : "row-title"} style={{ fontSize: 14.5 }}>{k.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ margin: "18px 0 4px" }} className="section-title">予定</div>
      {boxes.length === 0 && <p className="empty" style={{ padding: "8px 2px" }}>まだ予定に入っていません。</p>}
      <ul>
        {boxes.map(b => (
          <li key={b.id} className="box-row">
            <div className="when">
              {fmtMdDow(b.date)} {windowText(s.settings, b.window_start, b.window_end)}
              <small>{fmtDuration(b.planned_minutes)}{b.status === "done" ? ` · 実施済み${b.kept_window === false ? "（時間帯の外で実施）" : ""}` : ""}</small>
            </div>
            {b.status === "planned" && (
              <Menu label={`${fmtMdDow(b.date)}の予定の操作`} items={[
                { label: "予定を変更", onClick: () => sheets.open({ kind: "schedule", taskId: t.id, boxId: b.id }) },
                ...(b.planned_minutes > 1 ? [{ label: "分ける", onClick: () => sheets.open({ kind: "split", boxId: b.id }) }] : []),
                { label: "今日はここまで（実施済みにする）", onClick: () => s.completeBox(b.id) },
                { label: "未配置に戻す", onClick: () => s.releaseBox(b.id), danger: true },
              ]} />
            )}
          </li>
        ))}
      </ul>
      <div className="chips" style={{ marginTop: 14 }}>
        {!done && <button type="button" className="btn sm primary" onClick={() => sheets.open({ kind: "schedule", taskId: t.id })}>予定に入れる</button>}
        <button type="button" className="btn sm" onClick={() => sheets.open({ kind: "edit", taskId: t.id })}>編集</button>
        {boxes.some(b => b.status === "planned") && <button type="button" className="btn sm quiet" onClick={() => s.unplaceTask(t.id)}>すべて未配置に戻す</button>}
      </div>
    </div>
  )
}

function DetailSheet({ taskId }: { taskId: string }) {
  const sheets = useSheets()
  return <Sheet title="詳細" onClose={sheets.close} wide><TaskDetail taskId={taskId} /></Sheet>
}

// ============ タスクの編集 / サブタスクの追加 ============

function TaskEditSheet({ taskId, parentId }: { taskId?: string; parentId?: string }) {
  const s = useStore()
  const sheets = useSheets()
  const task = taskId ? s.taskById.get(taskId) : undefined
  const parent = parentId ? s.taskById.get(parentId) : task?.parent_id ? s.taskById.get(task.parent_id) : undefined
  const isChild = !!parent
  const [f, setF] = useState({
    text: task?.text ?? "", priority: task?.priority ?? "mid", start_date: task?.start_date ?? "", due_date: task?.due_date ?? "",
    estimate: task?.estimate_minutes ? String(task.estimate_minutes) : "", is_recurring: task?.is_recurring ?? false,
    days: task?.recurring_days ? task.recurring_days.split(",").filter(Boolean).map(Number) : ([] as number[]),
    goal_id: task?.goal_id ?? "", mode: (task?.mode ?? s.mode) as "work" | "private", memo: task?.memo ?? "",
  })
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }))
  const goals = s.goals.filter(g => g.mode === f.mode)
  const dateErr = f.start_date && f.due_date && f.start_date > f.due_date ? "開始日は期限日より前にしてください" : null
  const estNum = f.estimate.trim() === "" ? null : Number(f.estimate)
  const estErr = estNum !== null && (!Number.isInteger(estNum) || estNum < 1 || estNum > 1440) ? "1〜1440分の整数で入力してください" : null
  const err = !f.text.trim() ? "タスク名を入力してください" : dateErr || estErr

  const save = async () => {
    if (err || busy) return
    setBusy(true)
    const body: Record<string, unknown> = {
      text: f.text.trim(), priority: f.priority, start_date: f.start_date || null, due_date: f.due_date || null,
      estimate_minutes: estNum, memo: f.memo,
    }
    if (!isChild) { body.is_recurring = f.is_recurring; body.recurring_days = f.is_recurring ? f.days.join(",") : "" }
    let ok = false
    if (task) {
      body.goal_id = f.goal_id || null
      if (f.mode !== task.mode) body.mode = f.mode
      ok = !!(await s.saveTask(task.id, body))
    } else {
      if (parentId) body.parent_id = parentId
      if (f.goal_id) body.goal_id = f.goal_id
      // 新規は null を送らず、入力のあるものだけ送る
      for (const k of ["start_date", "due_date", "estimate_minutes"]) if (body[k] === null) delete body[k]
      if (!body.memo) delete body.memo
      ok = !!(await s.addTask(body))
    }
    setBusy(false)
    if (ok) sheets.close()
  }

  return (
    <Sheet
      title={task ? "タスクを編集" : parent ? "サブタスクを追加" : "タスクを追加"}
      onClose={sheets.close}
      footer={<>
        {task && <button type="button" className="btn danger left" onClick={async () => { if (confirm(`「${task.text}」を削除しますか？${(s.childrenOf.get(task.id)?.length ?? 0) > 0 ? "\nサブタスクと予定も一緒に消えます。" : ""}`)) { await s.deleteTask(task.id); sheets.close() } }}>削除</button>}
        <button type="button" className="btn" onClick={sheets.close}>キャンセル</button>
        <button type="button" className="btn primary" disabled={!!err || busy} onClick={save}>保存</button>
      </>}
    >
      {parent && <p className="hint" style={{ marginBottom: 12 }}>「{parent.text}」のサブタスク（カテゴリは親と同じです）</p>}
      <div className="field">
        <label className="label" htmlFor="te-text">タスク名</label>
        <input id="te-text" className="input" value={f.text} maxLength={300} onChange={e => set("text", e.target.value)} onKeyDown={e => { if (e.key === "Enter") save() }} />
      </div>
      <div className="field">
        <span className="label">優先度</span>
        <Seg value={f.priority} onChange={v => set("priority", v)} options={[{ v: "high", label: "高" }, { v: "mid", label: "中" }, { v: "low", label: "低" }]} />
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="te-start">開始日</label><input id="te-start" type="date" className="input" value={f.start_date} onChange={e => set("start_date", e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="te-due">期限日</label><input id="te-due" type="date" className="input" value={f.due_date} onChange={e => set("due_date", e.target.value)} /></div>
      </div>
      {dateErr && <div className="notice danger" role="alert">{dateErr}</div>}
      <div className="field">
        <label className="label" htmlFor="te-est">所要時間（任意）</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input id="te-est" type="number" className="input" min={1} max={1440} placeholder="例 30" value={f.estimate} style={{ maxWidth: 120 }} onChange={e => set("estimate", e.target.value)} /><span>分</span>
        </div>
        {estErr ? <p className="hint" style={{ color: "var(--danger)" }}>{estErr}</p> : <p className="hint">入れておくと、予定に入れるときの作業時間の目安になります。</p>}
      </div>
      {!isChild && (
        <div className="field">
          <span className="label">繰り返し</span>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input type="checkbox" checked={f.is_recurring} onChange={e => set("is_recurring", e.target.checked)} /> 繰り返す
          </label>
          {f.is_recurring && (
            <div className="chips">
              <button type="button" className="chip" aria-pressed={f.days.length === 0} onClick={() => set("days", [])}>毎日</button>
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <button key={d} type="button" className="chip" aria-pressed={f.days.includes(d)} onClick={() => set("days", f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d])}>{DAY_LABELS[d]}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="te-goal">目標</label>
        <select id="te-goal" className="select" value={f.goal_id} onChange={e => set("goal_id", e.target.value)}>
          <option value="">（なし）</option>
          {goals.map(g => <option key={g.id} value={g.id}>{g.text}</option>)}
        </select>
      </div>
      {task && !isChild && (
        <div className="field">
          <span className="label">カテゴリ</span>
          <Seg value={f.mode} onChange={v => { set("mode", v); set("goal_id", "") }} options={[{ v: "work", label: "仕事" }, { v: "private", label: "プライベート" }]} />
          {f.mode !== task.mode && <div className="notice warn" style={{ marginTop: 10 }}>保存すると、このタスクのサブタスクと予定も{f.mode === "work" ? "仕事" : "プライベート"}へ移ります。目標との紐づけは外れます。</div>}
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="te-memo">メモ</label>
        <textarea id="te-memo" className="textarea" rows={3} value={f.memo} placeholder="URL はリンクになります" onChange={e => set("memo", e.target.value)} />
      </div>
      {err && !(dateErr || estErr) && <p className="hint" role="alert">{err}</p>}
    </Sheet>
  )
}

// ============ 固定予定 ============

function FixedEventSheet({ id, date: d0 }: { id?: string; date?: string }) {
  const s = useStore()
  const sheets = useSheets()
  const existing = id ? [...(s.weekSched?.fixedEvents ?? []), ...(s.homeSched?.fixedEvents ?? [])].find(f => f.event_id === id) : undefined
  const [title, setTitle] = useState(existing?.title ?? "")
  const [start, setStart] = useState(existing?.start_min ?? 19 * 60)
  const [end, setEnd] = useState(existing?.end_min ?? 20 * 60)
  const [date, setDate] = useState(existing?.date ?? d0 ?? s.today)
  const [repeat, setRepeat] = useState(false)
  const [days, setDays] = useState<number[]>([])
  const [until, setUntil] = useState("")
  const [allows, setAllows] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    api<{ id: string; date: string | null; repeat_days: string; until: string | null; allows_tasks: boolean }[]>(`/api/fixed-events?mode=${s.mode}`).then(rows => {
      const r = rows.find(x => x.id === id)
      if (!r) return
      setRepeat(!!r.repeat_days)
      setDays(r.repeat_days ? r.repeat_days.split(",").map(Number) : [])
      setUntil(r.until ?? "")
      setAllows(!!r.allows_tasks)
      if (r.date) setDate(r.date)
    }).catch(() => { /* 読めなくても編集は続けられる */ })
  }, [id, s.mode])

  const err = !title.trim() ? "予定名を入力してください" : !(start < end) ? "開始は終了より前にしてください" : repeat && days.length === 0 ? "繰り返す曜日を選んでください" : null
  return (
    <Sheet title={id ? "固定予定を編集" : "固定予定を追加"} onClose={sheets.close} footer={<>
      {id && <button type="button" className="btn danger left" onClick={async () => { if (confirm("この固定予定を削除しますか？（繰り返しの場合は、すべての日から消えます）")) { await s.deleteFixed(id); sheets.close() } }}>削除</button>}
      <button type="button" className="btn" onClick={sheets.close}>キャンセル</button>
      <button type="button" className="btn primary" disabled={!!err || busy} onClick={async () => {
        setBusy(true)
        const ok = await s.saveFixed(id ?? null, {
          title: title.trim(), start_min: start, end_min: end, date: date || null,
          repeat_days: repeat ? days.join(",") : "", until: repeat && until ? until : null, allows_tasks: allows,
        })
        setBusy(false)
        if (ok) sheets.close()
      }}>保存</button>
    </>}>
      <p className="hint" style={{ marginBottom: 14 }}>開始・終了が決まっている予定（仕事の時間、ジムなど）です。作業の予定の余白から差し引かれます。</p>
      <div className="field"><label className="label" htmlFor="fx-title">予定名</label><input id="fx-title" className="input" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} /></div>
      <div className="field-row">
        <TimeField label="開始" minutes={start} onChange={setStart} />
        <TimeField label="終了" minutes={end} onChange={setEnd} isEnd />
      </div>
      <div className="field">
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <input type="checkbox" checked={allows} onChange={e => setAllows(e.target.checked)} style={{ marginTop: 5 }} />
          <span>この時間に、{s.mode === "work" ? "仕事" : "プライベート"}の作業を入れてよい<span className="hint" style={{ display: "block" }}>勤務時間のような「枠」に使います。会議のように作業できない予定はオフのままにします。別のカテゴリの作業は、この時間に入れられません。</span></span>
        </label>
      </div>
      <div className="field">
        <span className="label">くり返し</span>
        <Seg value={repeat ? "weekly" : "once"} onChange={v => setRepeat(v === "weekly")} options={[{ v: "once", label: "この日だけ" }, { v: "weekly", label: "曜日で繰り返す" }]} />
      </div>
      <div className="field">
        <label className="label" htmlFor="fx-date">{repeat ? "開始日" : "日付"}</label>
        <input id="fx-date" type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
      </div>
      {repeat && (
        <>
          <div className="field">
            <span className="label">曜日</span>
            <div className="chips">
              {[1, 2, 3, 4, 5, 6, 0].map(d => <button key={d} type="button" className="chip" aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d])}>{DAY_LABELS[d]}</button>)}
            </div>
          </div>
          <div className="field"><label className="label" htmlFor="fx-until">終了日（任意）</label><input id="fx-until" type="date" className="input" value={until} onChange={e => setUntil(e.target.value)} /></div>
        </>
      )}
      {err && <p className="hint" role="alert">{err}</p>}
    </Sheet>
  )
}

// ============ 設定 ============

const TIMEZONES = ["Asia/Tokyo", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore", "Europe/London", "Europe/Paris", "America/New_York", "America/Los_Angeles", "UTC"]

function SettingsSheet() {
  const s = useStore()
  const sheets = useSheets()
  const [presets, setPresets] = useState(s.settings.presets.map(p => ({ ...p })))
  const [buffer, setBuffer] = useState(s.settings.bufferMinutes)
  const [tz, setTz] = useState(s.settings.timezone)
  const [busy, setBusy] = useState(false)
  const bad = presets.find(p => !(p.start < p.end) || !p.label.trim())
  const upd = (i: number, patch: Partial<(typeof presets)[number]>) => setPresets(ps => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  return (
    <Sheet title="設定" onClose={sheets.close} footer={<>
      <button type="button" className="btn" onClick={sheets.close}>キャンセル</button>
      <button type="button" className="btn primary" disabled={!!bad || busy} onClick={async () => {
        setBusy(true)
        const ok = await s.saveSettings({ presets, bufferMinutes: buffer, timezone: tz })
        setBusy(false)
        if (ok) sheets.close()
      }}>保存</button>
    </>}>
      <div className="section-title" style={{ marginBottom: 8 }}>時間帯</div>
      <p className="hint" style={{ marginBottom: 12 }}>「朝・昼・夜」の時間帯です。予定は、この時間帯の「どこか」で行います。</p>
      {presets.map((p, i) => (
        <div key={p.key} className="field-row" style={{ alignItems: "flex-end", marginBottom: 6 }}>
          <div className="field" style={{ maxWidth: 110 }}><label className="label">名前</label><input className="input" value={p.label} maxLength={8} onChange={e => upd(i, { label: e.target.value })} /></div>
          <TimeField label="開始" minutes={p.start} onChange={m => upd(i, { start: m })} />
          <TimeField label="終了" minutes={p.end} onChange={m => upd(i, { end: m })} isEnd />
        </div>
      ))}
      {bad && <div className="notice danger" role="alert">開始は終了より前にし、名前を入れてください</div>}
      <p className="hint" style={{ marginBottom: 18 }}>これ以外の時間帯は、予定に入れるときに「カスタム」で指定できます。</p>

      <div className="field">
        <label className="label" htmlFor="st-buf">移動・休憩の余白（1件ごと）</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input id="st-buf" type="number" className="input" min={0} max={120} value={buffer} style={{ maxWidth: 110 }} onChange={e => setBuffer(Math.round(Number(e.target.value)) || 0)} /><span>分</span>
        </div>
        <p className="hint">予定の作業時間に、この分を上乗せして空きと比べます。</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="st-tz">タイムゾーン</label>
        <select id="st-tz" className="select" value={tz} onChange={e => setTz(e.target.value)}>
          {(TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES]).map(z => <option key={z} value={z}>{z}</option>)}
        </select>
        <p className="hint">「今日」の日付はこのタイムゾーンで決まります。</p>
      </div>
    </Sheet>
  )
}

// ============ 目標 ============

function GoalSheet({ goalId }: { goalId?: string }) {
  const s = useStore()
  const sheets = useSheets()
  const g = goalId ? s.goals.find(x => x.id === goalId) : undefined
  const [text, setText] = useState(g?.text ?? "")
  const [due, setDue] = useState(g?.due_date ?? "")
  const [pct, setPct] = useState(g?.pct ?? 0)
  const [busy, setBusy] = useState(false)
  return (
    <Sheet title={g ? "目標を編集" : "目標を追加"} onClose={sheets.close} footer={<>
      {g && <button type="button" className="btn danger left" onClick={async () => { if (confirm(`「${g.text}」を削除しますか？`)) { await s.deleteGoal(g.id); sheets.close() } }}>削除</button>}
      <button type="button" className="btn" onClick={sheets.close}>キャンセル</button>
      <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={async () => {
        setBusy(true)
        if (g) { await s.saveGoal(g.id, { text: text.trim(), due_date: due || null, pct }); sheets.close() }
        else if (await s.addGoal(text.trim(), due)) sheets.close()
        setBusy(false)
      }}>保存</button>
    </>}>
      <div className="field"><label className="label" htmlFor="go-text">目標</label><input id="go-text" className="input" value={text} onChange={e => setText(e.target.value)} /></div>
      <div className="field"><label className="label" htmlFor="go-due">期日</label><input id="go-due" type="date" className="input" value={due} onChange={e => setDue(e.target.value)} /></div>
      {g && <div className="field"><label className="label" htmlFor="go-pct">進捗 {pct}%</label><input id="go-pct" type="range" min={0} max={100} value={pct} onChange={e => setPct(Number(e.target.value))} /></div>}
    </Sheet>
  )
}

// ============ メモ ============

function MemoSheet({ memoId }: { memoId?: string }) {
  const s = useStore()
  const sheets = useSheets()
  const m = memoId ? s.memos.find(x => x.id === memoId) : undefined
  const [editing, setEditing] = useState(!m)
  const [title, setTitle] = useState(m?.title ?? "")
  const [content, setContent] = useState(m?.content ?? "")
  const [tags, setTags] = useState(m?.tags ?? "")
  const [saved, setSaved] = useState<MemoRow | undefined>(m)
  const [busy, setBusy] = useState(false)
  const allTags = Array.from(new Set(s.memos.flatMap(x => parseTags(x.tags)))).sort()
  const shown = saved ?? m

  const save = async () => {
    setBusy(true)
    const r = await s.saveMemo(shown?.id ?? null, { title, content, tags: parseTags(tags).join(",") })
    setBusy(false)
    if (r) { setSaved(r); setTags(r.tags); setEditing(false) }
  }

  return (
    <Sheet title={editing ? (shown ? "メモを編集" : "新しいメモ") : "メモ"} onClose={sheets.close} wide footer={
      editing ? <>
        {shown && <button type="button" className="btn danger left" onClick={async () => { if (confirm("このメモを削除しますか？")) { await s.deleteMemo(shown.id); sheets.close() } }}>削除</button>}
        {shown && <button type="button" className="btn" onClick={() => { setTitle(shown.title); setContent(shown.content); setTags(shown.tags); setEditing(false) }}>キャンセル</button>}
        <button type="button" className="btn primary" disabled={busy} onClick={save}>保存</button>
      </> : <>
        {shown && <button type="button" className="btn danger left" onClick={async () => { if (confirm("このメモを削除しますか？")) { await s.deleteMemo(shown.id); sheets.close() } }}>削除</button>}
        <button type="button" className="btn primary" onClick={() => setEditing(true)}>編集</button>
      </>
    }>
      {editing ? (
        <>
          <div className="field"><label className="label" htmlFor="mm-title">タイトル</label><input id="mm-title" className="input" value={title} onChange={e => setTitle(e.target.value)} /></div>
          <div className="field">
            <label className="label" htmlFor="mm-tags">タグ（カンマ区切り）</label>
            <input id="mm-tags" className="input" value={tags} placeholder="例: 仕事, アイデア" onChange={e => setTags(e.target.value)} />
            {allTags.length > 0 && (
              <div className="chips" style={{ marginTop: 8 }}>
                {allTags.map(t => <button key={t} type="button" className="chip" onClick={() => { const cur = parseTags(tags); if (!cur.includes(t)) setTags([...cur, t].join(", ")) }}>＋ {t}</button>)}
              </div>
            )}
          </div>
          <div className="field"><label className="label" htmlFor="mm-body">本文</label><textarea id="mm-body" className="textarea" rows={10} value={content} placeholder="URL はリンクになります" onChange={e => setContent(e.target.value)} /></div>
        </>
      ) : (
        <>
          <h3 style={{ fontSize: 20, marginBottom: 8, overflowWrap: "anywhere" }}>{title || "（無題）"}</h3>
          {parseTags(tags).length > 0 && <div style={{ marginBottom: 12 }}>{parseTags(tags).map(t => <span key={t} className="tag">{t}</span>)}</div>}
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.75, overflowWrap: "anywhere" }}>{content ? renderWithLinks(content) : <span style={{ color: "var(--muted)" }}>（内容なし）</span>}</div>
        </>
      )}
    </Sheet>
  )
}
