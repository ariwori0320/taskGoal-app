"use client"

import { useState, useEffect, useCallback, useRef } from "react"

type Mode = "work" | "private"
type Priority = "high" | "mid" | "low"
type Filter = "active" | "done"
type Tab = "tasks" | "goals" | "memos"

interface Task {
  id: string
  text: string
  priority: Priority
  start_date: string | null
  due_date: string | null
  done: boolean
  parent_id: string | null
  memo: string | null
  mode: string
  is_recurring: boolean
  recurring_days: string  // "" = 毎日, "1,3,5" = 月水金 (0=日,1=月,...,6=土)
  recurring_done_date: string | null
  sort_order: number | null
  created_at: string
}

interface Goal {
  id: string
  text: string
  due_date: string | null
  pct: number
  created_at: string
}

interface Memo {
  id: string
  title: string
  content: string
  tags: string   // カンマ区切り "仕事,アイデア"
  updated_at: string
}

// "a, b ,c" → ["a","b","c"]
function parseTags(s: string | null | undefined): string[] {
  if (!s) return []
  return s.split(",").map(t => t.trim()).filter(Boolean)
}

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"]

const PRIORITY_CONFIG = {
  high: { label: "高", bg: "#fee2e2", color: "#dc2626", border: "#fca5a5" },
  mid:  { label: "中", bg: "#fef9c3", color: "#b45309", border: "#fde047" },
  low:  { label: "低", bg: "#dcfce7", color: "#16a34a", border: "#86efac" },
}

// ローカル時刻基準で YYYY-MM-DD を返す
// （toISOString() はUTCのため、JSTでは 0:00〜8:59 が前日になってしまう）
function toLocalISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

function today() { return toLocalISO(new Date()) }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

function isTaskDone(task: Task): boolean {
  if (task.is_recurring) return task.recurring_done_date === today()
  return task.done
}

function fmtDue(d: string | null) {
  if (!d) return ""
  const date = new Date(d + "T00:00:00")
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const diff = Math.round((date.getTime() - now.getTime()) / 86400000)
  if (diff === 0) return "今日"
  if (diff === 1) return "明日"
  if (diff < 0) return `${Math.abs(diff)}日超過`
  return `${diff}日後`
}

function fmtShort(d: string | null) {
  if (!d) return ""
  const [, m, day] = d.split("-")
  return `${Number(m)}/${Number(day)}`
}

function isOverdue(d: string | null) {
  if (!d) return false
  const date = new Date(d + "T00:00:00")
  const now = new Date(); now.setHours(0, 0, 0, 0)
  return date < now
}

// 繰り返しタスクの次回該当日（完了済みなら翌日以降から探す）
function nextRecurrenceDate(task: Task): string {
  const days = task.recurring_days ? task.recurring_days.split(",").filter(Boolean).map(Number) : [0, 1, 2, 3, 4, 5, 6]
  if (days.length === 0) return today()
  const doneToday = task.recurring_done_date === today()
  const base = new Date(); base.setHours(0, 0, 0, 0)
  for (let i = doneToday ? 1 : 0; i < 21; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i)
    if (days.includes(d.getDay())) return toLocalISO(d)
  }
  return today()
}

function fmtNextRecurrence(task: Task): string {
  const d = nextRecurrenceDate(task)
  if (d === today()) return "今日"
  const dt = new Date(d + "T00:00:00")
  if (dt.getTime() - new Date(today() + "T00:00:00").getTime() === 86400000) return "明日"
  return `${dt.getMonth() + 1}/${dt.getDate()}(${DAY_LABELS[dt.getDay()]})`
}

// 並び替え共通：繰り返し（毎日/繰り返し）タスクを常に最上部へ
function recurringFirst(a: Task, b: Task): number {
  if (a.is_recurring && !b.is_recurring) return -1
  if (!a.is_recurring && b.is_recurring) return 1
  return 0
}

// 自動並び替え：繰り返しを最上部 → 期限ありを上（期限が早い順）→ 残りは優先度の高い順
const PRANK: Record<Priority, number> = { high: 0, mid: 1, low: 2 }
function effDue(t: Task): string | null { return t.is_recurring ? null : t.due_date }
function autoCompare(a: Task, b: Task): number {
  const rec = recurringFirst(a, b)
  if (rec !== 0) return rec
  const ad = effDue(a), bd = effDue(b)
  if (ad && !bd) return -1
  if (!ad && bd) return 1
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1
  return (PRANK[a.priority] ?? 1) - (PRANK[b.priority] ?? 1)
}

// 手動並び替え：繰り返しを最上部 → sort_order 順
function manualCompare(a: Task, b: Task): number {
  const rec = recurringFirst(a, b)
  if (rec !== 0) return rec
  return (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY)
}

// テキスト中の URL をクリック可能なリンクに変換
function renderWithLinks(text: string) {
  if (!text) return null
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noopener noreferrer"
        style={{ color: "#2563eb", textDecoration: "underline", wordBreak: "break-all" }}
        onClick={e => e.stopPropagation()}>{p}</a>
    ) : (
      <span key={i}>{p}</span>
    )
  )
}

// ===== 入力サブコンポーネント（モジュールレベルで定義 → 再マウントによるフォーカス喪失を防ぐ） =====

function InlineTextEdit({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <input
      autoFocus
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => onSave(v)}
      onKeyDown={e => { if (e.key === "Enter") onSave(v); if (e.key === "Escape") onCancel() }}
      style={{ flex: 1, border: "1px solid #6366f1", borderRadius: "6px", padding: "2px 8px", fontSize: "14px", outline: "none" }}
    />
  )
}

function TaskMemoEditor({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <div style={{ padding: "6px 12px 10px 44px", background: "#fffbeb", borderBottom: "1px solid #f3f4f6" }}>
      <textarea
        autoFocus
        value={v}
        onChange={e => setV(e.target.value)}
        placeholder="メモを入力...（URLはリンクになります）"
        rows={2}
        style={{ width: "100%", border: "1px solid #fde047", borderRadius: "6px", padding: "6px 10px", fontSize: "13px", outline: "none", resize: "vertical", lineHeight: 1.5 }}
      />
      <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
        <button onClick={() => onSave(v)} style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "6px", padding: "4px 14px", cursor: "pointer", fontSize: "13px" }}>保存</button>
        <button onClick={onCancel} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", fontSize: "13px" }}>キャンセル</button>
      </div>
    </div>
  )
}

function ChildTaskInput({ onAdd, onCancel }: { onAdd: (text: string, priority: Priority, start: string, due: string) => void; onCancel: () => void }) {
  const [v, setV] = useState("")
  const [priority, setPriority] = useState<Priority>("mid")
  const [start, setStart] = useState("")
  const [due, setDue] = useState("")
  // 連打（Enter2回など）での重複追加を防ぐ（#7）
  const sentRef = useRef(false)
  const submit = () => {
    if (!v.trim() || sentRef.current) return
    sentRef.current = true
    onAdd(v, priority, start, due)
  }
  return (
    <div style={{ padding: "8px 12px 10px 44px", background: "#f9fafb", display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", gap: "6px" }}>
        <input
          autoFocus
          value={v}
          onChange={e => setV(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel() }}
          placeholder="サブタスクを入力..."
          style={{ flex: 1, minWidth: 0, border: "1px solid #e5e7eb", borderRadius: "6px", padding: "6px 10px", fontSize: "13px", outline: "none" }}
        />
        <button onClick={submit} style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px", flexShrink: 0 }}>追加</button>
        <button onClick={onCancel} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", flexShrink: 0 }}>×</button>
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
        <select value={priority} onChange={e => setPriority(e.target.value as Priority)} style={{ border: "1px solid #e5e7eb", borderRadius: "6px", padding: "5px 6px", fontSize: "12px", outline: "none" }}>
          <option value="high">🔴 高</option>
          <option value="mid">🟠 中</option>
          <option value="low">🟢 低</option>
        </select>
        <label style={{ fontSize: "11px", color: "#6b7280", display: "flex", alignItems: "center", gap: "3px" }}>
          開始<input type="date" value={start} onChange={e => setStart(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "6px", padding: "5px 6px", fontSize: "12px", outline: "none", maxWidth: "130px" }} />
        </label>
        <label style={{ fontSize: "11px", color: "#6b7280", display: "flex", alignItems: "center", gap: "3px" }}>
          期限<input type="date" value={due} onChange={e => setDue(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "6px", padding: "5px 6px", fontSize: "12px", outline: "none", maxWidth: "130px" }} />
        </label>
      </div>
    </div>
  )
}

// ===== タスク行コンポーネント（モジュールレベル・再帰） =====

interface TaskCtx {
  childrenMap: Map<string, Task[]>
  mode: Mode
  editingId: string | null
  setEditingId: (id: string | null) => void
  expandedMemoId: string | null
  setExpandedMemoId: (id: string | null) => void
  addingChildTo: string | null
  setAddingChildTo: (id: string | null) => void
  collapsedIds: Set<string>
  toggleCollapse: (id: string) => void
  dragEnabled: boolean
  draggingId: string | null
  dragOverId: string | null
  toggleTask: (id: string, task: Task) => void
  requestEdit: (id: string) => void
  saveTaskText: (id: string, text: string) => void
  saveTaskMemo: (id: string, memo: string) => void
  openEditModal: (task: Task) => void
  deleteTask: (id: string) => void
  addChild: (parentId: string, text: string, priority: Priority, start: string, due: string) => void
  onRowPointerDown: (e: React.PointerEvent, id: string) => void
}

function TaskItem({ task, level, ctx }: { task: Task; level: number; ctx: TaskCtx }) {
  const children = ctx.childrenMap.get(task.id) ?? []
  const hasChildren = children.length > 0
  const collapsed = ctx.collapsedIds.has(task.id)
  const isChild = level > 0
  const pc = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.mid
  const isEditing = ctx.editingId === task.id
  const isMemoOpen = ctx.expandedMemoId === task.id
  const done = isTaskDone(task)
  const isDragTarget = level === 0 && ctx.dragOverId === task.id && ctx.draggingId !== task.id
  const isDragging = level === 0 && ctx.draggingId === task.id

  return (
    <div>
      <div
        className="task-item"
        {...(level === 0 ? { "data-task-id": task.id } : {})}
        style={{
          paddingLeft: isChild ? "8px" : "14px",
          paddingRight: "8px",
          paddingTop: isChild ? "7px" : undefined,
          paddingBottom: isChild ? "7px" : undefined,
          flexWrap: "nowrap", gap: "6px", alignItems: "center",
          opacity: isDragging ? 0.4 : 1,
          background: isDragging ? "#eef2ff" : (isChild ? "#fcfcfd" : undefined),
          borderTop: isDragTarget ? "2px solid #6366f1" : undefined,
        }}
        onPointerDown={level === 0 && ctx.dragEnabled ? (e) => ctx.onRowPointerDown(e, task.id) : undefined}
      >
        {level === 0 && ctx.dragEnabled && (
          <span aria-hidden="true" title="長押しで並び替え" style={{ cursor: "grab", color: "#cbd5e1", fontSize: "14px", flexShrink: 0, userSelect: "none", lineHeight: 1, touchAction: "none" }}>⠿</span>
        )}

        {/* 折りたたみ / ツリー記号 */}
        {hasChildren ? (
          <button onClick={() => ctx.toggleCollapse(task.id)} title={collapsed ? "展開" : "折りたたみ"}
            aria-label={collapsed ? "サブタスクを展開" : "サブタスクを折りたたむ"} aria-expanded={!collapsed}
            style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: "10px", width: "14px", flexShrink: 0, padding: 0, lineHeight: 1 }}>
            {collapsed ? "▶" : "▼"}
          </button>
        ) : isChild ? (
          <span aria-hidden="true" style={{ color: "#d1d5db", fontSize: "12px", flexShrink: 0, width: "10px", textAlign: "center" }}>↳</span>
        ) : null}

        <div className={`task-check ${done ? "task-check-done" : ""}`}
          role="checkbox" aria-checked={done} aria-label={`${task.text} を${done ? "未完了に戻す" : "完了にする"}`} tabIndex={0}
          style={isChild ? { width: "16px", height: "16px", fontSize: "10px" } : undefined}
          onClick={() => ctx.toggleTask(task.id, task)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ctx.toggleTask(task.id, task) } }}>
          {done ? "✓" : ""}
        </div>

        {/* コンテンツ群（バッジ・テキスト・日付）: 幅が足りなければ内部で折り返す */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "5px", rowGap: "3px" }}>
          {task.is_recurring && (
            <span style={{ background: "#e0f2fe", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: "4px", padding: "1px 5px", fontSize: "10px", fontWeight: 700, flexShrink: 0 }}>
              🔁{task.recurring_days ? task.recurring_days.split(",").map(d => DAY_LABELS[Number(d)]).join("・") : "毎日"}
            </span>
          )}

          <span style={{
            background: pc.bg, color: pc.color, border: `1px solid ${pc.border}`,
            borderRadius: "4px", padding: "1px 6px", fontSize: isChild ? "10px" : "11px", fontWeight: 700, flexShrink: 0,
          }}>{pc.label}</span>

          {isEditing ? (
            <InlineTextEdit
              initial={task.text}
              onSave={(v) => ctx.saveTaskText(task.id, v)}
              onCancel={() => ctx.setEditingId(null)}
            />
          ) : (
            <div
              className={`task-text ${done ? "task-text-done" : ""}`}
              style={{ flex: "1 1 auto", minWidth: 0, fontSize: isChild ? "13px" : "14px", color: isChild && !done ? "#4b5563" : undefined, overflowWrap: "anywhere", wordBreak: "break-word" }}
              onClick={() => ctx.requestEdit(task.id)}
            >{task.text}</div>
          )}

          {/* 日付：繰り返しは「次回」、通常は開始〜期限 */}
          {task.is_recurring ? (
            <div className="task-due" style={{ color: "#0369a1", fontWeight: 600, flexShrink: 0 }}>次回 {fmtNextRecurrence(task)}</div>
          ) : (
            <>
              {task.start_date && <div className="task-due" style={{ color: "#6b7280", flexShrink: 0 }}>{fmtShort(task.start_date)}〜</div>}
              {task.due_date && (
                <div className={`task-due ${!done && isOverdue(task.due_date) ? "task-due-overdue" : ""}`} style={{ flexShrink: 0 }}>
                  {task.start_date ? fmtShort(task.due_date) : fmtDue(task.due_date)}
                </div>
              )}
            </>
          )}

          {hasChildren && (
            <span style={{ fontSize: "10px", color: "#6b7280", background: "#f3f4f6", borderRadius: "4px", padding: "1px 6px", fontWeight: 600, flexShrink: 0 }}>サブ{children.length}</span>
          )}
        </div>

        {/* アクション群（右端に固定） */}
        <div style={{ display: "flex", alignItems: "center", gap: "1px", flexShrink: 0 }}>
          <button onClick={() => ctx.openEditModal(task)} aria-label={`${task.text} を編集`} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "13px", padding: "2px 2px", color: "#6b7280" }} title="編集">✏️</button>
          <button onClick={() => ctx.setExpandedMemoId(isMemoOpen ? null : task.id)} aria-label={`${task.text} のメモ`} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "14px", padding: "2px 2px", opacity: task.memo ? 1 : 0.4 }} title="メモ">📝</button>
          {level < 2 && (
            <button onClick={() => ctx.setAddingChildTo(task.id)} aria-label={`${task.text} にサブタスクを追加`} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", fontSize: "15px", padding: "2px 2px" }} title="サブタスクを追加">＋</button>
          )}
          <button className="del-btn" onClick={() => ctx.deleteTask(task.id)} aria-label={`${task.text} を削除`} title="削除">×</button>
        </div>
      </div>

      {/* メモ表示（読み取り：リンク有効） */}
      {!isMemoOpen && task.memo && (
        <div style={{ padding: "2px 12px 8px 44px", fontSize: "12px", color: "#92400e", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
          📝 {renderWithLinks(task.memo)}
        </div>
      )}

      {/* メモ編集 */}
      {isMemoOpen && (
        <TaskMemoEditor
          initial={task.memo || ""}
          onSave={(v) => ctx.saveTaskMemo(task.id, v)}
          onCancel={() => ctx.setExpandedMemoId(null)}
        />
      )}

      {/* サブタスク追加 */}
      {ctx.addingChildTo === task.id && (
        <ChildTaskInput
          onAdd={(text, priority, start, due) => { ctx.addChild(task.id, text, priority, start, due); ctx.setAddingChildTo(null) }}
          onCancel={() => ctx.setAddingChildTo(null)}
        />
      )}

      {/* 子タスク（インデント＋ガイド線で関連を明示・折りたたみ対応） */}
      {hasChildren && !collapsed && (
        <div style={{ marginLeft: "22px", borderLeft: "2px solid #e0e7ff", paddingLeft: "2px" }}>
          {children.map(child => (
            <TaskItem key={child.id} task={child} level={level + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 今年/今月の目標バナー =====

function HighlightBanner({ icon, label, value, accentColor, onSave }: { icon: string; label: string; value: string; accentColor: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])

  if (editing) {
    return (
      <div style={{ background: "white", border: `1px solid ${accentColor}`, borderRadius: "12px", padding: "10px 14px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: accentColor, marginBottom: "6px" }}>{icon} {label}</div>
        <textarea
          autoFocus
          value={v}
          onChange={e => setV(e.target.value)}
          rows={2}
          placeholder={`${label}を入力...`}
          style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 10px", fontSize: "14px", outline: "none", resize: "vertical", lineHeight: 1.5 }}
        />
        <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
          <button onClick={() => { onSave(v); setEditing(false) }} style={{ background: accentColor, color: "white", border: "none", borderRadius: "6px", padding: "4px 14px", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>保存</button>
          <button onClick={() => { setV(value); setEditing(false) }} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", fontSize: "13px" }}>キャンセル</button>
        </div>
      </div>
    )
  }

  return (
    <div
      onClick={() => setEditing(true)}
      style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: "12px", padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: "10px" }}
    >
      <div style={{ fontSize: "12px", fontWeight: 700, color: accentColor, whiteSpace: "nowrap" }}>{icon} {label}</div>
      <div style={{ flex: 1, fontSize: "14px", color: value ? "#111827" : "#9ca3af", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
        {value || "タップして設定"}
      </div>
      <span style={{ fontSize: "13px", color: "#9ca3af" }}>✏️</span>
    </div>
  )
}

export default function Home() {
  const taskInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<Mode>("work")
  const [tab, setTab] = useState<Tab>("tasks")
  const [tasks, setTasks] = useState<Task[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [memos, setMemos] = useState<Memo[]>([])
  const [yearGoal, setYearGoal] = useState("")
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>("active")
  const [sortMode, setSortMode] = useState<"manual" | "auto">("auto")

  // Task form
  const [taskPriority, setTaskPriority] = useState<Priority>("mid")
  const [taskStart, setTaskStart] = useState("")
  const [taskDue, setTaskDue] = useState("")
  const [taskRecurring, setTaskRecurring] = useState(false)
  const [taskRecurringDays, setTaskRecurringDays] = useState<number[]>([])

  // 期間フィルター
  const [rangeStart, setRangeStart] = useState("")
  const [rangeEnd, setRangeEnd] = useState("")

  // Task edit modal
  const [editModal, setEditModal] = useState<Task | null>(null)
  const [editForm, setEditForm] = useState({ text: "", priority: "mid" as Priority, start_date: "", due_date: "", is_recurring: false, recurring_days: [] as number[], memo: "" })

  // Task interaction state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedMemoId, setExpandedMemoId] = useState<string | null>(null)
  const [addingChildTo, setAddingChildTo] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  function toggleCollapse(id: string) {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Goal form
  const [goalText, setGoalText] = useState("")
  const [goalDue, setGoalDue] = useState("")

  // Goal edit modal
  const [editGoalModal, setEditGoalModal] = useState<Goal | null>(null)
  const [goalEditForm, setGoalEditForm] = useState({ text: "", due_date: "", pct: 0 })

  // Memo modal
  const [memoModal, setMemoModal] = useState<{ open: boolean; editing: boolean; id: string | null }>({ open: false, editing: false, id: null })
  const [memoTitle, setMemoTitle] = useState("")
  const [memoContent, setMemoContent] = useState("")
  const [memoTags, setMemoTags] = useState("")

  // メモ検索・タグ絞り込み
  const [memoSearch, setMemoSearch] = useState("")
  const [memoTagFilter, setMemoTagFilter] = useState<string | null>(null)

  // Drag & drop reorder
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // Pct debounce
  const pctTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // トースト通知
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [t, g, m, h] = await Promise.all([
        fetch(`/api/tasks?mode=${mode}`).then(r => r.json()),
        fetch(`/api/goals?mode=${mode}`).then(r => r.json()),
        fetch(`/api/memos?mode=${mode}`).then(r => r.json()),
        fetch(`/api/highlights?mode=${mode}`).then(r => r.json()),
      ])
      setTasks(Array.isArray(t) ? t : [])
      setGoals(Array.isArray(g) ? g : [])
      setMemos(Array.isArray(m) ? m : [])
      setYearGoal(h?.year || "")
    } catch (e) {
      console.error(e)
      // 失敗時に前モードのデータが残らないようクリアし、エラーを通知（#4）
      setTasks([]); setGoals([]); setMemos([])
      setYearGoal("")
      notify("読み込みに失敗しました")
    }
    finally { setLoading(false) }
  }, [mode, notify])

  useEffect(() => { fetchAll() }, [fetchAll])

  // 変更系API共通：失敗を検知して通知し、サーバー状態と再同期する（#3）
  const apiMutate = useCallback(async (url: string, init: RequestInit, errMsg: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init })
      if (!res.ok) { notify(errMsg); fetchAll(); return false }
      return true
    } catch {
      notify("通信エラーが発生しました"); fetchAll(); return false
    }
  }, [notify, fetchAll])

  // 表示設定（並び順・フィルタ・折りたたみ）を記憶し、リロード後も保持する（#14）
  const prefsLoaded = useRef(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    const savedSort = localStorage.getItem("taskSortMode")
    if (savedSort === "manual" || savedSort === "auto") setSortMode(savedSort)
    const savedFilter = localStorage.getItem("taskFilter")
    if (savedFilter === "active" || savedFilter === "done") setFilter(savedFilter)
    try {
      const savedCollapsed = JSON.parse(localStorage.getItem("collapsedTaskIds") || "[]")
      if (Array.isArray(savedCollapsed)) setCollapsedIds(new Set(savedCollapsed))
    } catch { /* 壊れた値は無視 */ }
    prefsLoaded.current = true
  }, [])

  useEffect(() => {
    // 読み込み前に初期値で上書きしないようガード
    if (!prefsLoaded.current || typeof window === "undefined") return
    localStorage.setItem("taskSortMode", sortMode)
    localStorage.setItem("taskFilter", filter)
    localStorage.setItem("collapsedTaskIds", JSON.stringify(Array.from(collapsedIds)))
  }, [sortMode, filter, collapsedIds])

  // ---- Task actions ----
  async function addTask(text: string, parentId: string | null = null, priority: Priority = "mid", start = "", due = "") {
    if (!text.trim()) return
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(), priority,
          start_date: start || null,
          due_date: due || null,
          mode, parent_id: parentId,
          is_recurring: parentId ? false : taskRecurring,
          recurring_days: parentId ? "" : taskRecurringDays.join(","),
        }),
      })
      const json = await res.json()
      if (!res.ok || !json?.id) { notify(`タスク追加に失敗しました: ${json?.error || res.status}`); return }
      // 全件再取得せず、作成されたタスクを差し込む（#9）
      setTasks(prev => [json as Task, ...prev])
    } catch {
      notify("通信エラーが発生しました")
    }
  }

  // 連打による重複作成を防ぐ（#7）
  // state だけだと同一tick内の2回目でまだ false のため、ref で同期的に判定する
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleAddMainTask() {
    const val = taskInputRef.current?.value || ""
    if (!val.trim() || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await addTask(val, null, taskPriority, taskStart, taskDue)
      if (taskInputRef.current) taskInputRef.current.value = ""
      setTaskPriority("mid"); setTaskStart(""); setTaskDue("")
      setTaskRecurring(false); setTaskRecurringDays([])
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function addChild(parentId: string, text: string, priority: Priority, start: string, due: string) {
    addTask(text, parentId, priority, start, due)
  }

  async function toggleTask(id: string, task: Task) {
    const body = task.is_recurring
      ? { recurring_done_date: task.recurring_done_date === today() ? null : today() }
      : { done: !task.done }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...body } : t))
    await apiMutate(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }, "完了状態の保存に失敗しました")
  }

  async function saveTaskText(id: string, text: string) {
    if (!text.trim()) { setEditingId(null); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, text } : t))
    setEditingId(null)
    await apiMutate(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ text }) }, "タスク名の保存に失敗しました")
  }

  async function saveTaskMemo(id: string, memo: string) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, memo } : t))
    setExpandedMemoId(null)
    await apiMutate(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ memo }) }, "メモの保存に失敗しました")
  }

  async function deleteTask(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id && t.parent_id !== id))
    await apiMutate(`/api/tasks/${id}`, { method: "DELETE" }, "タスクの削除に失敗しました")
  }

  function openEditModal(task: Task) {
    setEditModal(task)
    setEditForm({
      text: task.text,
      priority: task.priority,
      start_date: task.start_date ?? "",
      due_date: task.due_date ?? "",
      is_recurring: task.is_recurring,
      recurring_days: task.recurring_days ? task.recurring_days.split(",").filter(Boolean).map(Number) : [],
      memo: task.memo ?? "",
    })
  }

  async function saveEditModal() {
    if (!editModal) return
    const updates = {
      text: editForm.text,
      priority: editForm.priority,
      start_date: editForm.start_date || null,
      due_date: editForm.due_date || null,
      is_recurring: editForm.is_recurring,
      recurring_days: editForm.is_recurring ? editForm.recurring_days.join(",") : "",
      memo: editForm.memo,
    }
    setTasks(prev => prev.map(t => t.id === editModal.id ? { ...t, ...updates } : t))
    setEditModal(null)
    await apiMutate(`/api/tasks/${editModal.id}`, { method: "PATCH", body: JSON.stringify(updates) }, "タスクの保存に失敗しました")
  }

  // ---- Goal actions ----
  async function addGoal() {
    if (!goalText.trim() || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const res = await fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: goalText, due_date: goalDue || null, mode }) })
      const goal: Goal = await res.json()
      // res.ok と id を検査（失敗時に壊れた行が混入するのを防ぐ / #5）
      if (!res.ok || !goal?.id) { notify("目標の追加に失敗しました"); return }
      setGoals(prev => [goal, ...prev])
      setGoalText(""); setGoalDue("")
    } catch {
      notify("通信エラーが発生しました")
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function updateGoalPct(id: string, pct: number) {
    setGoals(prev => prev.map(g => g.id === id ? { ...g, pct } : g))
    clearTimeout(pctTimers.current[id])
    pctTimers.current[id] = setTimeout(() => {
      apiMutate(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify({ pct }) }, "進捗の保存に失敗しました")
    }, 400)
  }

  function openGoalEdit(g: Goal) {
    setEditGoalModal(g)
    setGoalEditForm({ text: g.text, due_date: g.due_date ?? "", pct: g.pct })
  }

  async function saveGoalEdit() {
    if (!editGoalModal || !goalEditForm.text.trim()) return
    const updates = { text: goalEditForm.text.trim(), due_date: goalEditForm.due_date || null, pct: goalEditForm.pct }
    setGoals(prev => prev.map(g => g.id === editGoalModal.id ? { ...g, ...updates } : g))
    setEditGoalModal(null)
    await apiMutate(`/api/goals/${editGoalModal.id}`, { method: "PATCH", body: JSON.stringify(updates) }, "目標の保存に失敗しました")
  }

  async function deleteGoal(id: string) {
    setGoals(prev => prev.filter(g => g.id !== id))
    await apiMutate(`/api/goals/${id}`, { method: "DELETE" }, "目標の削除に失敗しました")
  }

  // ---- Highlights ----
  async function saveYearGoal(text: string) {
    setYearGoal(text)
    await apiMutate("/api/highlights", { method: "PATCH", body: JSON.stringify({ mode, year_text: text }) }, "目標の保存に失敗しました")
  }

  // ---- Memo actions ----
  function openMemo(m: Memo) {
    setMemoModal({ open: true, editing: false, id: m.id })
    setMemoTitle(m.title); setMemoContent(m.content); setMemoTags(m.tags || "")
  }

  function newMemo() {
    setMemoModal({ open: true, editing: true, id: null })
    setMemoTitle(""); setMemoContent(""); setMemoTags("")
  }

  async function saveMemo() {
    // 入力された "a, b" を正規化して保存
    const normalizedTags = parseTags(memoTags).join(",")
    const payload = { title: memoTitle, content: memoContent, tags: normalizedTags }
    if (memoModal.id) {
      const res = await fetch(`/api/memos/${memoModal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      if (!res.ok) { notify("メモの保存に失敗しました"); return }
      setMemos(prev => prev.map(m => m.id === memoModal.id ? { ...m, ...payload } : m))
      setMemoTags(normalizedTags)
      setMemoModal(prev => ({ ...prev, editing: false }))
    } else {
      const res = await fetch("/api/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, mode }) })
      const memo: Memo = await res.json()
      if (!res.ok || !memo?.id) { notify("メモの作成に失敗しました"); return }
      setMemos(prev => [memo, ...prev])
      setMemoTags(normalizedTags)
      setMemoModal({ open: true, editing: false, id: memo.id })
    }
  }

  async function deleteMemo(id: string) {
    setMemos(prev => prev.filter(m => m.id !== id))
    setMemoModal({ open: false, editing: false, id: null })
    await apiMutate(`/api/memos/${id}`, { method: "DELETE" }, "メモの削除に失敗しました")
  }

  // ---- Derived ----
  const accentCls = mode === "work" ? "work" : "private"
  const accentColor = mode === "work" ? "#2563eb" : "#7c3aed"

  function inRange(task: Task): boolean {
    if (!rangeStart && !rangeEnd) return true
    if (task.is_recurring) return true
    const s = task.start_date || task.due_date
    const e = task.due_date || task.start_date
    if (!s && !e) return false
    const ts = s as string, te = e as string
    if (rangeStart && te < rangeStart) return false
    if (rangeEnd && ts > rangeEnd) return false
    return true
  }

  // parent_id → 子タスク の Map を1度だけ構築（各行での filter を廃止 / #12）
  const childrenMap = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.parent_id) continue
    const arr = childrenMap.get(t.parent_id)
    if (arr) arr.push(t)
    else childrenMap.set(t.parent_id, [t])
  }

  const parentBase = tasks.filter(t => !t.parent_id)
  const parentTasks = sortMode === "auto"
    ? [...parentBase].sort(autoCompare)
    : [...parentBase].sort(manualCompare)
  const rangedParents = parentTasks.filter(inRange)
  const filteredParents = filter === "done"
    ? rangedParents.filter(t => isTaskDone(t))
    : rangedParents.filter(t => !isTaskDone(t))

  const activeCnt = tasks.filter(t => !isTaskDone(t) && !t.parent_id).length
  const doneCnt = tasks.filter(t => isTaskDone(t) && !t.parent_id).length
  const overdueCnt = tasks.filter(t => !isTaskDone(t) && !t.is_recurring && isOverdue(t.due_date)).length
  const avgGoal = goals.length ? Math.round(goals.reduce((a, g) => a + g.pct, 0) / goals.length) : 0

  // メモ：タグ一覧と検索/タグ絞り込み（タイトル・本文・タグを対象）
  const allMemoTags = Array.from(new Set(memos.flatMap(m => parseTags(m.tags)))).sort()
  const memoQuery = memoSearch.trim().toLowerCase()
  const filteredMemos = memos.filter(m => {
    if (memoTagFilter && !parseTags(m.tags).includes(memoTagFilter)) return false
    if (!memoQuery) return true
    return (
      (m.title || "").toLowerCase().includes(memoQuery) ||
      (m.content || "").toLowerCase().includes(memoQuery) ||
      (m.tags || "").toLowerCase().includes(memoQuery)
    )
  })

  // ---- Drag & drop (長押し→ドラッグ, タッチ対応) ----
  const draggingRef = useRef<string | null>(null)
  const dragOverRef = useRef<string | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPt = useRef({ x: 0, y: 0 })
  const reorderRef = useRef<(src: string, over: string) => void>(() => {})
  const suppressClickRef = useRef(false)

  function requestEdit(id: string) {
    if (suppressClickRef.current) return
    setEditingId(id)
  }

  // 表示中の全親タスクを整数で採番し直す（初回や値が詰まった時のみ実行 / #11の重複も解消）
  async function renumberAll(orderedIds: string[]) {
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
    setTasks(prev => prev.map(t => orderMap.has(t.id) ? { ...t, sort_order: orderMap.get(t.id)! } : t))
    try {
      const results = await Promise.all(orderedIds.map((id, i) =>
        fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: i }) })
      ))
      if (results.some(r => !r.ok)) { notify("並び順の保存に失敗しました"); fetchAll() }
    } catch {
      notify("通信エラーが発生しました"); fetchAll()
    }
  }

  async function reorderTasks(srcId: string, overId: string) {
    if (!srcId || !overId || srcId === overId) return
    const list = filteredParents
    const from = list.findIndex(t => t.id === srcId)
    const to = list.findIndex(t => t.id === overId)
    if (from === -1 || to === -1) return

    // 移動後の並びを作り、挿入位置の前後から新しい sort_order を求める
    const moved = [...list]
    const [src] = moved.splice(from, 1)
    moved.splice(to, 0, src)
    const pv = typeof moved[to - 1]?.sort_order === "number" ? moved[to - 1].sort_order as number : null
    const nv = typeof moved[to + 1]?.sort_order === "number" ? moved[to + 1].sort_order as number : null

    let newVal: number | null = null
    if (pv === null && nv !== null) newVal = nv - 1
    else if (pv !== null && nv === null) newVal = pv + 1
    else if (pv !== null && nv !== null && nv - pv > 1e-6) newVal = (pv + nv) / 2
    // pv/nv が両方nullか、値が詰まっている場合は newVal = null（採番し直しへ）

    if (newVal !== null) {
      // 移動した1件だけ更新（従来は表示中の全件をPATCHしていた / #8）
      setTasks(prev => prev.map(t => t.id === srcId ? { ...t, sort_order: newVal } : t))
      await apiMutate(`/api/tasks/${srcId}`, { method: "PATCH", body: JSON.stringify({ sort_order: newVal }) }, "並び順の保存に失敗しました")
      return
    }

    // フォールバック: 完了/未完了を問わず全親タスクを採番し直す（#11の重複解消）
    const rest = parentTasks.filter(t => t.id !== srcId)
    const overIdx = rest.findIndex(t => t.id === overId)
    const insertAt = overIdx === -1 ? rest.length : (from < to ? overIdx + 1 : overIdx)
    rest.splice(insertAt, 0, src)
    await renumberAll(rest.map(t => t.id))
  }
  reorderRef.current = reorderTasks

  const pointAt = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const row = el?.closest("[data-task-id]") as HTMLElement | null
    return row?.getAttribute("data-task-id") ?? null
  }, [])

  // 進行中ドラッグのリスナ解除関数を保持（確実に後始末するため / #6）
  const dragCleanupRef = useRef<(() => void) | null>(null)

  // ドラッグ状態を完全にリセットする。どの終了経路（up / cancel / スクロール判定 / アンマウント）でも必ず通す
  const resetDrag = useCallback((didDrag: boolean) => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
    dragCleanupRef.current?.()
    dragCleanupRef.current = null
    if (didDrag) {
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 300)
    }
    draggingRef.current = null
    dragOverRef.current = null
    setDraggingId(null)
    setDragOverId(null)
  }, [])

  const onRowPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest("button, input, textarea, a, select, .task-check")) return // 操作系からはドラッグ開始しない

    resetDrag(false) // 前回のドラッグが残っていれば確実に解除
    startPt.current = { x: e.clientX, y: e.clientY }

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) {
        // 長押し確定前に動いた = スクロール意図とみなして中止
        const dx = Math.abs(ev.clientX - startPt.current.x)
        const dy = Math.abs(ev.clientY - startPt.current.y)
        if (dx > 8 || dy > 8) resetDrag(false)
        return
      }
      const over = pointAt(ev.clientX, ev.clientY)
      if (over !== dragOverRef.current) { dragOverRef.current = over; setDragOverId(over) }
    }
    const onUp = (ev: PointerEvent) => {
      const src = draggingRef.current
      const over = src ? pointAt(ev.clientX, ev.clientY) : null
      resetDrag(!!src)
      if (src && over && over !== src) reorderRef.current(src, over)
    }
    // OSジェスチャ等で中断された場合。これが無いとドラッグ状態が残り、
    // touchmove の preventDefault によりページがスクロールできなくなる（#6）
    const onCancel = () => resetDrag(!!draggingRef.current)

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
    }

    pressTimer.current = setTimeout(() => {
      draggingRef.current = id
      setDraggingId(id)
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(15)
    }, 280)
  }, [pointAt, resetDrag])

  // ドラッグ中はスクロールを抑止（タッチ）
  useEffect(() => {
    const handler = (ev: TouchEvent) => { if (draggingRef.current) ev.preventDefault() }
    document.addEventListener("touchmove", handler, { passive: false })
    return () => document.removeEventListener("touchmove", handler)
  }, [])

  // アンマウント時にリスナとドラッグ状態を確実に解放（#6 のリーク対策）
  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    dragCleanupRef.current?.()
    draggingRef.current = null
  }, [])

  const ctx: TaskCtx = {
    childrenMap, mode, editingId, setEditingId, expandedMemoId, setExpandedMemoId,
    addingChildTo, setAddingChildTo, collapsedIds, toggleCollapse, dragEnabled: sortMode === "manual", draggingId, dragOverId,
    toggleTask, requestEdit, saveTaskText, saveTaskMemo, openEditModal, deleteTask, addChild, onRowPointerDown,
  }

  return (
    <>
      {/* Header */}
      <header className="header">
        <img src="/logo.png" alt="MyFlow" style={{ height: "44px", objectFit: "contain" }} />
        <div className="mode-toggle">
          <button className={`mode-btn ${mode === "work" ? "active-work" : ""}`} onClick={() => setMode("work")}>💼 仕事</button>
          <button className={`mode-btn ${mode === "private" ? "active-priv" : ""}`} onClick={() => setMode("private")}>🏠 プライベート</button>
        </div>
      </header>

      {/* Stats */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 12px 0" }}>
        <div className="stats">
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{activeCnt}</div><div className="stat-label">未完了</div></div>
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{doneCnt}</div><div className="stat-label">完了</div></div>
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{overdueCnt}</div><div className="stat-label">期限超過</div></div>
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{avgGoal}%</div><div className="stat-label">目標進捗</div></div>
        </div>
      </div>

      {/* Tab + Content */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 12px" }}>
        <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: "#f3f4f6", borderRadius: "10px", padding: "4px", width: "fit-content" }}>
          {([["tasks", "✅ タスク"], ["goals", "🎯 目標"], ["memos", "📝 メモ"]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 20px", borderRadius: "8px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "14px",
              background: tab === t ? accentColor : "transparent",
              color: tab === t ? "white" : "#6b7280", transition: "all .2s",
            }}>{label}</button>
          ))}
        </div>

        {/* ===== TASKS TAB ===== */}
        {tab === "tasks" && (
          <div className="card">
            {/* 入力エリア */}
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  ref={taskInputRef}
                  style={{ flex: 1, minWidth: 0, border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 10px", fontSize: "14px", outline: "none" }}
                  placeholder="タスクを追加..."
                  defaultValue=""
                  onKeyDown={e => { if (e.key === "Enter") handleAddMainTask() }}
                />
                <button className={`add-btn add-btn-${accentCls}`} style={{ flexShrink: 0, opacity: submitting ? 0.5 : 1, cursor: submitting ? "not-allowed" : "pointer" }} onClick={handleAddMainTask} disabled={submitting}>+</button>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value as Priority)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 6px", fontSize: "12px", outline: "none" }}>
                  <option value="high">🔴 高</option>
                  <option value="mid">🟠 中</option>
                  <option value="low">🟢 低</option>
                </select>
                <label style={{ fontSize: "11px", color: "#6b7280", display: "flex", alignItems: "center", gap: "3px" }}>
                  開始<input type="date" value={taskStart} onChange={e => setTaskStart(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 6px", fontSize: "12px", outline: "none", maxWidth: "140px" }} />
                </label>
                <label style={{ fontSize: "11px", color: "#6b7280", display: "flex", alignItems: "center", gap: "3px" }}>
                  期限<input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 6px", fontSize: "12px", outline: "none", maxWidth: "140px" }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#374151", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={taskRecurring} onChange={e => { setTaskRecurring(e.target.checked); if (!e.target.checked) setTaskRecurringDays([]) }} />
                  🔁 繰り返し
                </label>
              </div>

              {taskRecurring && (
                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "11px", color: "#6b7280" }}>繰り返す曜日：</span>
                  <button onClick={() => setTaskRecurringDays([])} style={{ padding: "3px 10px", borderRadius: "6px", border: "none", background: taskRecurringDays.length === 0 ? "#6366f1" : "#f3f4f6", color: taskRecurringDays.length === 0 ? "white" : "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>毎日</button>
                  {[1, 2, 3, 4, 5, 6, 0].map(d => (
                    <button key={d} onClick={() => setTaskRecurringDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])} style={{ padding: "3px 8px", borderRadius: "6px", border: "none", background: taskRecurringDays.includes(d) ? "#6366f1" : "#f3f4f6", color: taskRecurringDays.includes(d) ? "white" : "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer", minWidth: "28px" }}>{DAY_LABELS[d]}</button>
                  ))}
                </div>
              )}
            </div>

            {/* 期間フィルター */}
            <div style={{ padding: "8px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: "12px", color: "#6b7280", flexShrink: 0 }}>📅 期間:</span>
              <input type="date" value={rangeStart} onChange={e => setRangeStart(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "6px", padding: "3px 8px", fontSize: "12px", outline: "none" }} />
              <span style={{ fontSize: "12px", color: "#6b7280" }}>〜</span>
              <input type="date" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "6px", padding: "3px 8px", fontSize: "12px", outline: "none" }} />
              {(rangeStart || rangeEnd) && (
                <button onClick={() => { setRangeStart(""); setRangeEnd("") }} style={{ padding: "3px 10px", borderRadius: "6px", border: "none", background: "#f3f4f6", color: "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>クリア</button>
              )}
            </div>

            {/* フィルター（未完了/完了）＋ 並び替え切替 */}
            <div className="filter-tabs" style={{ alignItems: "center" }}>
              {(["active", "done"] as Filter[]).map(f => (
                <button key={f} className={`filter-tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                  {f === "active" ? "未完了" : "完了"}
                </button>
              ))}
              <div style={{ marginLeft: "auto", display: "flex", gap: "2px", background: "#f3f4f6", borderRadius: "7px", padding: "2px" }}>
                {([["manual", "✋ 手動"], ["auto", "🔀 期限・優先度"]] as ["manual" | "auto", string][]).map(([m, label]) => (
                  <button key={m} onClick={() => setSortMode(m)} title={m === "manual" ? "ドラッグで並び替え" : "期限が早い順→残りは優先度順"}
                    style={{
                      padding: "4px 9px", borderRadius: "5px", border: "none", cursor: "pointer", fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap",
                      background: sortMode === m ? "white" : "transparent",
                      color: sortMode === m ? "#111827" : "#6b7280",
                      boxShadow: sortMode === m ? "0 1px 2px rgba(0,0,0,.12)" : "none",
                    }}>{label}</button>
                ))}
              </div>
            </div>

            {/* タスクリスト */}
            <div className="list-body">
              {loading ? <div className="empty-msg">読み込み中...</div>
                : filteredParents.length === 0 ? <div className="empty-msg">タスクがありません</div>
                : filteredParents.map(t => <TaskItem key={t.id} task={t} level={0} ctx={ctx} />)}
            </div>
          </div>
        )}

        {/* ===== GOALS TAB ===== */}
        {tab === "goals" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {/* 今年の目標 */}
            <HighlightBanner icon="🎯" label="今年の目標" value={yearGoal} accentColor={accentColor} onSave={saveYearGoal} />

            <div className="card">
              <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: "8px" }}>
                <input style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} placeholder="新しい目標を追加..." value={goalText} onChange={e => setGoalText(e.target.value)} onKeyDown={e => e.key === "Enter" && addGoal()} />
                <input type="date" value={goalDue} onChange={e => setGoalDue(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px", fontSize: "13px", outline: "none" }} />
                <button className={`add-btn add-btn-${accentCls}`} style={{ opacity: submitting ? 0.5 : 1, cursor: submitting ? "not-allowed" : "pointer" }} onClick={addGoal} disabled={submitting}>+</button>
              </div>
              <div className="list-body">
                {loading ? <div className="empty-msg">読み込み中...</div>
                  : goals.length === 0 ? <div className="empty-msg">目標がありません</div>
                  : goals.map(g => (
                    <div key={g.id} className="goal-item">
                      <div className="goal-top">
                        <div className={`goal-name ${g.pct >= 100 ? "goal-name-done" : ""}`}>{g.text}</div>
                        <div className={`goal-pct goal-pct-${accentCls}`}>{g.pct}%</div>
                        <button onClick={() => openGoalEdit(g)} aria-label={`${g.text} を編集`} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "13px", padding: "2px 3px", color: "#6b7280" }} title="編集">✏️</button>
                        <button className="del-btn" onClick={() => deleteGoal(g.id)} aria-label={`${g.text} を削除`} title="削除">×</button>
                      </div>
                      <div className="progress-bar"><div className={`progress-fill progress-${accentCls}`} style={{ width: `${g.pct}%` }} /></div>
                      <div className="goal-controls">
                        <input type="range" min={0} max={100} value={g.pct} onChange={e => updateGoalPct(g.id, Number(e.target.value))} />
                        {g.due_date && <div className="goal-due">{fmtDue(g.due_date)}</div>}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* ===== MEMOS TAB ===== */}
        {tab === "memos" && (
          <div className="card">
            <div className="card-header">
              <div className="card-title"><span>📝</span> メモ一覧</div>
              <button onClick={newMemo} className={`add-btn add-btn-${accentCls}`} style={{ fontSize: "14px", padding: "6px 12px" }}>+ 新規</button>
            </div>
            {/* 検索 */}
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                value={memoSearch}
                onChange={e => setMemoSearch(e.target.value)}
                placeholder="🔍 タイトル・本文・タグで検索..."
                style={{ flex: 1, minWidth: 0, border: "1px solid #e5e7eb", borderRadius: "8px", padding: "7px 10px", fontSize: "13px", outline: "none" }}
              />
              {(memoSearch || memoTagFilter) && (
                <button onClick={() => { setMemoSearch(""); setMemoTagFilter(null) }}
                  style={{ padding: "6px 10px", borderRadius: "8px", border: "none", background: "#f3f4f6", color: "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>クリア</button>
              )}
            </div>

            {/* タグ絞り込み */}
            {allMemoTags.length > 0 && (
              <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: "11px", color: "#6b7280", flexShrink: 0 }}>🏷 タグ:</span>
                {allMemoTags.map(t => (
                  <button key={t} onClick={() => setMemoTagFilter(memoTagFilter === t ? null : t)}
                    style={{
                      padding: "3px 10px", borderRadius: "999px", border: "none", cursor: "pointer", fontSize: "11px", fontWeight: 600,
                      background: memoTagFilter === t ? accentColor : "#f3f4f6",
                      color: memoTagFilter === t ? "white" : "#374151",
                    }}>{t}</button>
                ))}
              </div>
            )}

            <div className="list-body">
              {loading ? <div className="empty-msg">読み込み中...</div>
                : memos.length === 0 ? <div className="empty-msg">メモがありません</div>
                : filteredMemos.length === 0 ? <div className="empty-msg">該当するメモがありません</div>
                : filteredMemos.map(m => (
                  <div key={m.id} onClick={() => openMemo(m)}
                    style={{ padding: "12px 20px", borderBottom: "1px solid #f3f4f6", cursor: "pointer", transition: "background .1s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={e => (e.currentTarget.style.background = "white")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                      <div style={{ fontWeight: 600, fontSize: "14px", minWidth: 0, overflowWrap: "anywhere" }}>{m.title || "（無題）"}</div>
                      <button className="del-btn" style={{ flexShrink: 0 }} onClick={e => { e.stopPropagation(); deleteMemo(m.id) }} aria-label={`${m.title || "無題のメモ"} を削除`} title="削除">×</button>
                    </div>
                    {parseTags(m.tags).length > 0 && (
                      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "5px" }}>
                        {parseTags(m.tags).map(t => (
                          <span key={t} style={{ fontSize: "10px", fontWeight: 600, color: accentColor, background: "#f3f4f6", borderRadius: "999px", padding: "1px 8px" }}>{t}</span>
                        ))}
                      </div>
                    )}
                    <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.content}</div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* ===== TASK EDIT MODAL ===== */}
      {editModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div style={{ background: "white", borderRadius: "16px", width: "100%", maxWidth: "480px", overflow: "auto", maxHeight: "90vh" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 700, fontSize: "16px" }}>✏️ タスクを編集</div>
              <button onClick={() => setEditModal(null)} aria-label="閉じる" title="閉じる" style={{ border: "none", background: "none", fontSize: "22px", cursor: "pointer", color: "#6b7280" }}>×</button>
            </div>
            <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>タスク名</label>
                <input value={editForm.text} onChange={e => setEditForm(p => ({ ...p, text: e.target.value }))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} />
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>優先度</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  {(["high", "mid", "low"] as Priority[]).map(p => {
                    const pcc = PRIORITY_CONFIG[p]
                    return (
                      <button key={p} onClick={() => setEditForm(prev => ({ ...prev, priority: p }))} style={{ flex: 1, padding: "8px", borderRadius: "8px", border: `2px solid ${editForm.priority === p ? pcc.color : "#e5e7eb"}`, background: editForm.priority === p ? pcc.bg : "white", color: pcc.color, fontWeight: 700, cursor: "pointer", fontSize: "13px" }}>{pcc.label}</button>
                    )
                  })}
                </div>
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>開始日</label>
                  <input type="date" value={editForm.start_date} onChange={e => setEditForm(p => ({ ...p, start_date: e.target.value }))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>期限日</label>
                  <input type="date" value={editForm.due_date} onChange={e => setEditForm(p => ({ ...p, due_date: e.target.value }))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} />
                </div>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "6px" }}>繰り返し</label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer", marginBottom: "8px" }}>
                  <input type="checkbox" checked={editForm.is_recurring} onChange={e => setEditForm(p => ({ ...p, is_recurring: e.target.checked, recurring_days: [] }))} />
                  🔁 繰り返す
                </label>
                {editForm.is_recurring && (
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button onClick={() => setEditForm(p => ({ ...p, recurring_days: [] }))} style={{ padding: "4px 12px", borderRadius: "6px", border: "none", background: editForm.recurring_days.length === 0 ? "#6366f1" : "#f3f4f6", color: editForm.recurring_days.length === 0 ? "white" : "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>毎日</button>
                    {[1, 2, 3, 4, 5, 6, 0].map(d => (
                      <button key={d} onClick={() => setEditForm(p => ({ ...p, recurring_days: p.recurring_days.includes(d) ? p.recurring_days.filter(x => x !== d) : [...p.recurring_days, d] }))} style={{ padding: "4px 10px", borderRadius: "6px", border: "none", background: editForm.recurring_days.includes(d) ? "#6366f1" : "#f3f4f6", color: editForm.recurring_days.includes(d) ? "white" : "#374151", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{DAY_LABELS[d]}</button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>メモ</label>
                <textarea value={editForm.memo} onChange={e => setEditForm(p => ({ ...p, memo: e.target.value }))} rows={3} placeholder="メモを入力...（URLはリンクになります）" style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "13px", outline: "none", resize: "vertical" }} />
              </div>
            </div>
            <div style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setEditModal(null)} style={{ padding: "8px 20px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: "14px" }}>キャンセル</button>
              <button onClick={saveEditModal} style={{ padding: "8px 24px", borderRadius: "8px", border: "none", background: accentColor, color: "white", cursor: "pointer", fontSize: "14px", fontWeight: 600 }}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== GOAL EDIT MODAL ===== */}
      {editGoalModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div style={{ background: "white", borderRadius: "16px", width: "100%", maxWidth: "440px", overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 700, fontSize: "16px" }}>🎯 目標を編集</div>
              <button onClick={() => setEditGoalModal(null)} aria-label="閉じる" title="閉じる" style={{ border: "none", background: "none", fontSize: "22px", cursor: "pointer", color: "#6b7280" }}>×</button>
            </div>
            <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>目標名</label>
                <input value={goalEditForm.text} onChange={e => setGoalEditForm(p => ({ ...p, text: e.target.value }))} style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} />
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>期日</label>
                <input type="date" value={goalEditForm.due_date} onChange={e => setGoalEditForm(p => ({ ...p, due_date: e.target.value }))} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} />
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "4px" }}>進捗：{goalEditForm.pct}%</label>
                <input type="range" min={0} max={100} value={goalEditForm.pct} onChange={e => setGoalEditForm(p => ({ ...p, pct: Number(e.target.value) }))} style={{ width: "100%", cursor: "pointer" }} />
              </div>
            </div>
            <div style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb", display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button onClick={() => setEditGoalModal(null)} style={{ padding: "8px 20px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: "14px" }}>キャンセル</button>
              <button onClick={saveGoalEdit} style={{ padding: "8px 24px", borderRadius: "8px", border: "none", background: accentColor, color: "white", cursor: "pointer", fontSize: "14px", fontWeight: 600 }}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MEMO MODAL ===== */}
      {memoModal.open && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div style={{ background: "white", borderRadius: "16px", width: "100%", maxWidth: "560px", display: "flex", flexDirection: "column", maxHeight: "90vh" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 700, fontSize: "16px" }}>{memoModal.editing ? (memoModal.id ? "✏️ メモを編集" : "📝 新規メモ") : "📝 メモ"}</div>
              <button onClick={() => setMemoModal({ open: false, editing: false, id: null })} aria-label="閉じる" title="閉じる" style={{ border: "none", background: "none", fontSize: "22px", cursor: "pointer", color: "#6b7280" }}>×</button>
            </div>

            {memoModal.editing ? (
              <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "10px", overflow: "auto" }}>
                <input value={memoTitle} onChange={e => setMemoTitle(e.target.value)} placeholder="タイトル" style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "15px", fontWeight: 600, outline: "none" }} />
                <div>
                  <input value={memoTags} onChange={e => setMemoTags(e.target.value)} placeholder="🏷 タグ（カンマ区切り 例: 仕事, アイデア）" style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "7px 12px", fontSize: "13px", outline: "none" }} />
                  {allMemoTags.length > 0 && (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "6px", alignItems: "center" }}>
                      <span style={{ fontSize: "10px", color: "#9ca3af" }}>既存:</span>
                      {allMemoTags.map(t => (
                        <button key={t} type="button"
                          onClick={() => { const cur = parseTags(memoTags); if (!cur.includes(t)) setMemoTags([...cur, t].join(", ")) }}
                          style={{ fontSize: "10px", fontWeight: 600, color: "#374151", background: "#f3f4f6", border: "none", borderRadius: "999px", padding: "2px 8px", cursor: "pointer" }}>+ {t}</button>
                      ))}
                    </div>
                  )}
                </div>
                <textarea value={memoContent} onChange={e => setMemoContent(e.target.value)} placeholder="メモを入力...（URLはリンクになります）" style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "10px 12px", fontSize: "14px", outline: "none", minHeight: "240px", resize: "vertical", lineHeight: "1.6" }} />
              </div>
            ) : (
              <div style={{ padding: "16px 20px", overflow: "auto" }}>
                <div style={{ fontWeight: 700, fontSize: "18px", marginBottom: "8px", overflowWrap: "anywhere" }}>{memoTitle || "（無題）"}</div>
                {parseTags(memoTags).length > 0 && (
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "10px" }}>
                    {parseTags(memoTags).map(t => (
                      <span key={t} style={{ fontSize: "11px", fontWeight: 600, color: accentColor, background: "#f3f4f6", borderRadius: "999px", padding: "2px 9px" }}>{t}</span>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: "14px", color: "#374151", whiteSpace: "pre-wrap", lineHeight: "1.7", overflowWrap: "anywhere" }}>{renderWithLinks(memoContent) || <span style={{ color: "#9ca3af" }}>（内容なし）</span>}</div>
              </div>
            )}

            <div style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb", display: "flex", gap: "8px", justifyContent: "space-between", alignItems: "center" }}>
              {memoModal.id ? (
                <button onClick={() => deleteMemo(memoModal.id!)} style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #fecaca", background: "white", color: "#dc2626", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>削除</button>
              ) : <span />}
              <div style={{ display: "flex", gap: "8px" }}>
                {memoModal.editing ? (
                  <>
                    {memoModal.id && <button onClick={() => setMemoModal(p => ({ ...p, editing: false }))} style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: "14px" }}>キャンセル</button>}
                    <button onClick={saveMemo} style={{ padding: "8px 24px", borderRadius: "8px", border: "none", background: accentColor, color: "white", cursor: "pointer", fontSize: "14px", fontWeight: 600 }}>保存</button>
                  </>
                ) : (
                  <button onClick={() => setMemoModal(p => ({ ...p, editing: true }))} style={{ padding: "8px 24px", borderRadius: "8px", border: "none", background: accentColor, color: "white", cursor: "pointer", fontSize: "14px", fontWeight: 600 }}>編集</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== TOAST ===== */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)",
            background: "#111827", color: "white", padding: "10px 18px", borderRadius: "10px",
            fontSize: "13px", fontWeight: 600, zIndex: 500, maxWidth: "90vw", textAlign: "center",
            boxShadow: "0 4px 16px rgba(0,0,0,.25)",
          }}
          onClick={() => setToast(null)}
        >
          ⚠️ {toast}
        </div>
      )}
    </>
  )
}
