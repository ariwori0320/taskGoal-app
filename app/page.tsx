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
  updated_at: string
}

interface ChatMsg {
  role: "user" | "assistant"
  content: string
}

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"]

const PRIORITY_CONFIG = {
  high: { label: "高", bg: "#fee2e2", color: "#dc2626", border: "#fca5a5" },
  mid:  { label: "中", bg: "#fef9c3", color: "#b45309", border: "#fde047" },
  low:  { label: "低", bg: "#dcfce7", color: "#16a34a", border: "#86efac" },
}

function today() { return new Date().toISOString().split("T")[0] }

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

function TaskMemoEditor({ initial, indent, onSave, onCancel }: { initial: string; indent: number; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <div style={{ padding: `6px 12px 10px ${20 + indent + 20}px`, background: "#fffbeb", borderBottom: "1px solid #f3f4f6" }}>
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

function ChildTaskInput({ indent, onAdd, onCancel }: { indent: number; onAdd: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState("")
  return (
    <div style={{ display: "flex", gap: "6px", padding: `6px 12px 6px ${20 + indent + 20}px`, background: "#f9fafb" }}>
      <input
        autoFocus
        value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && v.trim()) { onAdd(v); }
          if (e.key === "Escape") onCancel()
        }}
        placeholder="サブタスクを入力..."
        style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "6px", padding: "6px 10px", fontSize: "13px", outline: "none" }}
      />
      <button
        onClick={() => { if (v.trim()) onAdd(v) }}
        style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px" }}
      >追加</button>
      <button onClick={onCancel} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280" }}>×</button>
    </div>
  )
}

// ===== タスク行コンポーネント（モジュールレベル・再帰） =====

interface TaskCtx {
  tasks: Task[]
  mode: Mode
  editingId: string | null
  setEditingId: (id: string | null) => void
  expandedMemoId: string | null
  setExpandedMemoId: (id: string | null) => void
  addingChildTo: string | null
  setAddingChildTo: (id: string | null) => void
  draggingId: string | null
  dragOverId: string | null
  toggleTask: (id: string, task: Task) => void
  requestEdit: (id: string) => void
  saveTaskText: (id: string, text: string) => void
  saveTaskMemo: (id: string, memo: string) => void
  openEditModal: (task: Task) => void
  moveTask: (id: string, mode: string) => void
  deleteTask: (id: string) => void
  openAiModal: (text: string, id: string) => void
  addChild: (parentId: string, text: string) => void
  onRowPointerDown: (e: React.PointerEvent, id: string) => void
}

function TaskItem({ task, level, ctx }: { task: Task; level: number; ctx: TaskCtx }) {
  const children = ctx.tasks.filter(t => t.parent_id === task.id)
  const indent = level * 20
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
          paddingLeft: `${20 + indent}px`, flexWrap: "wrap", gap: "6px",
          opacity: isDragging ? 0.4 : 1,
          background: isDragging ? "#eef2ff" : undefined,
          borderTop: isDragTarget ? "2px solid #6366f1" : undefined,
        }}
        onPointerDown={level === 0 ? (e) => ctx.onRowPointerDown(e, task.id) : undefined}
      >
        {level === 0 && (
          <span title="長押しで並び替え" style={{ cursor: "grab", color: "#cbd5e1", fontSize: "14px", flexShrink: 0, userSelect: "none", lineHeight: 1, touchAction: "none" }}>⠿</span>
        )}
        <div className={`task-check ${done ? "task-check-done" : ""}`} onClick={() => ctx.toggleTask(task.id, task)}>
          {done ? "✓" : ""}
        </div>

        {task.is_recurring && (
          <span style={{ background: "#e0f2fe", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: "4px", padding: "1px 5px", fontSize: "10px", fontWeight: 700, flexShrink: 0 }}>
            🔁{task.recurring_days ? task.recurring_days.split(",").map(d => DAY_LABELS[Number(d)]).join("・") : "毎日"}
          </span>
        )}

        <span style={{
          background: pc.bg, color: pc.color, border: `1px solid ${pc.border}`,
          borderRadius: "4px", padding: "1px 6px", fontSize: "11px", fontWeight: 700, flexShrink: 0,
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
            style={{ flex: 1 }}
            onClick={() => ctx.requestEdit(task.id)}
          >{task.text}</div>
        )}

        {/* 開始日〜期限 */}
        {task.start_date && (
          <div className="task-due" style={{ color: "#6b7280" }}>{fmtShort(task.start_date)}〜</div>
        )}
        {task.due_date && (
          <div className={`task-due ${!task.done && isOverdue(task.due_date) ? "task-due-overdue" : ""}`}>
            {task.start_date ? fmtShort(task.due_date) : fmtDue(task.due_date)}
          </div>
        )}

        <button onClick={() => ctx.openEditModal(task)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "13px", padding: "2px 3px", color: "#6b7280" }} title="編集">✏️</button>
        <button onClick={() => ctx.setExpandedMemoId(isMemoOpen ? null : task.id)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "14px", padding: "2px 3px", opacity: task.memo ? 1 : 0.4 }} title="メモ">📝</button>
        <button onClick={() => ctx.moveTask(task.id, task.mode || ctx.mode)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "12px", padding: "2px 3px", color: "#6b7280" }} title={ctx.mode === "work" ? "プライベートへ移動" : "仕事へ移動"}>{ctx.mode === "work" ? "🏠" : "💼"}</button>
        {level < 2 && (
          <button onClick={() => ctx.setAddingChildTo(task.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", fontSize: "15px", padding: "2px 3px" }} title="サブタスクを追加">＋</button>
        )}
        <button onClick={() => ctx.openAiModal(task.text, task.id)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "13px", padding: "2px 3px" }} title="AIで分解">🤖</button>
        <button className="del-btn" onClick={() => ctx.deleteTask(task.id)}>×</button>
      </div>

      {/* メモ表示（読み取り：リンク有効） */}
      {!isMemoOpen && task.memo && (
        <div style={{ padding: `2px 12px 8px ${20 + indent + 40}px`, fontSize: "12px", color: "#92400e", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
          📝 {renderWithLinks(task.memo)}
        </div>
      )}

      {/* メモ編集 */}
      {isMemoOpen && (
        <TaskMemoEditor
          initial={task.memo || ""}
          indent={indent}
          onSave={(v) => ctx.saveTaskMemo(task.id, v)}
          onCancel={() => ctx.setExpandedMemoId(null)}
        />
      )}

      {/* サブタスク追加 */}
      {ctx.addingChildTo === task.id && (
        <ChildTaskInput
          indent={indent}
          onAdd={(v) => { ctx.addChild(task.id, v); ctx.setAddingChildTo(null) }}
          onCancel={() => ctx.setAddingChildTo(null)}
        />
      )}

      {/* 子タスク（再帰） */}
      {children.map(child => (
        <TaskItem key={child.id} task={child} level={level + 1} ctx={ctx} />
      ))}
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
  const [highlights, setHighlights] = useState<{ year: string; month: string }>({ year: "", month: "" })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>("active")

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

  // AI Chat modal
  const [aiModal, setAiModal] = useState(false)
  const [aiTask, setAiTask] = useState("")
  const [aiParentId, setAiParentId] = useState<string | null>(null)
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState("")
  const [aiLoading, setAiLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Drag & drop reorder
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // Pct debounce
  const pctTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

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
      setHighlights({ year: h?.year || "", month: h?.month || "" })
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [mode])

  useEffect(() => { fetchAll() }, [fetchAll])

  // ---- Task actions ----
  async function addTask(text: string, parentId: string | null = null, priority: Priority = "mid", start = "", due = "") {
    if (!text.trim()) return
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.trim(), priority,
          start_date: parentId ? null : (start || null),
          due_date: parentId ? null : (due || null),
          mode, parent_id: parentId,
          is_recurring: parentId ? false : taskRecurring,
          recurring_days: parentId ? "" : taskRecurringDays.join(","),
        }),
      })
      const json = await res.json()
      if (!res.ok) { alert(`タスク追加エラー: ${json.error || res.status}`); return }
      await fetchAll()
    } catch (e) {
      alert(`通信エラー: ${e}`)
    }
  }

  async function handleAddMainTask() {
    const val = taskInputRef.current?.value || ""
    if (!val.trim()) return
    await addTask(val, null, taskPriority, taskStart, taskDue)
    if (taskInputRef.current) taskInputRef.current.value = ""
    setTaskPriority("mid"); setTaskStart(""); setTaskDue("")
    setTaskRecurring(false); setTaskRecurringDays([])
  }

  function addChild(parentId: string, text: string) {
    addTask(text, parentId, "mid", "", "")
  }

  async function toggleTask(id: string, task: Task) {
    if (task.is_recurring) {
      const isDoneToday = task.recurring_done_date === today()
      const newDate = isDoneToday ? null : today()
      setTasks(prev => prev.map(t => t.id === id ? { ...t, recurring_done_date: newDate } : t))
      await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recurring_done_date: newDate }) })
    } else {
      setTasks(prev => prev.map(t => t.id === id ? { ...t, done: !task.done } : t))
      await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: !task.done }) })
    }
  }

  async function saveTaskText(id: string, text: string) {
    if (!text.trim()) { setEditingId(null); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, text } : t))
    setEditingId(null)
    await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
  }

  async function saveTaskMemo(id: string, memo: string) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, memo } : t))
    setExpandedMemoId(null)
    await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memo }) })
  }

  async function moveTask(id: string, currentMode: string) {
    const newMode = currentMode === "work" ? "private" : "work"
    setTasks(prev => prev.filter(t => t.id !== id))
    await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: newMode }) })
  }

  async function deleteTask(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id && t.parent_id !== id))
    await fetch(`/api/tasks/${id}`, { method: "DELETE" })
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
    await fetch(`/api/tasks/${editModal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) })
  }

  // ---- Goal actions ----
  async function addGoal() {
    if (!goalText.trim()) return
    const res = await fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: goalText, due_date: goalDue || null, mode }) })
    const goal: Goal = await res.json()
    setGoals(prev => [goal, ...prev])
    setGoalText(""); setGoalDue("")
  }

  function updateGoalPct(id: string, pct: number) {
    setGoals(prev => prev.map(g => g.id === id ? { ...g, pct } : g))
    clearTimeout(pctTimers.current[id])
    pctTimers.current[id] = setTimeout(() => {
      fetch(`/api/goals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pct }) })
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
    await fetch(`/api/goals/${editGoalModal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) })
  }

  async function deleteGoal(id: string) {
    setGoals(prev => prev.filter(g => g.id !== id))
    await fetch(`/api/goals/${id}`, { method: "DELETE" })
  }

  // ---- Highlights ----
  async function saveHighlight(kind: "year" | "month", text: string) {
    setHighlights(prev => ({ ...prev, [kind]: text }))
    await fetch("/api/highlights", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, [`${kind}_text`]: text }) })
  }

  // ---- Memo actions ----
  function openMemo(m: Memo) {
    setMemoModal({ open: true, editing: false, id: m.id })
    setMemoTitle(m.title); setMemoContent(m.content)
  }

  function newMemo() {
    setMemoModal({ open: true, editing: true, id: null })
    setMemoTitle(""); setMemoContent("")
  }

  async function saveMemo() {
    if (memoModal.id) {
      await fetch(`/api/memos/${memoModal.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: memoTitle, content: memoContent }) })
      setMemos(prev => prev.map(m => m.id === memoModal.id ? { ...m, title: memoTitle, content: memoContent } : m))
      setMemoModal(prev => ({ ...prev, editing: false }))
    } else {
      const res = await fetch("/api/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: memoTitle, content: memoContent, mode }) })
      const memo: Memo = await res.json()
      setMemos(prev => [memo, ...prev])
      setMemoModal({ open: true, editing: false, id: memo.id })
    }
  }

  async function deleteMemo(id: string) {
    setMemos(prev => prev.filter(m => m.id !== id))
    setMemoModal({ open: false, editing: false, id: null })
    await fetch(`/api/memos/${id}`, { method: "DELETE" })
  }

  // ---- AI Chat ----
  function openAiModal(taskName: string, parentId: string | null = null) {
    setAiTask(taskName)
    setAiParentId(parentId)
    setSuggestions([])
    setChatInput("")
    setAiModal(true)
    setChatMsgs([{
      role: "assistant",
      content: `「${taskName}」のタスク分解をお手伝いします！\n\n下のテキストボックスに指示を入力して「送信」を押してください。\n\n例：\n・「細かく分解して」\n・「3ステップで分けて」\n・「今日中にできる粒度にして」`,
    }])
  }

  async function startAiChat(taskName: string, history: ChatMsg[]) {
    setAiLoading(true)
    const res = await fetch("/api/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: taskName, messages: history.map(m => ({ role: m.role, content: m.content })) }) })
    const data = await res.json()
    setChatMsgs(prev => [...prev, { role: "assistant", content: data.text }])
    setSuggestions(data.suggestions || [])
    setAiLoading(false)
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100)
  }

  async function sendChatMsg() {
    if (!chatInput.trim() || aiLoading) return
    const newHistory = [...chatMsgs, { role: "user", content: chatInput } as ChatMsg]
    setChatMsgs(newHistory)
    setChatInput("")
    setSuggestions([])
    await startAiChat(aiTask, newHistory)
  }

  async function addSuggestionAsTask(text: string) { await addTask(text, aiParentId, "mid", "", "") }
  async function addAllSuggestions() { for (const s of suggestions) await addSuggestionAsTask(s); setSuggestions([]) }

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

  const parentTasks = tasks
    .filter(t => !t.parent_id)
    .sort((a, b) => (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY))
  const rangedParents = parentTasks.filter(inRange)
  const filteredParents = filter === "done"
    ? rangedParents.filter(t => isTaskDone(t))
    : rangedParents.filter(t => !isTaskDone(t))

  const activeCnt = tasks.filter(t => !isTaskDone(t) && !t.parent_id).length
  const doneCnt = tasks.filter(t => isTaskDone(t) && !t.parent_id).length
  const overdueCnt = tasks.filter(t => !isTaskDone(t) && isOverdue(t.due_date)).length
  const avgGoal = goals.length ? Math.round(goals.reduce((a, g) => a + g.pct, 0) / goals.length) : 0

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

  async function reorderTasks(srcId: string, overId: string) {
    if (!srcId || !overId || srcId === overId) return
    const ids = filteredParents.map(t => t.id)
    const from = ids.indexOf(srcId), to = ids.indexOf(overId)
    if (from === -1 || to === -1) return
    const newIds = [...ids]
    newIds.splice(from, 1)
    newIds.splice(to, 0, srcId)
    const orderMap = new Map(newIds.map((id, i) => [id, i]))
    setTasks(prev => prev.map(t => orderMap.has(t.id) ? { ...t, sort_order: orderMap.get(t.id)! } : t))
    await Promise.all(newIds.map((id, i) =>
      fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: i }) })
    ))
  }
  reorderRef.current = reorderTasks

  const pointAt = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const row = el?.closest("[data-task-id]") as HTMLElement | null
    return row?.getAttribute("data-task-id") ?? null
  }, [])

  const onWinMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) {
      const dx = Math.abs(e.clientX - startPt.current.x)
      const dy = Math.abs(e.clientY - startPt.current.y)
      if (dx > 8 || dy > 8) {
        if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
        window.removeEventListener("pointermove", onWinMove)
      }
      return
    }
    const over = pointAt(e.clientX, e.clientY)
    if (over !== dragOverRef.current) { dragOverRef.current = over; setDragOverId(over) }
  }, [pointAt])

  const onWinUp = useCallback((e: PointerEvent) => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
    window.removeEventListener("pointermove", onWinMove)
    window.removeEventListener("pointerup", onWinUp)
    const src = draggingRef.current
    const over = src ? pointAt(e.clientX, e.clientY) : null
    if (src) { suppressClickRef.current = true; setTimeout(() => { suppressClickRef.current = false }, 300) }
    draggingRef.current = null
    dragOverRef.current = null
    setDraggingId(null)
    setDragOverId(null)
    if (src && over && over !== src) reorderRef.current(src, over)
  }, [pointAt, onWinMove])

  const onRowPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest("button, input, textarea, a, select, .task-check")) return // 操作系からはドラッグ開始しない
    startPt.current = { x: e.clientX, y: e.clientY }
    draggingRef.current = null
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = setTimeout(() => {
      draggingRef.current = id
      setDraggingId(id)
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(15)
    }, 280)
    window.addEventListener("pointermove", onWinMove)
    window.addEventListener("pointerup", onWinUp)
  }, [onWinMove, onWinUp])

  // ドラッグ中はスクロールを抑止（タッチ）
  useEffect(() => {
    const handler = (ev: TouchEvent) => { if (draggingRef.current) ev.preventDefault() }
    document.addEventListener("touchmove", handler, { passive: false })
    return () => document.removeEventListener("touchmove", handler)
  }, [])

  const ctx: TaskCtx = {
    tasks, mode, editingId, setEditingId, expandedMemoId, setExpandedMemoId,
    addingChildTo, setAddingChildTo, draggingId, dragOverId,
    toggleTask, requestEdit, saveTaskText, saveTaskMemo, openEditModal, moveTask, deleteTask, openAiModal, addChild, onRowPointerDown,
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

      {/* 今月の目標（常時表示・ステータスの上） */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 12px 0" }}>
        <HighlightBanner icon="📌" label="今月の目標" value={highlights.month} accentColor={accentColor} onSave={(v) => saveHighlight("month", v)} />
      </div>

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
            <div style={{ padding: "10px 20px", background: "#eef2ff", borderBottom: "1px solid #c7d2fe", fontSize: "12px", color: "#4338ca" }}>
              💡 <strong>🤖 AI分解</strong>：タスクを「すぐ動ける粒度」に分解します。各タスク横の🤖でサブタスクとして追加、対話で細かく調整できます。／ <strong>並び替え</strong>：タスクを長押ししてドラッグ。
            </div>

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
                <button onClick={() => { const v = taskInputRef.current?.value || ""; if (v.trim()) openAiModal(v, null) }}
                  style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "8px", padding: "8px 10px", cursor: "pointer", fontSize: "13px", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>🤖</button>
                <button className={`add-btn add-btn-${accentCls}`} style={{ flexShrink: 0 }} onClick={handleAddMainTask}>+</button>
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

            {/* フィルター（未完了/完了） */}
            <div className="filter-tabs">
              {(["active", "done"] as Filter[]).map(f => (
                <button key={f} className={`filter-tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                  {f === "active" ? "未完了" : "完了"}
                </button>
              ))}
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
            <HighlightBanner icon="🎯" label="今年の目標" value={highlights.year} accentColor={accentColor} onSave={(v) => saveHighlight("year", v)} />

            <div className="card">
              <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: "8px" }}>
                <input style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }} placeholder="新しい目標を追加..." value={goalText} onChange={e => setGoalText(e.target.value)} onKeyDown={e => e.key === "Enter" && addGoal()} />
                <input type="date" value={goalDue} onChange={e => setGoalDue(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px", fontSize: "13px", outline: "none" }} />
                <button className={`add-btn add-btn-${accentCls}`} onClick={addGoal}>+</button>
              </div>
              <div className="list-body">
                {loading ? <div className="empty-msg">読み込み中...</div>
                  : goals.length === 0 ? <div className="empty-msg">目標がありません</div>
                  : goals.map(g => (
                    <div key={g.id} className="goal-item">
                      <div className="goal-top">
                        <div className={`goal-name ${g.pct >= 100 ? "goal-name-done" : ""}`}>{g.text}</div>
                        <div className={`goal-pct goal-pct-${accentCls}`}>{g.pct}%</div>
                        <button onClick={() => openGoalEdit(g)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "13px", padding: "2px 3px", color: "#6b7280" }} title="編集">✏️</button>
                        <button className="del-btn" onClick={() => deleteGoal(g.id)}>×</button>
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
            <div className="list-body">
              {loading ? <div className="empty-msg">読み込み中...</div>
                : memos.length === 0 ? <div className="empty-msg">メモがありません</div>
                : memos.map(m => (
                  <div key={m.id} onClick={() => openMemo(m)}
                    style={{ padding: "12px 20px", borderBottom: "1px solid #f3f4f6", cursor: "pointer", transition: "background .1s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                    onMouseLeave={e => (e.currentTarget.style.background = "white")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 600, fontSize: "14px" }}>{m.title || "（無題）"}</div>
                      <button className="del-btn" onClick={e => { e.stopPropagation(); deleteMemo(m.id) }}>×</button>
                    </div>
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
              <button onClick={() => setEditModal(null)} style={{ border: "none", background: "none", fontSize: "22px", cursor: "pointer", color: "#6b7280" }}>×</button>
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
              <button onClick={() => setEditGoalModal(null)} style={{ border: "none", background: "none", fontSize: "22px", cursor: "pointer", color: "#6b7280" }}>×</button>
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
              <button onClick={() => setMemoModal({ open: false, editing: false, id: null })} style={{ border: "none", background: "none", fontSize: "22px", cursor: "pointer", color: "#6b7280" }}>×</button>
            </div>

            {memoModal.editing ? (
              <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "10px", overflow: "auto" }}>
                <input value={memoTitle} onChange={e => setMemoTitle(e.target.value)} placeholder="タイトル" style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "15px", fontWeight: 600, outline: "none" }} />
                <textarea value={memoContent} onChange={e => setMemoContent(e.target.value)} placeholder="メモを入力...（URLはリンクになります）" style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "10px 12px", fontSize: "14px", outline: "none", minHeight: "240px", resize: "vertical", lineHeight: "1.6" }} />
              </div>
            ) : (
              <div style={{ padding: "16px 20px", overflow: "auto" }}>
                <div style={{ fontWeight: 700, fontSize: "18px", marginBottom: "10px" }}>{memoTitle || "（無題）"}</div>
                <div style={{ fontSize: "14px", color: "#374151", whiteSpace: "pre-wrap", lineHeight: "1.7" }}>{renderWithLinks(memoContent) || <span style={{ color: "#9ca3af" }}>（内容なし）</span>}</div>
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

      {/* ===== AI CHAT MODAL ===== */}
      {aiModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div style={{ background: "white", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: "600px", height: "85vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "16px" }}>🤖 AI タスク分解</div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>「{aiTask}」</div>
              </div>
              <button onClick={() => setAiModal(false)} style={{ border: "none", background: "none", fontSize: "24px", cursor: "pointer", color: "#6b7280" }}>×</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              {chatMsgs.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth: "85%", padding: "10px 14px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: m.role === "user" ? "#6366f1" : "#f3f4f6", color: m.role === "user" ? "white" : "#111827", fontSize: "13px", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              ))}
              {aiLoading && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div style={{ background: "#f3f4f6", padding: "10px 14px", borderRadius: "16px 16px 16px 4px", fontSize: "13px", color: "#6b7280" }}>⏳ AIがタスクを実行できる粒度に分解しています...</div>
                </div>
              )}
              {suggestions.length > 0 && !aiLoading && (
                <div style={{ background: "#eef2ff", borderRadius: "12px", padding: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#4338ca" }}>タスクに追加しますか？</span>
                    <button onClick={addAllSuggestions} style={{ background: "#4338ca", color: "white", border: "none", borderRadius: "6px", padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>すべて追加</button>
                  </div>
                  {suggestions.map((s, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: i > 0 ? "1px solid #c7d2fe" : "none" }}>
                      <span style={{ fontSize: "13px", color: "#374151" }}>{s}</span>
                      <button onClick={() => addSuggestionAsTask(s)} style={{ background: "white", color: "#6366f1", border: "1px solid #6366f1", borderRadius: "6px", padding: "3px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>+ 追加</button>
                    </div>
                  ))}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div style={{ padding: "12px 16px", borderTop: "1px solid #e5e7eb", display: "flex", gap: "8px" }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChatMsg()} placeholder="「もっと具体的に」「最初のステップを細かく」など..." style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "10px", padding: "10px 14px", fontSize: "14px", outline: "none" }} />
              <button onClick={sendChatMsg} disabled={!chatInput.trim() || aiLoading} style={{ background: chatInput.trim() && !aiLoading ? "#6366f1" : "#e5e7eb", color: chatInput.trim() && !aiLoading ? "white" : "#9ca3af", border: "none", borderRadius: "10px", padding: "10px 16px", cursor: chatInput.trim() && !aiLoading ? "pointer" : "not-allowed", fontWeight: 600 }}>送信</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
