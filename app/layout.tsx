import type { Metadata, Viewport } from "next"
import { SessionProvider } from "next-auth/react"
import { auth } from "@/auth"
import "./globals.css"

export const metadata: Metadata = {
  title: "MyFlow - タスク・目標管理",
  description: "プライベートと仕事のタスク・目標を一元管理",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  return (
    <html lang="ja">
      <body>
        <SessionProvider session={session}>{children}</SessionProvider>
      </body>
    </html>
  )
}
