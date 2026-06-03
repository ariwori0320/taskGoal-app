"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export default function LoginPage() {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      router.push("/")
      router.refresh()
    } else {
      setError("パスワードが違います")
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">📋</div>
        <h1 className="login-title">MyFlow</h1>
        <p className="login-sub">
          プライベートと仕事の<br />タスク・目標を一元管理
        </p>
        <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <input
            type="password"
            placeholder="パスワードを入力"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: "10px",
              padding: "12px 16px",
              fontSize: "15px",
              outline: "none",
              textAlign: "center",
            }}
            autoFocus
          />
          {error && <p style={{ color: "#dc2626", fontSize: "13px", margin: 0 }}>{error}</p>}
          <button type="submit" className="github-btn" disabled={loading || !password}>
            {loading ? "確認中..." : "ログイン"}
          </button>
        </form>
      </div>
    </div>
  )
}
