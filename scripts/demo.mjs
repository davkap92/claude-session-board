// Run the board against made-up sessions, for trying it out and for
// screenshots. Writes fake session files, transcripts and a stand-in for `gh`
// to a temp folder, then starts the server on port 4778 pointed at them.
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'session-board-demo-'))
const sessionsDir = join(root, 'sessions')
const projectsDir = join(root, 'projects')
const orgDir = join(sessionsDir, 'account', 'org')
mkdirSync(orgDir, { recursive: true })

const now = Date.now()
const min = 60_000
const hr = 60 * min

// PR state as `gh pr view --json state,isDraft,reviewDecision,statusCheckRollup,title` returns it.
const ok = { status: 'COMPLETED', conclusion: 'SUCCESS' }
const prs = {}
let prNo = 400
function pr(repo, { checks = [ok, ok], review = 'REVIEW_REQUIRED', state = 'OPEN', draft = false } = {}) {
  const number = ++prNo
  const url = `https://github.com/acme/${repo}/pull/${number}`
  prs[url] = { state, isDraft: draft, reviewDecision: review, statusCheckRollup: checks, title: '' }
  return { prNumber: number, url, repo: `acme/${repo}`, state, own: true }
}

// [project, title, age, extra]
const sessions = [
  ['payments-api', 'PAY-148: Retry webhook deliveries with exponential backoff', 2 * min, {
    running: true,
    summary: 'Adding jittered backoff to the delivery worker and a dead-letter queue after 8 attempts.',
  }],
  ['web-dashboard', 'WEB-325: Dark mode for the settings pages', 4 * min, {
    running: true,
    summary: 'Swapping hard-coded colours for theme tokens across the settings routes.',
  }],
  ['payments-api', 'PAY-155: Migrate refunds table to bigint ids', 25 * min, {
    blocked: 'Approve running the migration against the staging database.',
    summary: 'Migration and backfill are written and tested locally. Running it on staging locks the refunds table for about 40 seconds.',
  }],
  ['web-dashboard', 'WEB-332: Fix chart tooltips clipping on mobile', 50 * min, {
    pr: pr('web-dashboard', { review: 'CHANGES_REQUESTED' }),
    summary: 'Reviewer asked for the tooltip to flip above the cursor near the bottom edge instead of shrinking.',
  }],
  ['infra', 'OPS-64: Audit unused IAM roles', 3 * hr, {
    reviewReady: true,
    summary: 'Found 14 roles with no use in 90 days. The list and the evidence for each are in docs/iam-audit.md.',
  }],
  ['payments-api', 'PAY-162: Add idempotency keys to POST /charges', 35 * min, {
    pr: pr('payments-api', { checks: [ok, { status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    summary: 'Integration test for concurrent duplicate requests fails on CI only; looks like a race in the test fixture.',
  }],
  ['infra', 'OPS-71: Bump Postgres to 16 in local compose', 15 * min, {
    pr: pr('infra', { checks: [ok, { status: 'IN_PROGRESS' }] }),
    summary: 'Pushed the version bump and updated the init scripts. Waiting on the compose smoke test.',
  }],
  ['web-dashboard', 'WEB-339: Paginate the audit log view', 2 * hr, {
    pr: pr('web-dashboard'),
    summary: 'Cursor pagination with a 50-row page, plus a test for the empty last page.',
  }],
  ['docs-site', 'DOC-96: Document the webhooks v2 payloads', 5 * hr, {
    pr: pr('docs-site'),
    summary: 'New reference page for all 11 event types with example payloads generated from the schema.',
  }],
  ['payments-api', 'PAY-169: Structured logging for the payout worker', 6 * hr, {
    pr: pr('payments-api'),
    summary: 'Replaced string logs with key-value fields and added a request id to every line.',
  }],
  ['infra', 'OPS-78: Alert on queue depth over 10k', 4 * hr, {
    pr: pr('infra', { review: 'APPROVED' }),
    summary: 'Approved and green. The alert routes to the payments on-call channel.',
  }],
  ['docs-site', 'DOC-103: Fix broken links in the quickstart', 9 * hr, {
    pr: pr('docs-site', { state: 'MERGED' }),
    summary: 'Fixed 6 links and added a link check to CI.',
  }],
  ['web-dashboard', 'WEB-346: Upgrade to React 19', 20 * hr, {
    pr: pr('web-dashboard', { state: 'MERGED' }),
    summary: 'Upgraded with no code changes beyond two deprecated ref callbacks.',
  }],
  ['payments-api', 'Why do some refunds show twice?', 22 * hr, {
    summary: 'Duplicate rows come from the export job retrying after a timeout. Explained in the session; no change needed.',
  }],
]

function transcript(file, title, at, running) {
  const t = ms => new Date(ms).toISOString()
  const rows = [
    { type: 'user', timestamp: t(at - 12 * min), message: { role: 'user', content: `Implement ${title}` } },
    {
      type: 'assistant', timestamp: t(at - 11 * min),
      message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'text', text: "I'll start by reading the delivery worker and its tests." },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/webhooks/deliver.ts' } },
        { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'scheduleRetry' } },
      ] },
    },
    { type: 'user', timestamp: t(at - 10 * min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '…' }] } },
    {
      type: 'assistant', timestamp: t(at - 9 * min),
      message: { id: 'm2', role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'text', text: 'Deliveries retry **immediately** three times and then give up, so a receiver that is down for a minute loses events.\n\nPlan:\n\n1. Exponential backoff with jitter, capped at 1 hour\n2. Up to 8 attempts, then park the event in a dead-letter table\n3. A test that fakes the clock through all 8 attempts\n\nShall I go ahead?' },
      ] },
    },
    { type: 'user', timestamp: t(at - 6 * min), message: { role: 'user', content: 'yes, go ahead' } },
    {
      type: 'assistant', timestamp: t(at),
      message: { id: 'm3', role: 'assistant', stop_reason: running ? 'tool_use' : 'end_turn', content: [
        { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'src/webhooks/deliver.ts' } },
        { type: 'tool_use', id: 't4', name: 'Bash', input: { description: 'Run the webhook tests' } },
      ] },
    },
  ]
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}

sessions.forEach(([project, title, age, x], i) => {
  const id = `local_demo${i}`
  const cliSessionId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  const cwd = `/Users/demo/code/${project}`
  const at = now - age
  const s = {
    sessionId: id,
    cliSessionId,
    cwd,
    originCwd: cwd,
    title,
    branch: title.replace(/: /, '-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40),
    permissionMode: 'default',
    isArchived: false,
    createdAt: at - 30 * min,
    lastActivityAt: at,
    lastTurnEdgeAt: at,
    prs: x.pr ? [x.pr] : [],
    postTurnSummary: {
      status_category: x.blocked ? 'blocked' : x.reviewReady ? 'review_ready' : 'completed',
      status_detail: x.summary,
      needs_action: x.blocked ?? '',
    },
  }
  writeFileSync(join(orgDir, `${id}.json`), JSON.stringify(s, null, 2))

  const dir = join(projectsDir, cwd.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  transcript(join(dir, `${cliSessionId}.jsonl`), title, at, x.running)
})

// Stand-in for `gh pr view <url> --json ...`
const ghBin = join(root, 'gh')
writeFileSync(join(root, 'prs.json'), JSON.stringify(prs))
writeFileSync(ghBin, `#!/usr/bin/env node
const prs = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(root, 'prs.json'))}, 'utf8'))
const pr = prs[process.argv[4]]
if (!pr) process.exit(1)
process.stdout.write(JSON.stringify(pr))
`)
chmodSync(ghBin, 0o755)

const port = process.env.PORT ?? '4778'
console.log(`Demo data in ${root}`)
spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: port,
    CLAUDE_SESSIONS_DIR: sessionsDir,
    CLAUDE_PROJECTS_DIR: projectsDir,
    GH_BIN: ghBin,
    CLAUDE_BIN: '/usr/bin/false',
  },
})
