// Claude session board: reads the Claude desktop app's session files and
// serves a kanban board of them on localhost. No dependencies.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 4777)
const HOST = '127.0.0.1'
const SESSIONS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ??
  join(homedir(), 'Library/Application Support/Claude/claude-code-sessions')
const PROJECTS_DIR = join(homedir(), '.claude/projects')
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))

const GH_TTL_MS = 60_000
const GH_CONCURRENCY = 6
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
const SEND_TIMEOUT_MS = 30 * 60_000
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
// Give spawned tools the usual user bin folders: a server started from an
// app launcher can have a thin PATH.
const CHILD_PATH = [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH]
  .filter(Boolean)
  .join(':')

// ---------------------------------------------------------------- sessions

async function sessionFiles() {
  const files = []
  // Layout: <account>/<org>/local_<id>.json
  for (const a of await readdir(SESSIONS_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!a.isDirectory()) continue
    for (const o of await readdir(join(SESSIONS_DIR, a.name), { withFileTypes: true })) {
      if (!o.isDirectory()) continue
      const dir = join(SESSIONS_DIR, a.name, o.name)
      for (const f of await readdir(dir)) {
        if (f.startsWith('local_') && f.endsWith('.json')) files.push(join(dir, f))
      }
    }
  }
  return files
}

function repoRoot(s) {
  return (
    s.originCwd ??
    s.gitAnchors?.[0]?.gitRoot ??
    (s.cwd ?? '').split('/.claude/worktrees/')[0]
  )
}

// ~/.claude/projects/<cwd with / and . as ->/<cliSessionId>.jsonl
function transcriptPath(s) {
  if (!s.cliSessionId || !s.cwd) return ''
  return join(PROJECTS_DIR, s.cwd.replace(/[/.]/g, '-'), `${s.cliSessionId}.jsonl`)
}

// What the transcript's tail says: when it last got a real message, and
// whether a turn is still open there. The file's modified time is no good for
// either: the app appends untimed bookkeeping rows (last-prompt, cost-state)
// to old transcripts in batches. A turn is open when the last message is not
// Claude's finished reply: a tool call waiting on its result, or a prompt or
// tool result Claude hasn't answered yet.
const TAIL_BYTES = 64 * 1024
const OPEN_TURN_MAX_MS = 30 * 60_000
const ENDED = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])

async function transcriptTail(s) {
  const none = { at: 0, isOpen: false }
  const path = transcriptPath(s)
  if (!path) return none
  let fh
  try {
    const { mtimeMs, size } = await stat(path)
    // Skip the read unless the file changed after the app's own record, or
    // recently (a running turn keeps writing).
    if (mtimeMs <= (s.lastActivityAt ?? 0) && Date.now() - mtimeMs > OPEN_TURN_MAX_MS) return none
    fh = await open(path, 'r')
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (len < size) lines.shift() // first line is cut
    let at = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      let row
      try { row = JSON.parse(lines[i]) } catch { continue }
      if (!at) at = Date.parse(row.timestamp) || 0
      if ((row.type === 'user' || row.type === 'assistant') && !row.isSidechain) {
        const ended = row.type === 'assistant' && ENDED.has(row.message?.stop_reason)
        return { at: at || Date.parse(row.timestamp) || 0, isOpen: !ended }
      }
    }
    return { at, isOpen: false }
  } catch {
    return none
  } finally {
    await fh?.close()
  }
}

// -------------------------------------------------------------------- gh

const ghCache = new Map()

function gh(args) {
  return new Promise(resolve => {
    execFile('gh', args, { timeout: 20_000, env: { ...process.env, PATH: CHILD_PATH } }, (err, stdout) =>
      resolve(err ? null : stdout),
    )
  })
}

const FAILED = new Set([
  'FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
])

function ciFrom(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const outcome = c.conclusion || c.state
    if (outcome && FAILED.has(outcome)) return 'failing'
    if ((c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED') {
      pending = true
    }
  }
  return pending ? 'pending' : 'passing'
}

async function prStatus(url) {
  const hit = ghCache.get(url)
  if (hit && Date.now() - hit.at < GH_TTL_MS) return hit.value
  const out = await gh([
    'pr', 'view', url, '--json', 'state,isDraft,reviewDecision,statusCheckRollup,title',
  ])
  let value = { ci: 'unknown' }
  if (out) {
    try {
      const pr = JSON.parse(out)
      value = {
        state: pr.state,
        isDraft: pr.isDraft,
        reviewDecision: pr.reviewDecision || undefined,
        ci: ciFrom(pr.statusCheckRollup),
        title: pr.title,
      }
    } catch {}
  }
  ghCache.set(url, { at: Date.now(), value })
  return value
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const n = i++
        out[n] = await fn(items[n])
      }
    }),
  )
  return out
}

// ----------------------------------------------------------------- board

// A session's prs list also holds PRs it only looked at. Prefer the one it
// opened (`own`), then the one on its own branch, then any it didn't just read.
function pickPr(s) {
  const prs = Array.isArray(s.prs) ? s.prs : []
  if (prs.length === 0) return undefined
  const own = prs.filter(p => p.own)
  if (own.length) return { ...(own.find(p => p.state === 'OPEN') ?? own.at(-1)), isOwn: true }
  const onBranch = s.branch && prs.find(p => p.branch === s.branch)
  if (onBranch) return { ...onBranch, isOwn: true }
  const rest = prs.filter(p => !p.notOwnRead)
  const pick = rest.find(p => p.state === 'OPEN') ?? rest.at(-1)
  return pick && { ...pick, isOwn: false }
}

function classify(s, pr, live, isRunning) {
  // A PR that several sessions only share (the checkout's branch, say) says
  // nothing about this session's state: show it, but don't place by it.
  if (pr?.isShared) { pr = undefined; live = undefined }
  const summary = s.postTurnSummary ?? {}
  const needsAction = summary.needs_action || s.turnWrapUp?.needsUser || ''
  const state = live?.state ?? pr?.state
  const badges = []
  if (live?.isDraft) badges.push('draft')

  const isOpen = state === 'OPEN'
  const ciFailing = isOpen && live?.ci === 'failing'

  if (isRunning) {
    if (ciFailing) badges.push('CI failing')
    return { column: ciFailing ? 'ci' : 'working', badges }
  }
  if (needsAction || summary.status_category === 'blocked' || s.interruptedAwaitingPerson) {
    if (s.interruptedAwaitingPerson) badges.push('interrupted')
    return { column: 'needs-you', badges }
  }
  if (isOpen) {
    if (live?.ci === 'failing') return { column: 'ci', badges: [...badges, 'CI failing'] }
    if (live?.ci === 'pending') return { column: 'ci', badges: [...badges, 'CI running'] }
    if (live?.reviewDecision === 'CHANGES_REQUESTED') {
      return { column: 'needs-you', badges: [...badges, 'changes requested'] }
    }
    if (live?.reviewDecision === 'APPROVED' && !live.isDraft) {
      return { column: 'ready', badges: [...badges, 'approved'] }
    }
    if (live?.ci === 'unknown') badges.push('CI ?')
    return { column: 'review', badges }
  }
  if (state === 'MERGED') return { column: 'done', badges: [...badges, 'merged'] }
  if (state === 'CLOSED') return { column: 'done', badges: [...badges, 'closed'] }
  // Finished work with no PR that the app marked for your review: it waits on
  // you, not on a reviewer.
  if (summary.status_category === 'review_ready') return { column: 'needs-you', badges: [...badges, 'ready for review'] }
  return { column: 'done', badges }
}

async function buildBoard() {
  const now = Date.now()
  const sessions = []
  for (const f of await sessionFiles()) {
    try {
      const s = JSON.parse(await readFile(f, 'utf8'))
      if (!s.isArchived) sessions.push(s)
    } catch {}
  }

  const openUrls = [
    ...new Set(
      sessions.flatMap(s => (s.prs ?? []).filter(p => p.state === 'OPEN' && p.url).map(p => p.url)),
    ),
  ]
  const statuses = new Map(
    (await mapLimit(openUrls, GH_CONCURRENCY, async u => [u, await prStatus(u)])),
  )

  const picks = new Map(sessions.map(s => [s.sessionId, pickPr(s)]))
  const weakUse = new Map()
  for (const p of picks.values()) {
    if (p?.url && !p.isOwn) weakUse.set(p.url, (weakUse.get(p.url) ?? 0) + 1)
  }
  for (const p of picks.values()) {
    if (p && !p.isOwn && (weakUse.get(p.url) ?? 0) >= 3) p.isShared = true
  }

  const cards = await Promise.all(
    sessions.map(async s => {
      const pr = picks.get(s.sessionId)
      const live = pr?.url ? statuses.get(pr.url) : undefined
      const tail = await transcriptTail(s)
      const isRunning = isDesktopRunning(s, tail) || !!jobs.get(s.sessionId)?.isRunning
      const { column, badges } = classify(s, pr, live, isRunning)
      const root = repoRoot(s)
      return {
        id: s.sessionId,
        title: s.title || '(untitled)',
        project: basename(root) || root,
        projectPath: root,
        column,
        badges,
        isRunning,
        link: `claude://claude.ai/epitaxy/${s.sessionId}`,
        branch: s.branch,
        pr: pr && { number: pr.prNumber, url: pr.url, repo: pr.repo, state: live?.state ?? pr.state, isShared: !!pr.isShared },
        needsAction: s.postTurnSummary?.needs_action || '',
        summary: s.postTurnSummary?.status_detail || s.turnWrapUp?.description || '',
        model: s.model,
        lastActivityAt: Math.max(s.lastActivityAt ?? 0, tail.at, jobs.get(s.sessionId)?.finishedAt ?? 0),
        createdAt: s.createdAt,
      }
    }),
  )

  return { generatedAt: now, cards }
}

// ------------------------------------------------------------------ chat

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const WRAPPERS = /<\/?(pasted_content|command-name|command-message|command-args|local-command-stdout)[^>]*>/g

function cleanUserText(text) {
  return text.replace(REMINDER, '').replace(WRAPPERS, '').trim()
}

// One line saying what a tool call did, from the fields tools commonly carry.
function toolLine(block) {
  const i = block.input ?? {}
  // mcp__server__tool_name -> tool_name
  const name = String(block.name ?? 'tool').split('__').at(-1)
  const what =
    i.description ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.command ?? i.prompt ?? i.title ?? ''
  return { name, detail: String(what).split('\n')[0].slice(0, 160) }
}

async function findSession(id) {
  if (!/^local_[\w-]+$/.test(id)) return undefined
  for (const f of await sessionFiles()) {
    if (basename(f) === `${id}.json`) return JSON.parse(await readFile(f, 'utf8'))
  }
  return undefined
}

async function readChat(id, limit) {
  const s = await findSession(id)
  if (!s) return undefined
  const path = transcriptPath(s)
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { id, title: s.title, messages: [], note: 'No transcript on disk for this session.' }
  }

  const messages = []
  const seen = new Set()
  for (const line of raw.split('\n')) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || d.isMeta) continue
    // Streaming writes one row per content block under the same message id.
    const content = d.message?.content
    const at = Date.parse(d.timestamp) || 0

    if (d.type === 'user') {
      if (typeof content === 'string') {
        const text = cleanUserText(content)
        if (text) messages.push({ role: 'user', text, at })
      } else if (Array.isArray(content)) {
        const text = cleanUserText(
          content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
        )
        if (text) messages.push({ role: 'user', text, at })
      }
      continue
    }

    for (const b of Array.isArray(content) ? content : []) {
      const key = `${d.message?.id}:${b.type}:${b.id ?? b.text?.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (b.type === 'text' && b.text?.trim()) {
        messages.push({ role: 'assistant', text: b.text.trim(), at })
      } else if (b.type === 'tool_use') {
        const last = messages.at(-1)
        const tool = toolLine(b)
        if (last?.role === 'tools') last.tools.push(tool)
        else messages.push({ role: 'tools', tools: [tool], at })
      }
    }
  }

  return {
    id,
    title: s.title,
    job: jobView(id),
    isDesktopRunning: isDesktopRunning(s, await transcriptTail(s)),
    total: messages.length,
    messages: messages.slice(-limit),
  }
}

// ------------------------------------------------------------------ send

// One headless turn per session at a time: sessionId -> job.
const jobs = new Map()

// The desktop app records the end of its own turns (lastTurnEdgeAt) but not
// of turns the board ran, so a board turn's end counts as an edge too.
// Claude is mid-turn in the desktop app: the transcript's last turn is open,
// and recent enough not to be a crash or an interrupted turn left behind.
function isDesktopRunning(s, tail) {
  const job = jobs.get(s.sessionId)
  if (job?.isRunning) return false
  if (!tail.isOpen || Date.now() - tail.at > OPEN_TURN_MAX_MS) return false
  // A board turn that ended after this message closed it.
  return tail.at > (job?.finishedAt ?? 0)
}

function jobView(id) {
  const j = jobs.get(id)
  return j && { isRunning: j.isRunning, startedAt: j.startedAt, error: j.error }
}

// Continues the session's own conversation with `claude -p --resume`, in the
// session's folder and permission mode. The turn lands in the same
// transcript the desktop app reads.
async function sendMessage(id, text) {
  const s = await findSession(id)
  if (!s) return { status: 404, error: 'No such session' }
  if (!s.cliSessionId) return { status: 409, error: 'This session has no CLI conversation to continue.' }
  if (jobs.get(id)?.isRunning) return { status: 409, error: 'A message from the board is still running here.' }
  if (isDesktopRunning(s, await transcriptTail(s))) {
    return { status: 409, error: 'Claude is working in this session in the desktop app. Wait for it to finish.' }
  }
  const cwd = [s.cwd, s.originCwd, repoRoot(s)].find(d => d && existsSync(d))
  if (!cwd) return { status: 409, error: "The session's folder no longer exists." }

  const args = ['-p', '--resume', s.cliSessionId, '--output-format', 'stream-json', '--verbose']
  if (PERMISSION_MODES.has(s.permissionMode)) args.push('--permission-mode', s.permissionMode)

  const job = { isRunning: true, startedAt: Date.now(), error: '' }
  jobs.set(id, job)
  const child = spawn(CLAUDE_BIN, args, { cwd, env: { ...process.env, PATH: CHILD_PATH } })
  const timer = setTimeout(() => child.kill('SIGTERM'), SEND_TIMEOUT_MS)
  let buf = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const ev = JSON.parse(line)
        // A failed sign-in still ends in a "success" result, so read the text.
        if (ev.type === 'result' && (ev.is_error || /^(Failed to authenticate|Invalid API key|Not logged in)/i.test(ev.result ?? ''))) {
          job.error = ev.result || ev.subtype || 'The turn failed.'
        }
      } catch {}
    }
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  child.on('error', err => { job.error = `Couldn't start claude: ${err.message}` })
  child.on('close', code => {
    clearTimeout(timer)
    job.isRunning = false
    job.finishedAt = Date.now()
    if (code !== 0 && !job.error) job.error = stderr.trim().split('\n').at(-1) || `claude exited with code ${code}`
  })
  child.stdin.end(text)

  return { status: 202 }
}

function readBody(req, max = 100_000) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => {
      body += c
      if (body.length > max) reject(Object.assign(new Error('Too large'), { status: 413 }))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- server

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`)
  // Answer only requests addressed to this server by name (no DNS rebinding),
  // and take writes only from its own page (no other site can post here).
  const own = [`127.0.0.1:${PORT}`, `localhost:${PORT}`]
  if (!own.includes(req.headers.host ?? '')) {
    res.writeHead(421, { 'content-type': 'text/plain' })
    return res.end('Misdirected request')
  }
  try {
    const send = url.pathname.match(/^\/api\/session\/([\w-]+)\/send$/)
    if (send) {
      const origin = req.headers.origin ?? ''
      if (
        req.method !== 'POST' ||
        !own.some(h => origin === `http://${h}`) ||
        !(req.headers['content-type'] ?? '').startsWith('application/json')
      ) {
        res.writeHead(403, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Forbidden' }))
      }
      const { text } = JSON.parse(await readBody(req))
      if (typeof text !== 'string' || !text.trim()) {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Empty message' }))
      }
      const out = await sendMessage(send[1], text.trim())
      res.writeHead(out.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: out.error, job: jobView(send[1]) }))
    }
    if (url.pathname === '/api/board') {
      const body = JSON.stringify(await buildBoard())
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(body)
    }
    const chat = url.pathname.match(/^\/api\/session\/([\w-]+)\/chat$/)
    if (chat) {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
      const data = await readChat(chat[1], limit)
      res.writeHead(data ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data ?? { error: 'No such session' }))
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (name.includes('..') || name.includes('/')) throw Object.assign(new Error(), { code: 'ENOENT' })
    const file = await readFile(join(PUBLIC_DIR, name))
    res.writeHead(200, { 'content-type': TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream' })
    res.end(file)
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : err.status ?? 500
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(status === 404 ? 'Not found' : String(err.message ?? err))
  }
}).listen(PORT, HOST, () => {
  console.log(`Claude session board on http://${HOST}:${PORT}`)
})
