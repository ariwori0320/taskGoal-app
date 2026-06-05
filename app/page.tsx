"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"

type Mode = "work" | "private"
type Priority = "high" | "mid" | "low"
type Filter = "all" | "active" | "done"
type Tab = "tasks" | "goals" | "memos"

interface Task {
  id: string
  text: string
  priority: Priority
  due_date: string | null
  done: boolean
  parent_id: string | null
  memo: string | null
  mode: string
  created_at: string
}

const PRIORITY_CONFIG = {
  high: { label: "高", bg: "#fee2e2", color: "#dc2626", border: "#fca5a5" },
  mid:  { label: "中", bg: "#fef9c3", color: "#b45309", border: "#fde047" },
  low:  { label: "低", bg: "#dcfce7", color: "#16a34a", border: "#86efac" },
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

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

function fmtDue(d: string | null) {
  if (!d) return ""
  const date = new Date(d + "T00:00:00")
  const now = new Date(); now.setHours(0,0,0,0)
  const diff = Math.round((date.getTime() - now.getTime()) / 86400000)
  if (diff === 0) return "今日"
  if (diff === 1) return "明日"
  if (diff < 0) return `${Math.abs(diff)}日超過`
  return `${diff}日後`
}

function isOverdue(d: string | null) {
  if (!d) return false
  const date = new Date(d + "T00:00:00")
  const now = new Date(); now.setHours(0,0,0,0)
  return date < now
}

export default function Home() {
  const router = useRouter()
  const taskInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<Mode>("work")
  const [tab, setTab] = useState<Tab>("tasks")
  const [tasks, setTasks] = useState<Task[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [memos, setMemos] = useState<Memo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>("all")

  // Task form
  const [taskText, setTaskText] = useState("")
  const [taskPriority, setTaskPriority] = useState<Priority>("mid")
  const [taskDue, setTaskDue] = useState("")

  // Edit / memo
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  const [expandedMemoId, setExpandedMemoId] = useState<string | null>(null)
  const [memoInput, setMemoInput] = useState("")

  // Goal form
  const [goalText, setGoalText] = useState("")
  const [goalDue, setGoalDue] = useState("")

  // Memo
  const [editMemo, setEditMemo] = useState<Memo | null>(null)
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

  // Inline child task input
  const [addingChildTo, setAddingChildTo] = useState<string | null>(null)
  const [childText, setChildText] = useState("")

  // Pct debounce
  const pctTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [t, g, m] = await Promise.all([
        fetch(`/api/tasks?mode=${mode}`).then(r => r.json()),
        fetch(`/api/goals?mode=${mode}`).then(r => r.json()),
        fetch(`/api/memos?mode=${mode}`).then(r => r.json()),
      ])
      setTasks(Array.isArray(t) ? t : [])
      setGoals(Array.isArray(g) ? g : [])
      setMemos(Array.isArray(m) ? m : [])
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }, [mode])

  useEffect(() => { fetchAll() }, [fetchAll])

  // ---- Task actions ----
  async function addTask(text: string, parentId: string | null = null, priority: Priority = "mid", due: string = "") {
    if (!text.trim()) return
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), priority, due_date: due || null, mode, parent_id: parentId }),
      })
      const json = await res.json()
      if (!res.ok) {
        alert(`タスク追加エラー: ${json.error || res.status}`)
        return
      }
      // 追加後に再取得して確実に反映
      await fetchAll()
    } catch (e) {
      alert(`通信エラー: ${e}`)
    }
  }

  async function toggleTask(id: string, done: boolean) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, done: !done } : t))
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !done }),
    })
  }

  async function saveTaskEdit(id: string) {
    if (!editingText.trim()) { setEditingId(null); return }
    setTasks(prev => prev.map(t => t.id === id ? { ...t, text: editingText } : t))
    setEditingId(null)
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: editingText }),
    })
  }

  async function saveMemo(id: string) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, memo: memoInput } : t))
    setExpandedMemoId(null)
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memo: memoInput }),
    })
  }

  async function moveTask(id: string, currentMode: string) {
    const newMode = currentMode === "work" ? "private" : "work"
    setTasks(prev => prev.filter(t => t.id !== id))
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
    })
  }

  async function deleteTask(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id && t.parent_id !== id))
    await fetch(`/api/tasks/${id}`, { method: "DELETE" })
  }

  // ---- Goal actions ----
  async function addGoal() {
    if (!goalText.trim()) return
    const res = await fetch("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: goalText, due_date: goalDue || null, mode }),
    })
    const goal: Goal = await res.json()
    setGoals(prev => [goal, ...prev])
    setGoalText(""); setGoalDue("")
  }

  function updateGoalPct(id: string, pct: number) {
    setGoals(prev => prev.map(g => g.id === id ? { ...g, pct } : g))
    clearTimeout(pctTimers.current[id])
    pctTimers.current[id] = setTimeout(() => {
      fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pct }),
      })
    }, 400)
  }

  async function deleteGoal(id: string) {
    setGoals(prev => prev.filter(g => g.id !== id))
    await fetch(`/api/goals/${id}`, { method: "DELETE" })
  }

  // ---- Memo actions ----
  async function saveMemo() {
    if (editMemo) {
      await fetch(`/api/memos/${editMemo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: memoTitle, content: memoContent }),
      })
      setMemos(prev => prev.map(m => m.id === editMemo.id ? { ...m, title: memoTitle, content: memoContent } : m))
    } else {
      const res = await fetch("/api/memos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: memoTitle, content: memoContent, mode }),
      })
      const memo: Memo = await res.json()
      setMemos(prev => [memo, ...prev])
    }
    setEditMemo(null); setMemoTitle(""); setMemoContent("")
  }

  async function deleteMemo(id: string) {
    setMemos(prev => prev.filter(m => m.id !== id))
    await fetch(`/api/memos/${id}`, { method: "DELETE" })
  }

  // ---- AI Chat ----
  function openAiModal(taskName: string, parentId: string | null = null) {
    setAiTask(taskName)
    setAiParentId(parentId)
    setSuggestions([])
    setChatInput("")
    setAiModal(true)
    // 最初のメッセージを案内として表示（自動実行しない）
    setChatMsgs([{
      role: "assistant",
      content: `「${taskName}」のタスク分解をお手伝いします！\n\n下のテキストボックスに指示を入力して「送信」を押してください。\n\n例：\n・「細かく分解して」\n・「3ステップで分けて」\n・「今日中にできる粒度にして」`,
    }])
  }

  async function startAiChat(taskName: string, history: ChatMsg[]) {
    setAiLoading(true)
    const res = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: taskName, messages: history.map(m => ({ role: m.role, content: m.content })) }),
    })
    const data = await res.json()
    setChatMsgs(prev => [...prev, { role: "assistant", content: data.text }])
    setSuggestions(data.suggestions || [])
    setAiLoading(false)
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100)
  }

  async function sendChatMsg() {
    if (!chatInput.trim() || aiLoading) return
    const newMsg: ChatMsg = { role: "user", content: chatInput }
    const newHistory = [...chatMsgs, newMsg]
    setChatMsgs(newHistory)
    setChatInput("")
    setSuggestions([])
    await startAiChat(aiTask, newHistory)
  }

  async function addSuggestionAsTask(text: string) {
    await addTask(text, aiParentId, "mid", "")
  }

  async function addAllSuggestions() {
    for (const s of suggestions) await addSuggestionAsTask(s)
    setSuggestions([])
  }

  // ---- Derived ----
  const accentCls = mode === "work" ? "work" : "private"
  const parentTasks = tasks.filter(t => !t.parent_id)
  const filteredParents = filter === "active" ? parentTasks.filter(t => !t.done)
    : filter === "done" ? parentTasks.filter(t => t.done)
    : parentTasks
  const childrenOf = (id: string) => tasks.filter(t => t.parent_id === id)

  const activeCnt = tasks.filter(t => !t.done && !t.parent_id).length
  const doneCnt = tasks.filter(t => t.done && !t.parent_id).length
  const overdueCnt = tasks.filter(t => !t.done && isOverdue(t.due_date)).length
  const avgGoal = goals.length ? Math.round(goals.reduce((a, g) => a + g.pct, 0) / goals.length) : 0

  // ---- Task Item Component ----
  function TaskItem({ task, level = 0 }: { task: Task; level?: number }) {
    const children = childrenOf(task.id)
    const grandChildren = (cid: string) => tasks.filter(t => t.parent_id === cid)
    const indent = level * 20
    const pc = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.mid
    const isEditing = editingId === task.id
    const isMemoOpen = expandedMemoId === task.id

    return (
      <div>
        <div className="task-item" style={{ paddingLeft: `${20 + indent}px`, flexWrap: "wrap", gap: "6px" }}>
          <div className={`task-check ${task.done ? "task-check-done" : ""}`} onClick={() => toggleTask(task.id, task.done)}>
            {task.done ? "✓" : ""}
          </div>

          {/* 優先度バッジ */}
          <span style={{
            background: pc.bg, color: pc.color, border: `1px solid ${pc.border}`,
            borderRadius: "4px", padding: "1px 6px", fontSize: "11px", fontWeight: 700, flexShrink: 0,
          }}>{pc.label}</span>

          {/* タスクテキスト（クリックで編集） */}
          {isEditing ? (
            <input
              autoFocus
              value={editingText}
              onChange={e => setEditingText(e.target.value)}
              onBlur={() => saveTaskEdit(task.id)}
              onKeyDown={e => { if (e.key === "Enter") saveTaskEdit(task.id); if (e.key === "Escape") setEditingId(null) }}
              style={{ flex: 1, border: "1px solid #6366f1", borderRadius: "6px", padding: "2px 8px", fontSize: "14px", outline: "none" }}
            />
          ) : (
            <div
              className={`task-text ${task.done ? "task-text-done" : ""}`}
              style={{ flex: 1, cursor: "text" }}
              onDoubleClick={() => { setEditingId(task.id); setEditingText(task.text) }}
              title="ダブルクリックで編集"
            >{task.text}</div>
          )}

          {task.due_date && (
            <div className={`task-due ${!task.done && isOverdue(task.due_date) ? "task-due-overdue" : ""}`}>
              {fmtDue(task.due_date)}
            </div>
          )}

          {/* メモボタン */}
          <button
            onClick={() => { setExpandedMemoId(isMemoOpen ? null : task.id); setMemoInput(task.memo || "") }}
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: "14px", padding: "2px 3px", opacity: task.memo ? 1 : 0.4 }}
            title="メモ"
          >📝</button>

          {/* モード移動ボタン */}
          <button
            onClick={() => moveTask(task.id, task.mode || mode)}
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: "12px", padding: "2px 3px", color: "#6b7280" }}
            title={mode === "work" ? "プライベートへ移動" : "仕事へ移動"}
          >{mode === "work" ? "🏠" : "💼"}</button>

          {level < 2 && (
            <button
              onClick={() => { setAddingChildTo(task.id); setChildText("") }}
              style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", fontSize: "15px", padding: "2px 3px" }}
              title="サブタスクを追加"
            >＋</button>
          )}
          <button
            onClick={() => openAiModal(task.text, task.id)}
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: "13px", padding: "2px 3px" }}
            title="AIで分解"
          >🤖</button>
          <button className="del-btn" onClick={() => deleteTask(task.id)}>×</button>
        </div>

        {/* メモ入力エリア */}
        {isMemoOpen && (
          <div style={{ padding: `6px 12px 10px ${20 + indent + 20}px`, background: "#fffbeb", borderBottom: "1px solid #f3f4f6" }}>
            <textarea
              autoFocus
              value={memoInput}
              onChange={e => setMemoInput(e.target.value)}
              placeholder="メモを入力..."
              rows={2}
              style={{ width: "100%", border: "1px solid #fde047", borderRadius: "6px", padding: "6px 10px", fontSize: "13px", outline: "none", resize: "vertical", lineHeight: 1.5 }}
            />
            <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
              <button onClick={() => saveMemo(task.id)} style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "6px", padding: "4px 14px", cursor: "pointer", fontSize: "13px" }}>保存</button>
              <button onClick={() => setExpandedMemoId(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", fontSize: "13px" }}>キャンセル</button>
            </div>
          </div>
        )}


        {/* インラインでサブタスク追加 */}
        {addingChildTo === task.id && (
          <div style={{ display: "flex", gap: "6px", padding: `6px 12px 6px ${20 + indent + 20}px`, background: "#f9fafb" }}>
            <input
              autoFocus
              value={childText}
              onChange={e => setChildText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") { addTask(childText, task.id, "mid", ""); setAddingChildTo(null) }
                if (e.key === "Escape") setAddingChildTo(null)
              }}
              placeholder="サブタスクを入力..."
              style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "6px", padding: "6px 10px", fontSize: "13px", outline: "none" }}
            />
            <button
              onClick={() => { addTask(childText, task.id, "mid", ""); setAddingChildTo(null) }}
              style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "13px" }}
            >追加</button>
            <button onClick={() => setAddingChildTo(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280" }}>×</button>
          </div>
        )}

        {/* 子タスク */}
        {children.map(child => (
          <div key={child.id}>
            <TaskItem task={child} level={level + 1} />
            {/* 孫タスク */}
            {grandChildren(child.id).map(grand => (
              <TaskItem key={grand.id} task={grand} level={level + 2} />
            ))}
          </div>
        ))}
      </div>
    )
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
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 24px 0" }}>
        <div className="stats">
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{activeCnt}</div><div className="stat-label">未完了</div></div>
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{doneCnt}</div><div className="stat-label">完了</div></div>
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{overdueCnt}</div><div className="stat-label">期限超過</div></div>
          <div className="stat"><div className={`stat-num stat-num-${accentCls}`}>{avgGoal}%</div><div className="stat-label">目標進捗</div></div>
        </div>
      </div>

      {/* Tab + Content */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 24px" }}>
        {/* Tabs */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: "#f3f4f6", borderRadius: "10px", padding: "4px", width: "fit-content" }}>
          {([["tasks", "✅ タスク"], ["goals", "🎯 目標"], ["memos", "📝 メモ"]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "8px 20px", borderRadius: "8px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "14px",
              background: tab === t ? (mode === "work" ? "#2563eb" : "#7c3aed") : "transparent",
              color: tab === t ? "white" : "#6b7280",
              transition: "all .2s",
            }}>{label}</button>
          ))}
        </div>

        {/* ===== TASKS TAB ===== */}
        {tab === "tasks" && (
          <div className="card">
            {/* AI説明バナー */}
            <div style={{ padding: "10px 20px", background: "#eef2ff", borderBottom: "1px solid #c7d2fe", fontSize: "12px", color: "#4338ca" }}>
              💡 <strong>🤖 AI分解</strong>：タスクを「すぐ動ける粒度」に分解します。各タスク横の🤖でサブタスクとして追加、対話で細かく調整できます。
            </div>

            {/* 入力エリア */}
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  ref={taskInputRef}
                  style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }}
                  placeholder="親タスクを追加..."
                  defaultValue=""
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      const val = taskInputRef.current?.value || ""
                      setTaskText(val)
                      addTask(val)
                      if (taskInputRef.current) taskInputRef.current.value = ""
                    }
                  }}
                />
                <button
                  onClick={() => {
                    const val = taskInputRef.current?.value || ""
                    if (!val.trim()) return
                    openAiModal(val)
                  }}
                  style={{ background: "#6366f1", color: "white", border: "none", borderRadius: "8px", padding: "8px 14px", cursor: "pointer", fontSize: "13px", fontWeight: 600, whiteSpace: "nowrap" }}
                >🤖 AI分解</button>
                <button
                  className={`add-btn add-btn-${accentCls}`}
                  onClick={() => {
                    const val = taskInputRef.current?.value || ""
                    if (!val.trim()) return
                    addTask(val)
                    if (taskInputRef.current) taskInputRef.current.value = ""
                  }}
                >+</button>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value as Priority)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 8px", fontSize: "12px", outline: "none" }}>
                  <option value="high">🔴 高</option>
                  <option value="mid">🟠 中</option>
                  <option value="low">🟢 低</option>
                </select>
                <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 8px", fontSize: "12px", outline: "none" }} />
              </div>
            </div>

            {/* フィルター */}
            <div className="filter-tabs">
              {(["all", "active", "done"] as Filter[]).map(f => (
                <button key={f} className={`filter-tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                  {f === "all" ? "すべて" : f === "active" ? "未完了" : "完了"}
                </button>
              ))}
            </div>

            {/* タスクリスト */}
            <div className="list-body">
              {loading ? <div className="empty-msg">読み込み中...</div>
                : filteredParents.length === 0 ? <div className="empty-msg">タスクがありません</div>
                : filteredParents.map(t => <TaskItem key={t.id} task={t} />)}
            </div>
          </div>
        )}

        {/* ===== GOALS TAB ===== */}
        {tab === "goals" && (
          <div className="card">
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: "8px" }}>
              <input
                style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "14px", outline: "none" }}
                placeholder="新しい目標を追加..."
                value={goalText}
                onChange={e => setGoalText(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addGoal()}
              />
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
        )}

        {/* ===== MEMOS TAB ===== */}
        {tab === "memos" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {/* メモ一覧 */}
            <div className="card">
              <div className="card-header">
                <div className="card-title"><span>📝</span> メモ一覧</div>
                <button
                  onClick={() => { setEditMemo(null); setMemoTitle(""); setMemoContent("") }}
                  className={`add-btn add-btn-${accentCls}`}
                  style={{ fontSize: "14px", padding: "6px 12px" }}
                >+ 新規</button>
              </div>
              <div className="list-body">
                {memos.length === 0 ? <div className="empty-msg">メモがありません</div>
                  : memos.map(m => (
                    <div key={m.id} onClick={() => { setEditMemo(m); setMemoTitle(m.title); setMemoContent(m.content) }}
                      style={{ padding: "12px 20px", borderBottom: "1px solid #f3f4f6", cursor: "pointer", transition: "background .1s" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={e => (e.currentTarget.style.background = "white")}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ fontWeight: 600, fontSize: "14px" }}>{m.title || "（無題）"}</div>
                        <button className="del-btn" onClick={e => { e.stopPropagation(); deleteMemo(m.id) }}>×</button>
                      </div>
                      <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.content}</div>
                    </div>
                  ))}
              </div>
            </div>

            {/* メモ編集 */}
            <div className="card">
              <div className="card-header">
                <div className="card-title"><span>✏️</span> {editMemo ? "編集" : "新規メモ"}</div>
                <button onClick={saveMemo} style={{ background: mode === "work" ? "#2563eb" : "#7c3aed", color: "white", border: "none", borderRadius: "8px", padding: "6px 16px", cursor: "pointer", fontWeight: 600, fontSize: "13px" }}>保存</button>
              </div>
              <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <input
                  value={memoTitle}
                  onChange={e => setMemoTitle(e.target.value)}
                  placeholder="タイトル"
                  style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "8px 12px", fontSize: "15px", fontWeight: 600, outline: "none" }}
                />
                <textarea
                  value={memoContent}
                  onChange={e => setMemoContent(e.target.value)}
                  placeholder="メモを入力..."
                  style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "10px 12px", fontSize: "14px", outline: "none", minHeight: "300px", resize: "vertical", lineHeight: "1.6" }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== AI CHAT MODAL ===== */}
      {aiModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div style={{ background: "white", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: "600px", height: "85vh", display: "flex", flexDirection: "column" }}>
            {/* Modal Header */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "16px" }}>🤖 AI タスク分解</div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "2px" }}>「{aiTask}」</div>
              </div>
              <button onClick={() => setAiModal(false)} style={{ border: "none", background: "none", fontSize: "24px", cursor: "pointer", color: "#6b7280" }}>×</button>
            </div>

            {/* Chat Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              {chatMsgs.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{
                    maxWidth: "85%", padding: "10px 14px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                    background: m.role === "user" ? "#6366f1" : "#f3f4f6",
                    color: m.role === "user" ? "white" : "#111827",
                    fontSize: "13px", lineHeight: "1.6", whiteSpace: "pre-wrap",
                  }}>{m.content}</div>
                </div>
              ))}

              {aiLoading && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div style={{ background: "#f3f4f6", padding: "10px 14px", borderRadius: "16px 16px 16px 4px", fontSize: "13px", color: "#6b7280" }}>
                    ⏳ AIがタスクを実行できる粒度に分解しています...
                  </div>
                </div>
              )}

              {/* 提案ボタン */}
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

            {/* Chat Input */}
            <div style={{ padding: "12px 16px", borderTop: "1px solid #e5e7eb", display: "flex", gap: "8px" }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendChatMsg()}
                placeholder="「もっと具体的に」「最初のステップを細かく」など..."
                style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: "10px", padding: "10px 14px", fontSize: "14px", outline: "none" }}
              />
              <button onClick={sendChatMsg} disabled={!chatInput.trim() || aiLoading}
                style={{ background: chatInput.trim() && !aiLoading ? "#6366f1" : "#e5e7eb", color: chatInput.trim() && !aiLoading ? "white" : "#9ca3af", border: "none", borderRadius: "10px", padding: "10px 16px", cursor: chatInput.trim() && !aiLoading ? "pointer" : "not-allowed", fontWeight: 600 }}>
                送信
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
