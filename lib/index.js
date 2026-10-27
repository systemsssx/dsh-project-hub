/**
 * dsh-project-hub — lib/index.js
 * Host half of DSH Project Hub:
 * - Three-tier workspace management (Root -> Project -> Subtask)
 * - Two-tier tag documentation (.dsh-hub/docs/<bigTag>/<smallTag>.md)
 * - Safe session launch with full permissions in isolated sub-workspaces
 * - Rigorous completion gate & zero notification spam
 *
 * HTTP contract (DSH 0.2.1-rc.3 desktop, verified against the shipped
 * `@deepseek-ai/dsh-host-webserver`): `ctx.webServer.register({ kind:'exact',
 * path, handler })` hands the handler the RAW `node:http` request/response
 * pair — `handler(req, res)`. It is NOT the Fetch API: a handler must write and
 * end `res` itself. Returning a `Response` object leaves the socket open, which
 * is exactly the `net::ERR_UNEXPECTED` the client used to see.
 *
 * The desktop renderer runs from `dsh-app://app/`; its main process forwards
 * document-relative app routes to this Host, and the client may also call the
 * Host origin directly (`__DSH_TRANSPORT__.streamBaseUrl`) — so every route
 * answers permissive CORS (including the Private Network Access preflight) and
 * never depends on a browser cookie.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initProjectRegistry,
  listProjectsWithDocs,
  createProject,
  computeSubWorkspace,
  writeTagDoc,
  readTagDocs,
  ensureDir,
  removeProjectFromRegistry,
  validateTagName,
  listBigTagDocs,
} from './doc-manager.js'
import { registerModuleDoneTool } from './completion-gate.js'

export const name = 'dsh-project-hub'
export const version = '0.2.0'

export const Config = undefined // Schemastery guard: keep undefined for link: compatibility

/**
 * 「总工作区」兜底默认值，优先级：
 *   config.globalWorkspaceRoot（cordis.patch.yml）
 *     > DSH_PROJECT_HUB_ROOT 环境变量
 *     > 'C:\work'
 * 真实生效值还可以在插件「设置」里热切换，并持久化到 <pluginRoot>/config.json。
 */
const DEFAULT_GLOBAL_ROOT = process.env.DSH_PROJECT_HUB_ROOT || 'C:\\work'
/** Plugin package root — default home of the persisted 「总工作区」 settings. */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Default settings file: <pluginRoot>/config.json (never created at load). */
const DEFAULT_SETTINGS_FILE = join(PLUGIN_ROOT, 'config.json')

/** Standby line required after background injection (text only, no options). */
const PROJECT_STANDBY = '相关模块背景已同步完毕，复合子工作区已就绪。请问下一步干嘛？'
/** Standby line for the scratchpad (其他 / 杂务) session. */
const SCRATCHPAD_STANDBY = '请问有什么琐事需要处理？'

/**
 * Agent modes offered by the 「启动会话」 form. Each row maps a user-visible
 * mode to the Agent preset that backs it: `standard` is the shipped coding
 * preset, `computer-use` is inserted by the dsh-orb bundle and drives the
 * desktop GUI (screenshots, mouse, keyboard). Both modes launch with
 * FULL_ACCESS_PRESET pinned on the new Session.
 */
const AGENT_MODE_STANDARD = 'standard'
const AGENT_MODE_ROWS = [
  {
    id: AGENT_MODE_STANDARD,
    name: '标准模式',
    description: '常规开发 / 文档会话：编码、文件、搜索与子代理工具。',
  },
  {
    id: 'computer-use',
    name: 'Computer Use 模式',
    description: '桌面 GUI 操作：截图、鼠标键盘与桌面应用自动化。',
  },
]
/** Permission preset every Session started from the hub is pinned to. */
const FULL_ACCESS_PRESET = 'danger-full-access'

const SESSION_SCAN_LIMIT = 40
const CHANGE_SCAN_LIMIT = 16
/** Total wall-clock budget for the best-effort changed-file scan (modal open). */
const CHANGE_SCAN_BUDGET_MS = 3000
const MAX_BODY_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// HTTP helpers — raw node:http contract (req, res)
// ---------------------------------------------------------------------------

function headerOf(req, name) {
  try {
    const value = req && req.headers ? req.headers[name] : undefined
    return Array.isArray(value) ? value[0] : value
  } catch {
    return undefined
  }
}

/**
 * CORS headers for a raw Host route.
 *
 * Two legitimate callers exist:
 *  - the desktop renderer at `dsh-app://app/` calling the Host origin directly
 *    (absolute `http://127.0.0.1:<port>/project-hub/*`), which is cross-origin;
 *  - the desktop shell's document-relative proxy (same request, no CORS check).
 *
 * Echoing the caller's Origin (never a wildcard with credentials, and this
 * plugin uses none) keeps both working. The PNA header answers Chromium's
 * private-network preflight when the desktop page is treated as a public
 * initiator reaching loopback.
 */
function corsHeadersOf(req) {
  const origin = headerOf(req, 'origin')
  const headers = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }
  if (String(headerOf(req, 'access-control-request-private-network') || '').toLowerCase() === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true'
  }
  return headers
}

/** Finish one JSON response. Always ends the node response exactly once. */
function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload)
  if (res.headersSent) {
    try {
      res.end(body)
    } catch {
      /* already closed */
    }
    return
  }
  res.writeHead(status, {
    ...corsHeadersOf(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** CORS preflight answer. */
function sendPreflight(req, res) {
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      /* already closed */
    }
    return
  }
  res.writeHead(204, corsHeadersOf(req))
  res.end()
}

/** Read and parse a JSON request body from a raw node request. */
async function readJsonBody(req) {
  let size = 0
  const chunks = []
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(buf)
    }
  } catch (error) {
    if (error && String(error.message).includes('too large')) throw error
    return {}
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Wrap a route so the response ALWAYS settles: OPTIONS preflight is answered
 * here, handler throws become a 500 JSON instead of a dropped socket, and a
 * handler that forgot to answer still gets a terminal response.
 */
function route(handler) {
  return async (req, res) => {
    try {
      if (req && req.method === 'OPTIONS') {
        sendPreflight(req, res)
        return
      }
      await handler(req, res)
      if (!res.writableEnded && !res.headersSent) {
        sendJson(req, res, 500, { ok: false, error: 'handler produced no response' })
      } else if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          /* already closed */
        }
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: message })
      else {
        try {
          res.end()
        } catch {
          /* already closed */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 「总工作区」 settings — effective root resolution, validation, persistence
// ---------------------------------------------------------------------------

/** Settings file: explicit `config.settingsFile` wins, else <pluginRoot>/config.json. */
function settingsFileOf(config) {
  const value = config && config.settingsFile
  return typeof value === 'string' && value.trim() ? value : DEFAULT_SETTINGS_FILE
}

/** True only for a non-blank absolute path that currently exists as a directory. */
function isExistingAbsoluteDirectory(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue.trim() || !isAbsolute(pathValue)) return false
  try {
    return statSync(pathValue).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the effective root at apply() time.
 *
 * `config.globalWorkspaceRoot` (cordis.patch.yml, default C:\work) is the base.
 * A persisted settings file only wins when it carries an absolute path that is
 * an EXISTING directory; anything else warns and falls back to `configured`.
 * The file is never created or rewritten on load, and the persisted directory
 * is never auto-created here.
 */
function resolveInitialRoot(configured, settingsFile, log) {
  if (!existsSync(settingsFile)) return configured
  try {
    const data = JSON.parse(readFileSync(settingsFile, 'utf8'))
    const persisted = data && typeof data.globalWorkspaceRoot === 'string'
      ? data.globalWorkspaceRoot.trim()
      : ''
    if (isExistingAbsoluteDirectory(persisted)) return resolve(persisted)
    log(
      'warn',
      `invalid globalWorkspaceRoot in ${settingsFile} (${JSON.stringify(persisted)}), falling back to ${configured}`,
    )
  } catch (error) {
    log(
      'warn',
      `cannot read settings file ${settingsFile}: ${error && error.message ? error.message : String(error)}; falling back to ${configured}`,
    )
  }
  return configured
}

/** Comparison form of a path: resolved, without a trailing separator, lowercase. */
function comparablePath(pathValue) {
  try {
    let normalized = resolve(String(pathValue))
    if (/^[a-zA-Z]:[\\/]+$/.test(normalized)) {
      // Keep a bare drive root intact ("c:\"), which resolve() may return.
      normalized = normalized.slice(0, 2) + sep
    } else {
      normalized = normalized.replace(/[\\/]+$/, '')
    }
    return (normalized || resolve('.')).toLowerCase()
  } catch {
    return String(pathValue || '').toLowerCase()
  }
}

/** True when `candidate` equals `parent` or lives inside it (normalized compare). */
function isSameOrInsidePath(candidate, parent) {
  const c = comparablePath(candidate)
  const p = comparablePath(parent)
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Registered projects of `root` as absolute directories (never creates them). */
function registeredProjectDirs(root) {
  let projects = []
  try {
    projects = initProjectRegistry(root)
  } catch {
    projects = []
  }
  const out = []
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!project || typeof project !== 'object') continue
    const id = project.id === undefined || project.id === null ? '' : String(project.id)
    const pathValue = typeof project.path === 'string' && project.path.trim()
      ? project.path
      : id
        ? join(root, id)
        : ''
    if (!pathValue) continue
    out.push({ id, name: project.name ? String(project.name) : id, path: pathValue })
  }
  return out
}

/**
 * Validate a POSTed `globalWorkspaceRoot`. Pure: no writes, no directory
 * creation for the candidate. Returns `{ ok: true, root }` (normalized absolute
 * path) or `{ ok: false, code, message }` with a user-facing Chinese message.
 *
 * Order: required -> absolute -> existing directory -> not a project dir.
 */
function validateGlobalRootInput(value, currentRoot) {
  if (typeof value !== 'string' || !value.trim()) {
    return {
      ok: false,
      code: 'root_required',
      message: '请填写总工作区路径：globalWorkspaceRoot 不能为空（必须是字符串）。',
    }
  }
  const raw = value.trim()
  if (!isAbsolute(raw)) {
    return {
      ok: false,
      code: 'root_not_absolute',
      message: `总工作区必须是绝对路径（例如 C:\\work），当前「${raw}」不是绝对路径。`,
    }
  }
  try {
    if (!statSync(raw).isDirectory()) {
      return {
        ok: false,
        code: 'root_not_found',
        message: `「${raw}」不是文件夹，请选择一个已存在的目录；插件不会自动创建该路径。`,
      }
    }
  } catch {
    return {
      ok: false,
      code: 'root_not_found',
      message: `目录不存在：「${raw}」。请先手动创建目录再设为总工作区；插件不会自动创建该路径。`,
    }
  }
  for (const project of registeredProjectDirs(currentRoot)) {
    if (!isSameOrInsidePath(raw, project.path)) continue
    const label = project.name && project.name !== project.id ? `${project.id}（${project.name}）` : project.id
    return {
      ok: false,
      code: 'root_inside_project',
      message: `总工作区不能是已注册项目目录「${label}」或其子目录（${project.path}），请选择项目之外的独立目录。`,
    }
  }
  return { ok: true, root: resolve(raw) }
}

/** Persist the effective 「总工作区」 as JSON. Only called after full validation. */
function persistSettings(settingsFile, root) {
  ensureDir(dirname(settingsFile))
  writeFileSync(settingsFile, JSON.stringify({ globalWorkspaceRoot: root }, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Session-log text extraction (ingest modal / changed-file counts)
// ---------------------------------------------------------------------------

/** Deep text extraction from the many message shapes the session log carries. */
function messageText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join('')
  if (typeof value.text === 'string') return value.text
  if (value.content !== undefined) return messageText(value.content)
  if (value.message !== undefined) return messageText(value.message)
  return ''
}

/** Extract the plausible file paths of one file-mutating `tool/call` event. */
function toolCallPaths(event) {
  const data = event && event.data
  if (!data || typeof data.name !== 'string') return []
  const name = data.name.toLowerCase()
  // Only MUTATING file tools count as “changed files”; `read_file`/`list_files`
  // must not inflate the number.
  if (!/(write|edit|replace|patch|create|save|move|rename|delete|notebook)/.test(name)) return []
  let args = data.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = null
    }
  }
  if (!args || typeof args !== 'object') return []
  const out = []
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'file', 'target', 'target_path']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) out.push(value.trim())
  }
  return out
}

/** Fold one session inspection into the facts the ingest UI needs. */
function summarizeInspection(inspection) {
  const events = inspection && Array.isArray(inspection.events) ? inspection.events : []
  const paths = new Set()
  const userTexts = []
  let title = ''
  let lastAssistantText = ''
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'session/title') {
      if (event.data && typeof event.data.title === 'string') title = event.data.title
    } else if (event.type === 'tool/call') {
      for (const path of toolCallPaths(event)) paths.add(path)
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data && event.data.message)
      if (text) lastAssistantText = text
    } else if (event.type === 'user/message') {
      const text = messageText(event.data && event.data.message)
      if (text) userTexts.push(text)
    }
  }
  return {
    title,
    cwd: inspection && inspection.meta ? inspection.meta.cwd : '',
    changedFiles: paths.size,
    files: [...paths].slice(0, 40),
    lastAssistantText,
    userTexts,
  }
}

/** Best-effort changed-file count for a Session (cold or live); null = unknown. */
async function countChangedFiles(inspect, sessionId) {
  if (typeof inspect !== 'function') return null
  const inspection = await inspect(sessionId, 1200)
  if (!inspection) return null
  return summarizeInspection(inspection).changedFiles
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const log = (level, message) => {
    try {
      const logger = ctx && ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-project-hub] ${message}`)
      else if (level === 'warn' || level === 'error') console[level](`[dsh-project-hub] ${message}`)
    } catch {
      /* logging must never break the host */
    }
  }

  const configuredRoot = (config && config.globalWorkspaceRoot) || DEFAULT_GLOBAL_ROOT
  const settingsFile = settingsFileOf(config)
  // Mutable on purpose: a successful POST /project-hub/settings hot-switches
  // every route below, which all read this binding at request time.
  let globalRoot = resolveInitialRoot(configuredRoot, settingsFile, log)

  ensureDir(globalRoot)
  ensureDir(join(globalRoot, '.dsh-hub'))

  initProjectRegistry(globalRoot)

  // Opportunistic service lookup.
  function service(identifier) {
    try {
      if (ctx && typeof ctx.get === 'function') {
        const found = ctx.get(identifier)
        if (found !== undefined) return found
      }
      if (ctx && ctx[identifier] !== undefined) return ctx[identifier]
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the launcher's Agent-mode catalog for GET /project-hub/state.
   *
   * With an Agent-preset roster composed, a mode is selectable only while its
   * preset resolves and its composition is healthy. Without a roster (a
   * non-Web composition) 「标准模式」 stays selectable and launches the default
   * composition, while 「Computer Use 模式」 is hidden because no such preset
   * exists there.
   */
  async function listAgentModes() {
    const presets = service('agentPresets')
    const roster = Boolean(presets && typeof presets.resolve === 'function')
    const rows = []
    for (const row of AGENT_MODE_ROWS) {
      let available = false
      let presetId = null
      if (roster) {
        try {
          const resolved = await presets.resolve(row.id)
          if (row.id === AGENT_MODE_STANDARD) {
            // 「标准模式」 is the launcher's baseline: when the shipped
            // `standard` definition is missing or unhealthy, omit the preset
            // and let the roster default run instead of blocking every launch.
            available = true
            presetId = resolved && resolved.broken === undefined ? row.id : null
          } else {
            available = Boolean(resolved) && resolved.broken === undefined
            if (available) presetId = row.id
          }
        } catch {
          // An unknown standard id still launches on the roster default;
          // every other mode IS its preset, so it cannot be offered.
          available = row.id === AGENT_MODE_STANDARD
        }
      } else if (row.id === AGENT_MODE_STANDARD) {
        available = true
      }
      rows.push({ id: row.id, name: row.name, description: row.description, available, presetId })
    }
    return rows
  }

  /** Validate the requested launcher mode against the current catalog. */
  async function resolveLaunchMode(rawMode) {
    const requested =
      typeof rawMode === 'string' && rawMode.trim() ? rawMode.trim() : AGENT_MODE_STANDARD
    const modes = await listAgentModes()
    const selected = modes.find((row) => row.id === requested)
    if (!selected) {
      return {
        ok: false,
        status: 400,
        code: 'agent_mode_unknown',
        message: `未知的会话模式：${requested}（可选：${modes.map((row) => row.id).join(', ')}）。`,
      }
    }
    if (!selected.available) {
      return {
        ok: false,
        status: 400,
        code: 'agent_mode_unavailable',
        message: `会话模式不可用：${selected.name}（当前组合缺少可用的 Agent preset）。`,
      }
    }
    return { ok: true, mode: selected }
  }

  /**
   * Pin FULL_ACCESS_PRESET on a freshly created Session, BEFORE the queued
   * prompt can run a turn, so a task started from the hub never needs the user
   * to switch permissions by hand. Best effort: the profile's permission
   * default already covers new Sessions, and a missing permission service or a
   * not-yet-live Session must not block the launch.
   */
  async function pinFullAccess(sessionId) {
    const presets = service('permissionPresets')
    if (!presets || typeof presets.set !== 'function') return null
    const sessions = service('sessions')
    const session =
      sessions && typeof sessions.get === 'function' ? sessions.get(String(sessionId)) : undefined
    if (!session) return null
    try {
      presets.set(session, FULL_ACCESS_PRESET)
      return FULL_ACCESS_PRESET
    } catch (error) {
      log(
        'warn',
        `could not pin ${FULL_ACCESS_PRESET} on ${sessionId}: ${error && error.message ? error.message : String(error)}`,
      )
      return null
    }
  }

  async function inspectSession(sessionId, timeoutMs = 4000) {
    const controller = service('sessionController')
    if (!controller || typeof controller.inspect !== 'function') return null
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(Math.max(500, timeoutMs))
        : undefined
      return await controller.inspect(String(sessionId), signal)
    } catch {
      return null
    }
  }

  /** Read the Host's session summaries (titles come from the `title` projection). */
  async function listSessionSummaries() {
    const controller = service('sessionController')
    if (!controller || typeof controller.list !== 'function') return []
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(6000)
        : undefined
      const value = await controller.list({}, signal)
      return value && Array.isArray(value.items) ? value.items : []
    } catch {
      return []
    }
  }

  function sessionTitleOf(item) {
    try {
      const values = item && item.projections && item.projections.values
      const title = values && values.title
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch {
      /* fall through */
    }
    return ''
  }

  /** Historical sessions for the ingest modal (sessions + legacy handoff files). */
  async function collectRecentSessions() {
    const rows = []
    const seen = new Set()

    for (const item of await listSessionSummaries()) {
      if (!item || !item.sessionId) continue
      if (item.parentSessionId || item.origin === 'subagent') continue
      if (item.blank) continue
      const sessionId = String(item.sessionId)
      seen.add(sessionId)
      rows.push({
        sessionId,
        title: sessionTitleOf(item),
        updatedAt: Number(item.updatedAt) || 0,
        cwd: typeof item.cwd === 'string' ? item.cwd : '',
        changedFiles: null,
        source: 'session',
      })
    }

    // Legacy handoff documents written by the retired dsh-auto-handoff plugin.
    try {
      const handoffDir = join(globalRoot, '.dsh-handoff')
      if (existsSync(handoffDir)) {
        const files = readdirSync(handoffDir).filter((file) => file.startsWith('HANDOFF-') && file.endsWith('.md'))
        for (const file of files) {
          const id = file.replace(/\.md$/, '')
          if (seen.has(id)) continue
          seen.add(id)
          const fullPath = join(handoffDir, file)
          let title = id
          let cwd = globalRoot
          let updatedAt = 0
          try {
            updatedAt = statSync(fullPath).mtimeMs
            const raw = readFileSync(fullPath, 'utf8')
            const titleMatch = /^#\s+(.+)$/m.exec(raw)
            if (titleMatch) title = titleMatch[1].trim()
            const wsMatch = /工作区[：:]\s*`?([^`\r\n]+)`?/i.exec(raw)
            if (wsMatch) cwd = wsMatch[1].trim()
          } catch {
            /* keep defaults */
          }
          rows.push({ sessionId: id, title, updatedAt, cwd, changedFiles: null, source: 'handoff' })
        }
      }
    } catch {
      /* handoff scan is optional */
    }

    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    const limited = rows.slice(0, SESSION_SCAN_LIMIT)

    // Best-effort changed-file counts, bounded in time: inspecting a cold
    // Session decompresses its log, so stop once the modal budget is used and
    // leave the rest as `null` (rendered as “—”) instead of inventing a 0.
    const startedAt = Date.now()
    for (const row of limited.slice(0, CHANGE_SCAN_LIMIT)) {
      if (Date.now() - startedAt > CHANGE_SCAN_BUDGET_MS) break
      row.changedFiles = await countChangedFiles(inspectSession, row.sessionId)
    }
    return limited.map((row) => ({ ...row, title: row.title || row.sessionId }))
  }

  /**
   * Register or reuse the DSH workspace that owns `targetCwd`, so the new
   * Session appears under that Project workspace instead of 「未分组」.
   */
  async function ensureWorkspace(targetCwd, title) {
    const registry = service('workspaceRegistry')
    if (registry && typeof registry.create === 'function') {
      try {
        const workspace = await registry.create(targetCwd, title)
        if (workspace && workspace.id !== undefined) return String(workspace.id)
      } catch (error) {
        log('warn', `workspace registration failed for ${targetCwd}: ${error && error.message ? error.message : String(error)}`)
      }
    }
    return null
  }

  /** Create the new Session (top-level, fully owned by the user). */
  async function launchSession(controller, { targetCwd, title, prompt, agentPreset }) {
    const workspaceId = await ensureWorkspace(targetCwd, title)
    const placement = workspaceId ? { workspaceId } : { cwd: targetCwd }
    if (agentPreset) placement.agentPreset = agentPreset
    const created = await controller.create(placement)
    const sessionId = created && (created.sessionId || created.id)
    if (!sessionId) throw new Error('sessionController.create returned no session id')

    if (typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId: String(sessionId), title })
      } catch {
        /* a title race is never fatal */
      }
    }

    // Full access goes on the Session before the prompt is queued, so the first
    // turn already runs with danger-full-access + approval never.
    const permissionPreset = await pinFullAccess(String(sessionId))

    let accepted = true
    if (typeof controller.prompt === 'function') {
      const requestId = `dsh-project-hub-${randomUUID()}`
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(20000)
        : undefined
      const receipt = await controller.prompt(
        {
          requestId,
          sessionId: String(sessionId),
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
        signal,
      )
      accepted = !(receipt && receipt.accepted === false)
    }
    return {
      sessionId: String(sessionId),
      workspaceId,
      accepted,
      agentPreset: created && created.agentPreset ? created.agentPreset : agentPreset || null,
      permissionPreset,
    }
  }

  // -------------------------------------------------------------------------
  // Agent tool: record_module_done (deterministic, zero-waste delivery)
  // -------------------------------------------------------------------------
  try {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => {
        const dispose = registerModuleDoneTool(toolCtx, () => globalRoot)
        return () => {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* ignore */
          }
        }
      }, 'dsh-project-hub: record_module_done tool')
    })
  } catch (error) {
    log('warn', `tools service unavailable: ${error && error.message ? error.message : String(error)}`)
  }

  // -------------------------------------------------------------------------
  // WebServer routes for the client UI
  // -------------------------------------------------------------------------
  try {
    ctx.inject(['webServer'], (hostCtx) => {
      hostCtx.effect(() => {
        const unsubs = []
        const webServer = hostCtx.webServer

        // 1. GET /project-hub/state -> project tree + two-tier tag docs + agent modes
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/state',
            handler: route(async (req, res) => {
              const projects = listProjectsWithDocs(globalRoot)
              const agentModes = await listAgentModes()
              sendJson(req, res, 200, {
                ok: true,
                version,
                globalWorkspaceRoot: globalRoot,
                agentModes,
                projects,
              })
            }),
          }),
        )

        // 2. GET /project-hub/sessions -> historical sessions for the ingest modal
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/sessions',
            handler: route(async (req, res) => {
              const sessions = await collectRecentSessions()
              sendJson(req, res, 200, { ok: true, sessions })
            }),
          }),
        )

        // 3. POST /project-hub/create-project
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/create-project',
            handler: route(async (req, res) => {
              const body = await readJsonBody(req)
              try {
                const created = createProject(globalRoot, {
                  id: body.id,
                  name: body.name,
                  defaultTags: body.defaultTags,
                })
                sendJson(req, res, 200, { ok: true, project: created })
              } catch (error) {
                sendJson(req, res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
              }
            }),
          }),
        )

        // 4. POST /project-hub/launch-session (project task / scratchpad)
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/launch-session',
            handler: route(async (req, res) => {
              const body = await readJsonBody(req)
              const controller = service('sessionController')
              if (!controller || typeof controller.create !== 'function') {
                sendJson(req, res, 503, { ok: false, error: 'sessionController unavailable' })
                return
              }

              try {
                // 「标准模式」 / 「Computer Use 模式」: both pin FULL_ACCESS_PRESET.
                const modeResolution = await resolveLaunchMode(body.mode)
                if (!modeResolution.ok) {
                  sendJson(req, res, modeResolution.status, {
                    ok: false,
                    code: modeResolution.code,
                    message: modeResolution.message,
                  })
                  return
                }
                const mode = modeResolution.mode

                let targetCwd
                let sessionTitle
                let prompt

                if (body.isScratchpad) {
                  // 其他 / 杂务: clean scratchpad session, zero project context.
                  targetCwd = join(globalRoot, '_scratchpad')
                  ensureDir(targetCwd)
                  sessionTitle = '其他 (杂务与临时排错)'
                  prompt = [
                    `临时杂务会话。物理工作目录：\`${targetCwd}\`（与正式项目知识库隔离）。`,
                    `启动模式：${mode.name}（完全权限：文件策略 ${FULL_ACCESS_PRESET}，审批策略 never）。`,
                    '本次会话不绑定任何项目标签，不加载任何项目档案。',
                    '',
                    '背景已注入完毕，不要复述，不要调用任何工具，不要开始任何工作。',
                    '请只输出下面这一行纯文本（不要给任何选项按钮）：',
                    SCRATCHPAD_STANDBY,
                  ].join('\n')
                } else {
                  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
                  if (!projectId) {
                    sendJson(req, res, 400, { ok: false, error: 'projectId required' })
                    return
                  }
                  const selectedTags = Array.isArray(body.selectedSmallTags)
                    ? body.selectedSmallTags.map((tag) => String(tag)).filter(Boolean)
                    : []
                  const subWs = computeSubWorkspace(globalRoot, projectId, selectedTags)
                  targetCwd = subWs.cwd

                  const docs = readTagDocs(globalRoot, projectId, selectedTags)
                  const docSummaries = docs
                    .map(
                      (doc, index) =>
                        `${index + 1}. [${doc.bigTag}] ${doc.smallTag}\n   - 物理工作区：${doc.workspacePath}\n   - 文档路径：${doc.file}`,
                    )
                    .join('\n')

                  sessionTitle = `${body.projectName || projectId} · ${selectedTags.slice(0, 2).join(' / ') || '任务'}`

                  prompt = [
                    '### 已加载模块背景现状汇报',
                    docSummaries
                      ? `已精准载入 ${docs.length} 份小标签背景档案：\n${docSummaries}`
                      : '未关联已有标签，新模块开发任务初始化。',
                    '',
                    `当前独立子工作区已就绪：\`${targetCwd}\`（模式：${subWs.desc}）`,
                    `启动模式：${mode.name}（完全权限：文件策略 ${FULL_ACCESS_PRESET}，审批策略 never，不会弹出审批提示）。`,
                    '所有后续文件产出与命令执行将物理隔离在该子工作区内。',
                    '',
                    '背景已注入完毕，无需复述。不要调用任何工具，不要开始任何工作，不要在末尾给选项按钮。',
                    '请只输出下面这一行纯文本：',
                    PROJECT_STANDBY,
                  ].join('\n')
                }

                const launched = await launchSession(controller, {
                  targetCwd,
                  title: sessionTitle,
                  prompt,
                  agentPreset: mode.presetId || undefined,
                })
                sendJson(req, res, 200, {
                  ok: true,
                  sessionId: launched.sessionId,
                  cwd: targetCwd,
                  workspaceId: launched.workspaceId,
                  mode: mode.id,
                  modeName: mode.name,
                  agentPreset: launched.agentPreset,
                  permissionPreset: launched.permissionPreset,
                  promptAccepted: launched.accepted,
                })
              } catch (error) {
                sendJson(req, res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
              }
            }),
          }),
        )

        // 5. POST /project-hub/ingest-history -> high-fidelity MD with workspace_path
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/ingest-history',
            handler: route(async (req, res) => {
              const body = await readJsonBody(req)
              try {
                const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
                const bigTag = typeof body.bigTag === 'string' ? body.bigTag.trim() : ''
                const smallTag = typeof body.smallTag === 'string' ? body.smallTag.trim() : ''
                if (!projectId || !bigTag || !smallTag) {
                  sendJson(req, res, 400, { ok: false, error: 'projectId, bigTag and smallTag are required' })
                  return
                }
                const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [body.sessionIds]
                const sessionIds = rawIds.map((id) => String(id || '').trim()).filter(Boolean)
                if (sessionIds.length === 0) {
                  sendJson(req, res, 400, { ok: false, error: 'sessionIds required' })
                  return
                }

                const written = []
                for (const sessionId of sessionIds) {
                  const inspection = await inspectSession(sessionId, 20000)
                  const summary = summarizeInspection(inspection)
                  let workspacePath =
                    summary.cwd ||
                    (typeof body.workspacePath === 'string' ? body.workspacePath.trim() : '') ||
                    globalRoot

                  // Legacy handoff document content, when the id names one.
                  let fallbackDetails = ''
                  try {
                    const handoffFile = join(globalRoot, '.dsh-handoff', `${sessionId}.md`)
                    if (existsSync(handoffFile)) fallbackDetails = readFileSync(handoffFile, 'utf8')
                  } catch {
                    /* optional */
                  }

                  const userTexts = summary.userTexts
                  const userBlock = userTexts.length > 0
                    ? userTexts
                        .slice(-4)
                        .map((text, index) => `${index + 1}. ${String(text).slice(0, 600)}`)
                        .join('\n')
                    : '（会话日志中未读取到用户消息）'
                  const assistantBlock = summary.lastAssistantText
                    ? String(summary.lastAssistantText).slice(0, 6000)
                    : fallbackDetails || '（会话日志中未读取到助手交付内容）'
                  const deliverables = summary.files.slice(0, 40)

                  const result = writeTagDoc(globalRoot, {
                    projectId,
                    bigTag,
                    smallTag,
                    workspacePath,
                    sessionId,
                    summary: `由历史会话 ${sessionId} 手动归纳入库。原始物理工作区：${workspacePath}`,
                    details: [
                      `原始会话：${sessionId}`,
                      `标题：${summary.title || sessionId}`,
                      '',
                      '#### 用户诉求（最近消息）',
                      userBlock,
                      '',
                      '#### 最终交付内容（助手最后一条消息）',
                      assistantBlock,
                      '',
                      '#### 涉及文件',
                      deliverables.length > 0 ? deliverables.map((file) => `- \`${file}\``).join('\n') : '- 暂无文件记录',
                    ].join('\n'),
                    deliverables,
                  })
                  written.push({ sessionId, file: result.filePath, workspacePath })
                }

                sendJson(req, res, 200, { ok: true, count: written.length, written })
              } catch (error) {
                sendJson(req, res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
              }
            }),
          }),
        )

        // 6. POST /project-hub/remove-project -> UNREGISTER ONLY (移出列表).
        //    Never touches C:\work\<projectId> or its .dsh-hub/docs/** markdown:
        //    the project can be registered again later and its knowledge base
        //    must survive an “unregister” intact.
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/remove-project',
            handler: route(async (req, res) => {
              const body = await readJsonBody(req)
              const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
              if (!projectId) {
                sendJson(req, res, 400, {
                  ok: false,
                  code: 'project_id_required',
                  error: 'projectId required',
                })
                return
              }
              try {
                const result = removeProjectFromRegistry(globalRoot, projectId)
                if (!result.removed) {
                  // Not an HTTP 500: nothing failed, the entry is simply not in
                  // the registry (already removed / never registered).
                  sendJson(req, res, 404, {
                    ok: false,
                    code: 'project_not_found',
                    error: 'project not found in registry',
                    projectId,
                  })
                  return
                }
                sendJson(req, res, 200, {
                  ok: true,
                  removed: true,
                  projectId: result.projectId,
                  scope: 'registry-only',
                  note: 'project files and .dsh-hub docs are untouched',
                })
              } catch (error) {
                sendJson(req, res, 500, {
                  ok: false,
                  code: 'remove_failed',
                  error: error && error.message ? error.message : String(error),
                })
              }
            }),
          }),
        )

        // 7. /project-hub/settings -> READ + WRITE the 「总工作区」.
        //    GET  -> current effective root.
        //    POST -> validate, persist, then hot-switch every route.
        //
        //    One exact route on purpose: the Host webServer dispatches by RAW
        //    path only (that is why route() answers OPTIONS itself), so the
        //    GET/POST split happens here on `req.method`.
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/settings',
            handler: route(async (req, res) => {
              const method = String((req && req.method) || 'GET').toUpperCase()

              if (method === 'GET') {
                sendJson(req, res, 200, { ok: true, globalWorkspaceRoot: globalRoot })
                return
              }

              if (method !== 'POST') {
                sendJson(req, res, 405, {
                  ok: false,
                  code: 'method_not_allowed',
                  message: '该接口仅支持 GET / POST。',
                })
                return
              }

              const body = await readJsonBody(req)
              const verdict = validateGlobalRootInput(body.globalWorkspaceRoot, globalRoot)
              if (!verdict.ok) {
                // Client error: no state mutation, no file write, no directory
                // creation. The 400 body carries a clear Chinese message.
                sendJson(req, res, 400, { ok: false, code: verdict.code, message: verdict.message })
                return
              }

              const nextRoot = verdict.root
              try {
                // On success the new root gets an EMPTY registry only when it
                // has none: never seed the demo projects, never create project
                // folders, and leave an existing projects.json untouched.
                const nextRegistry = join(nextRoot, '.dsh-hub', 'projects.json')
                if (!existsSync(nextRegistry)) {
                  ensureDir(join(nextRoot, '.dsh-hub'))
                  writeFileSync(nextRegistry, '[]', 'utf8')
                }
                persistSettings(settingsFile, nextRoot)
              } catch (error) {
                // A request-triggered persistence/registry write failure (e.g. an
                // unwritable target) is still answered as a clean JSON 4xx — the
                // settings endpoint never turns a user-supplied path into a 500.
                sendJson(req, res, 400, {
                  ok: false,
                  code: 'settings_write_failed',
                  message: `无法保存总工作区设置（目录不可写或无权限）：${error && error.message ? error.message : String(error)}`,
                })
                return
              }

              // Hot-switch: the old root is left byte-identical (nothing is
              // deleted / moved / renamed / copied); only this binding changes,
              // and every route reads it at request time.
              globalRoot = nextRoot
              log('info', `global workspace root switched to ${nextRoot} (persisted in ${settingsFile})`)
              sendJson(req, res, 200, { ok: true, globalWorkspaceRoot: globalRoot })
            }),
          }),
        )

        // 8. POST /project-hub/create-doc -> 自助新建小标签档案（五节模板）.
        //    Body: { projectId | projectPath, bigTag, smallTag, title? }.
        //    Validation + duplicate checks answer the existing JSON 4xx style;
        //    success returns the ABSOLUTE file path and the refreshed MD list of
        //    that 大标签, so the 「启动会话」 modal can re-render immediately.
        unsubs.push(
          webServer.register({
            kind: 'exact',
            path: '/project-hub/create-doc',
            handler: route(async (req, res) => {
              const body = await readJsonBody(req)
              const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
              const rawProjectPath = typeof body.projectPath === 'string' ? body.projectPath.trim() : ''
              if (!projectId && !rawProjectPath) {
                sendJson(req, res, 400, {
                  ok: false,
                  code: 'project_required',
                  error: 'projectId 或 projectPath 必填。',
                })
                return
              }

              const bigVerdict = validateTagName(body.bigTag, '大标签')
              if (!bigVerdict.ok) {
                sendJson(req, res, 400, { ok: false, code: bigVerdict.code, error: bigVerdict.message })
                return
              }
              const smallVerdict = validateTagName(body.smallTag, '小标签')
              if (!smallVerdict.ok) {
                sendJson(req, res, 400, { ok: false, code: smallVerdict.code, error: smallVerdict.message })
                return
              }
              const bigTag = bigVerdict.value
              const smallTag = smallVerdict.value

              // Registry first (projectId is the normal path); an explicit
              // projectPath must still be an existing absolute directory.
              const registry = initProjectRegistry(globalRoot)
              const wantedPath = rawProjectPath.toLowerCase()
              const registered = registry.find(
                (item) =>
                  item &&
                  (item.id === projectId ||
                    (wantedPath && typeof item.path === 'string' && item.path.toLowerCase() === wantedPath)),
              )
              let projectDir = registered && registered.path
                ? registered.path
                : join(globalRoot, projectId || basename(rawProjectPath))
              if (rawProjectPath) {
                if (!isAbsolute(rawProjectPath)) {
                  sendJson(req, res, 400, {
                    ok: false,
                    code: 'project_path_not_absolute',
                    error: `projectPath 必须是绝对路径：「${rawProjectPath}」。`,
                  })
                  return
                }
                try {
                  if (!statSync(rawProjectPath).isDirectory()) throw new Error('not a directory')
                } catch {
                  sendJson(req, res, 400, {
                    ok: false,
                    code: 'project_not_found',
                    error: `项目目录不存在：「${rawProjectPath}」。`,
                  })
                  return
                }
                projectDir = resolve(rawProjectPath)
              }
              const resolvedProjectId =
                projectId || (registered && registered.id ? String(registered.id) : basename(projectDir))

              // Case-insensitive duplicate guard: Windows treats a.md / A.md as
              // the same file, so a name that only differs in case is rejected
              // as 已存在 instead of silently aliasing the existing archive.
              const targetDir = join(projectDir, '.dsh-hub', 'docs', bigTag)
              const wantedFile = `${smallTag}.md`.toLowerCase()
              let duplicate = ''
              try {
                duplicate = existsSync(targetDir)
                  ? readdirSync(targetDir).find((name) => name.toLowerCase() === wantedFile) || ''
                  : ''
              } catch {
                duplicate = ''
              }
              if (duplicate) {
                sendJson(req, res, 409, {
                  ok: false,
                  code: 'doc_exists',
                  error: `已存在同名小标签档案：「${duplicate}」（大小写不同也视为同名）。`,
                })
                return
              }

              try {
                const created = writeTagDoc(globalRoot, {
                  projectId: resolvedProjectId,
                  projectPath: projectDir,
                  bigTag,
                  smallTag,
                  title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '',
                  workspacePath:
                    typeof body.workspacePath === 'string' && body.workspacePath.trim()
                      ? body.workspacePath.trim()
                      : projectDir,
                  sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : '',
                  mode: 'create',
                })
                sendJson(req, res, 200, {
                  ok: true,
                  filePath: created.filePath,
                  projectId: resolvedProjectId,
                  bigTag,
                  smallTag,
                  docs: listBigTagDocs(projectDir, bigTag),
                })
              } catch (error) {
                const exists = Boolean(error && error.code === 'doc_exists')
                sendJson(req, res, exists ? 409 : 400, {
                  ok: false,
                  code: exists ? 'doc_exists' : 'create_doc_failed',
                  error: error && error.message ? error.message : String(error),
                })
              }
            }),
          }),
        )

        log('info', `routes registered: /project-hub/{state,sessions,create-project,create-doc,launch-session,ingest-history,remove-project,settings} @ ${globalRoot}`)

        return () => {
          for (const dispose of unsubs) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* ignore */
            }
          }
        }
      }, 'dsh-project-hub: host routes')
    })
  } catch (error) {
    log('error', `webServer service unavailable: ${error && error.message ? error.message : String(error)}`)
  }
}
