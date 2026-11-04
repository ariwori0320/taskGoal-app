import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "MyFlow",
  description: "目標・タスク・スケジュールを一つにまとめて、計画を立て直しやすくする",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F7F6F2",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
