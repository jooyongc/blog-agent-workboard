import { NextRequest, NextResponse } from 'next/server'
import { isAuthed } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * POST /api/pipeline/trigger
 *
 * Fires a GitHub Actions workflow_dispatch to run the weekly pipeline
 * manually. Requires:
 *   GITHUB_TOKEN   — Personal Access Token with `workflow` scope
 *   GITHUB_REPO    — e.g. "jooyongc/asty-blog-agent"
 *   GITHUB_WORKFLOW— file name (default "weekly.yml")
 *
 * Body: { limit?: 1-5, dry_run?: boolean }
 */
export async function POST(req: NextRequest) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPO || 'jooyongc/asty-blog-agent'
  const workflow = process.env.GITHUB_WORKFLOW || 'weekly.yml'
  if (!token) {
    return NextResponse.json(
      { error: 'GITHUB_TOKEN not configured. Add a PAT (workflow scope) in dashboard Vercel env.' },
      { status: 500 },
    )
  }

  const body = (await req.json().catch(() => null)) as {
    limit?: number
    dry_run?: boolean
    site_id?: string
  } | null

  const limit = body?.limit ?? 3
  const dryRun = body?.dry_run ?? true
  const siteId = body?.site_id ?? 'asty-cabin'
  if (!Number.isInteger(limit) || limit < 1 || limit > 5 || typeof dryRun !== 'boolean' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteId)) {
    return NextResponse.json({ error: 'Invalid limit, dry_run or site_id' }, { status: 400 })
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { limit: String(limit), dry_run: String(dryRun), site_id: siteId },
      }),
    },
  )

  if (res.status === 204) {
    return NextResponse.json({
      ok: true,
      message: '파이프라인 실행 요청됨. GitHub Actions에서 진행 상태와 결과를 확인하세요.',
      runs_url: `https://github.com/${repo}/actions/workflows/${workflow}`,
      limit,
      dry_run: dryRun,
    })
  }

  const text = await res.text()
  return NextResponse.json(
    { error: `GitHub API ${res.status}`, detail: text.slice(0, 500) },
    { status: 502 },
  )
}

/**
 * GET /api/pipeline/trigger
 * Returns the latest workflow runs so the dashboard can show status.
 */
export async function GET(req: NextRequest) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPO || 'jooyongc/asty-blog-agent'
  const workflow = process.env.GITHUB_WORKFLOW || 'weekly.yml'
  if (!token) return NextResponse.json({ runs: [], configured: false })

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=5`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!res.ok) return NextResponse.json({ runs: [], configured: true, error: `GitHub API ${res.status}` })
    const j = (await res.json()) as {
      workflow_runs: Array<{
        id: number
        status: string
        conclusion: string | null
        event: string
        created_at: string
        updated_at: string
        html_url: string
        display_title: string
      }>
    }
    return NextResponse.json({
      configured: true,
      runs: j.workflow_runs.map((r) => ({
        id: r.id,
        status: r.status,
        conclusion: r.conclusion,
        event: r.event,
        created_at: r.created_at,
        updated_at: r.updated_at,
        html_url: r.html_url,
        title: r.display_title,
      })),
    })
  } catch (e) {
    return NextResponse.json({ runs: [], configured: true, error: (e as Error).message })
  }
}
