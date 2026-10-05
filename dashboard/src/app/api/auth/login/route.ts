import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const password = String(form.get('password') ?? '')
  const expected = process.env.DASHBOARD_PASSWORD ?? ''
  const secret = process.env.DASHBOARD_SESSION_SECRET ?? ''

  if (!expected || !secret) {
    return NextResponse.redirect(new URL('/login?error=server', req.url), 303)
  }
  if (!safeCompare(password, expected)) {
    return NextResponse.redirect(new URL('/login?error=wrong', req.url), 303)
  }

  const res = NextResponse.redirect(new URL('/', req.url), 303)
  res.cookies.set('dash_session', secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 1 week
  })
  return res
}
