import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET || "fallback-secret-change-me")
const COOKIE = "myflow_session"

export async function createSession() {
  const token = await new SignJWT({ userId: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(SECRET)

  cookies().set(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  })
}

export async function getSession(): Promise<{ userId: string } | null> {
  const token = cookies().get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return { userId: payload.userId as string }
  } catch {
    return null
  }
}

export async function deleteSession() {
  cookies().delete(COOKIE)
}
