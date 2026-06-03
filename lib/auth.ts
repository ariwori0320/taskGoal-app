import { NextAuthOptions } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Password",
      credentials: {
        password: { label: "パスワード", type: "password" },
      },
      async authorize(credentials) {
        if (credentials?.password === process.env.APP_PASSWORD) {
          return { id: "owner", name: "けんた", email: "owner@myflow.app" }
        }
        return null
      },
    }),
  ],
  secret: process.env.AUTH_SECRET,
  pages: { signIn: "/login" },
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub
      return session
    },
  },
}
