import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

// Keep all test data inside the plugin workspace; never touch C:\work user data.
const BASE = fileURLToPath(new URL('./.tmp-settings-host', import.meta.url))
const OLD_ROOT = join(BASE, 'old-root')
const NEW_ROOT = join(BASE, 'new-root')
const SETTINGS_FILE = join(BASE, 'settings.json')

const EFFECTIVE_OLD = resolve(OLD_ROOT)
const EFFECTIVE_NEW = resolve(NEW_ROOT)
// The real plugin-level settings file must stay untouched by this suite.
const REAL_SETTINGS_FILE = fileURLToPath(new URL('../config.json', import.meta.url))

// ---------------------------------------------------------------------------
// Raw node:http mocks — webServer.register hands out (req, res), NOT Fetch.
// Same harness style as test/integration.mjs.
// ---------------------------------------------------------------------------

function makeRequest(method, url, body, extraHeaders) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: { origin: 'dsh-app://app', ...(extraHeaders || {}) },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk)
      this.headersSent = true
      this.writableEnded = true
    },
  }
}

/** Fresh mock Host context: its own route/tool registries and spies. */
function makeHost() {
  const routes = new Map()
  const registrations = []
  const tools = new Map()
  const createdSessions = []
  const promptedTurns = []
  const createdWorkspaces = []
  const warns = []
  let sessionSeq = 0

  const webServer = {
    register({ kind, path, handler }) {
      registrations.push({ kind, path })
      routes.set(path, { kind, handler })
      return () => routes.delete(path)
    },
  }

  const sessionController = {
    async create(request) {
      const sessionId = `s-settings-${++sessionSeq}`
      createdSessions.push({ sessionId, ...request })
      return { sessionId }
    },
    async rename(request) {
      return { title: request.title, seq: 1 }
    },
    async prompt(request) {
      promptedTurns.push(request)
      return { accepted: true }
    },
    async list() {
      return { items: [] }
    },
    async inspect() {
      return undefined
    },
  }

  const workspaceRegistry = {
    async create(path, title) {
      createdWorkspaces.push({ path, title })
      return { id: `ws-${createdWorkspaces.length}`, cwd: path, title }
    },
    list() {
      return []
    },
  }

  const toolsService = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  }

  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warns.push(String(message))
      },
      error() {},
    },
    get(identifier) {
      if (identifier === 'sessionController') return sessionController
      if (identifier === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    inject(_deps, callback) {
      callback({
        webServer,
        tools: toolsService,
        effect(fn) {
          return fn()
        },
      })
    },
  }

  return { ctx, routes, registrations, tools, createdSessions, promptedTurns, warns }
}

function makeInvoker(routes) {
  return async (path, { method = 'GET', body, headers } = {}) => {
    const entry = routes.get(path)
    assert.ok(entry, `route ${path} must be registered`)
    const req = makeRequest(method, path, body, headers)
    const res = makeResponse()
    await entry.handler(req, res)
    let json = null
    try {
      json = JSON.parse(res.body)
    } catch {
      json = null
    }
    return { status: res.statusCode, headers: res.headers, body: res.body, json }
  }
}

test('DSH Project Hub — 「总工作区」 settings (host routes)', async (t) => {
  if (existsSync(BASE)) rmSync(BASE, { recursive: true, force: true })
  mkdirSync(OLD_ROOT, { recursive: true })
  mkdirSync(NEW_ROOT, { recursive: true })
  // Legacy handoff docs prove the sessions scan follows the runtime root.
  mkdirSync(join(OLD_ROOT, '.dsh-handoff'), { recursive: true })
  writeFileSync(join(OLD_ROOT, '.dsh-handoff', 'HANDOFF-old.md'), '# 旧根交接\n', 'utf8')
  mkdirSync(join(NEW_ROOT, '.dsh-handoff'), { recursive: true })
  writeFileSync(join(NEW_ROOT, '.dsh-handoff', 'HANDOFF-new.md'), '# 新根交接\n', 'utf8')

  const host = makeHost()
  apply(host.ctx, { globalWorkspaceRoot: OLD_ROOT, settingsFile: SETTINGS_FILE })
  const invoke = makeInvoker(host.routes)
  const realSettingsBefore = existsSync(REAL_SETTINGS_FILE) ? readFileSync(REAL_SETTINGS_FILE) : null

  const oldRegistryFile = join(OLD_ROOT, '.dsh-hub', 'projects.json')
  let oldRegistryBytes = null
  let seededProject = null

  try {
    assert.equal(existsSync(SETTINGS_FILE), false, 'settings file is never created just by loading')

    await t.test('registers /project-hub/settings as exact and reports the configured root', async () => {
      const entry = host.routes.get('/project-hub/settings')
      assert.ok(entry, 'settings route registered')
      assert.equal(entry.kind, 'exact')
      const settingsRegistrations = host.registrations.filter((row) => row.path === '/project-hub/settings')
      assert.equal(settingsRegistrations.length, 1, 'one exact route serves both GET and POST')

      const res = await invoke('/project-hub/settings')
      assert.equal(res.status, 200)
      assert.match(res.headers['Content-Type'], /application\/json/)
      assert.equal(res.headers['Access-Control-Allow-Origin'], 'dsh-app://app')
      assert.deepEqual(res.json, { ok: true, globalWorkspaceRoot: EFFECTIVE_OLD })

      // Any other method is a clean 405 JSON, never a hung socket.
      const put = await invoke('/project-hub/settings', { method: 'PUT', body: {} })
      assert.equal(put.status, 405)
      assert.equal(put.json.ok, false)
      assert.equal(put.json.code, 'method_not_allowed')
      assert.equal(put.headers['Access-Control-Allow-Origin'], 'dsh-app://app')
    })

    await t.test('answers OPTIONS preflight with CORS + Private Network Access headers', async () => {
      const res = await invoke('/project-hub/settings', {
        method: 'OPTIONS',
        headers: {
          origin: 'dsh-app://app',
          'access-control-request-method': 'POST',
          'access-control-request-private-network': 'true',
        },
      })
      assert.equal(res.status, 204)
      assert.equal(res.headers['Access-Control-Allow-Origin'], 'dsh-app://app')
      assert.equal(res.headers['Access-Control-Allow-Private-Network'], 'true')
      assert.match(res.headers['Access-Control-Allow-Methods'], /GET/)
      assert.match(res.headers['Access-Control-Allow-Methods'], /POST/)
    })

    await t.test('seeds the configured root registry and lists its projects in state', async () => {
      const res = await invoke('/project-hub/state')
      assert.equal(res.status, 200)
      assert.equal(res.json.globalWorkspaceRoot, EFFECTIVE_OLD)
      assert.ok(Array.isArray(res.json.projects) && res.json.projects.length >= 3)
      oldRegistryBytes = readFileSync(oldRegistryFile)
      seededProject = res.json.projects[0]
      assert.ok(seededProject && seededProject.id, 'a seeded project exists for validation checks')
      assert.ok(existsSync(join(OLD_ROOT, seededProject.id)), 'state listing materializes the project dir')
    })

    await t.test('sessions handoff scan follows the configured root before the switch', async () => {
      const res = await invoke('/project-hub/sessions')
      assert.equal(res.status, 200)
      const ids = res.json.sessions.map((row) => row.sessionId)
      assert.ok(ids.includes('HANDOFF-old'), 'old-root handoff listed before the switch')
      assert.equal(ids.includes('HANDOFF-new'), false, 'new-root handoff not scanned before the switch')
      const row = res.json.sessions.find((item) => item.sessionId === 'HANDOFF-old')
      assert.equal(row.cwd, EFFECTIVE_OLD)
    })

    await t.test('rejects invalid roots with 400 {ok:false,code,message}, mutating nothing', async () => {
      const projectDir = join(OLD_ROOT, seededProject.id)
      assert.ok(existsSync(projectDir), 'registered project dir exists')
      const nestedDir = join(projectDir, 'nested-workspace')
      mkdirSync(nestedDir, { recursive: true })
      const fileNotDir = join(BASE, 'plain-file.txt')
      writeFileSync(fileNotDir, 'not a directory', 'utf8')
      const missingRoot = join(BASE, 'must-not-be-auto-created')

      const cases = [
        ['missing', {}, 'root_required'],
        ['blank', { globalWorkspaceRoot: '   ' }, 'root_required'],
        ['non-string', { globalWorkspaceRoot: 42 }, 'root_required'],
        ['relative', { globalWorkspaceRoot: 'work\\x' }, 'root_not_absolute'],
        ['nonexistent', { globalWorkspaceRoot: missingRoot }, 'root_not_found'],
        ['file-not-dir', { globalWorkspaceRoot: fileNotDir }, 'root_not_found'],
        ['registered-project-dir', { globalWorkspaceRoot: projectDir }, 'root_inside_project'],
        ['registered-project-uppercase', { globalWorkspaceRoot: projectDir.toUpperCase() }, 'root_inside_project'],
        ['nested-inside-project', { globalWorkspaceRoot: nestedDir }, 'root_inside_project'],
        ['nested-trailing-separator', { globalWorkspaceRoot: `${nestedDir}\\` }, 'root_inside_project'],
      ]

      const results = new Map()
      for (const [label, body, code] of cases) {
        const res = await invoke('/project-hub/settings', { method: 'POST', body })
        results.set(label, res)
        assert.equal(res.status, 400, `${label}: client error, never 500`)
        assert.equal(res.status !== 500, true, `${label}: definitely not a server error`)
        assert.equal(res.json.ok, false, `${label}: ok=false`)
        assert.equal(res.json.code, code, `${label}: code`)
        assert.equal(typeof res.json.message, 'string', `${label}: message is a string`)
        assert.ok(res.json.message.length > 0, `${label}: non-empty message`)
        assert.match(res.json.message, /[\u4e00-\u9fa5]/, `${label}: clear Chinese message`)
      }

      // root_not_found must explain that the plugin will NOT auto-create it.
      for (const label of ['nonexistent', 'file-not-dir']) {
        assert.match(
          results.get(label).json.message,
          /不会自动创建/,
          `${label}: message says the path will not be auto-created`,
        )
      }
      // root_inside_project must name the offending project id/name.
      for (const label of [
        'registered-project-dir',
        'registered-project-uppercase',
        'nested-inside-project',
        'nested-trailing-separator',
      ]) {
        const message = results.get(label).json.message
        assert.ok(message.includes(seededProject.id), `${label}: message names the project id`)
        assert.ok(message.includes(seededProject.name), `${label}: message names the project name`)
      }

      // No mutation: nothing created, nothing persisted, root unchanged.
      assert.equal(existsSync(missingRoot), false, 'the invalid target directory was NOT auto-created')
      assert.equal(existsSync(fileNotDir), true, 'the plain file is still a plain file')
      assert.equal(existsSync(SETTINGS_FILE), false, 'settings are persisted only on success')
      const settings = await invoke('/project-hub/settings')
      assert.equal(settings.json.globalWorkspaceRoot, EFFECTIVE_OLD, 'runtime root unchanged')
      assert.equal(
        readFileSync(oldRegistryFile).equals(oldRegistryBytes),
        true,
        'old registry bytes untouched',
      )
      assert.ok(existsSync(projectDir), 'old project directory still exists')
      assert.ok(existsSync(nestedDir), 'test-created nested dir still exists')
    })

    await t.test('a persistence/write failure is a clean 4xx JSON, never 500, and keeps the current root', async () => {
      // Settings file whose parent is a FILE: persisting must fail. The route
      // must still answer JSON (no dropped socket, no 500) and keep the root.
      const blockerFile = join(BASE, 'blocked-settings-parent')
      writeFileSync(blockerFile, 'this is a file, not a directory', 'utf8')
      const unwritableSettingsFile = join(blockerFile, 'config.json')

      const writeFailHost = makeHost()
      apply(writeFailHost.ctx, { globalWorkspaceRoot: OLD_ROOT, settingsFile: unwritableSettingsFile })
      const invokeWriteFail = makeInvoker(writeFailHost.routes)

      const before = await invokeWriteFail('/project-hub/settings')
      assert.equal(before.json.globalWorkspaceRoot, EFFECTIVE_OLD)

      const res = await invokeWriteFail('/project-hub/settings', {
        method: 'POST',
        body: { globalWorkspaceRoot: NEW_ROOT },
      })
      assert.notEqual(res.status, 500, 'settings write failures must never be a server error')
      assert.equal(res.status, 400)
      assert.equal(res.json.ok, false)
      assert.equal(res.json.code, 'settings_write_failed')
      assert.equal(typeof res.json.message, 'string')
      assert.ok(res.json.message.length > 0)
      assert.match(res.json.message, /[\u4e00-\u9fa5]/, 'clear Chinese message')

      // No switch and no settings file materialised through the blocker. (The
      // candidate root may have received its empty registry metadata before the
      // JSON write was attempted; that is a non-active root and never user data.)
      const after = await invokeWriteFail('/project-hub/settings')
      assert.equal(after.json.globalWorkspaceRoot, EFFECTIVE_OLD, 'runtime root unchanged after a failed write')
      assert.equal(existsSync(unwritableSettingsFile), false, 'no settings file was written')
    })

    await t.test('switches to a valid existing directory: 200, persisted JSON, empty new registry', async () => {
      const before = readFileSync(oldRegistryFile)
      const res = await invoke('/project-hub/settings', {
        method: 'POST',
        body: { globalWorkspaceRoot: NEW_ROOT },
      })
      assert.equal(res.status, 200)
      assert.deepEqual(res.json, { ok: true, globalWorkspaceRoot: EFFECTIVE_NEW })

      // Persisted JSON content.
      const persisted = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      assert.deepEqual(persisted, { globalWorkspaceRoot: EFFECTIVE_NEW })

      // GET immediately reflects the switch.
      const settings = await invoke('/project-hub/settings')
      assert.deepEqual(settings.json, { ok: true, globalWorkspaceRoot: EFFECTIVE_NEW })

      // A trailing separator is accepted and normalized on success.
      const normalized = await invoke('/project-hub/settings', {
        method: 'POST',
        body: { globalWorkspaceRoot: `${NEW_ROOT}\\` },
      })
      assert.equal(normalized.status, 200)
      assert.deepEqual(normalized.json, { ok: true, globalWorkspaceRoot: EFFECTIVE_NEW })

      // Empty registry for the new root: no demo projects seeded, no project
      // folders created eagerly.
      const newRegistryFile = join(NEW_ROOT, '.dsh-hub', 'projects.json')
      assert.ok(existsSync(newRegistryFile), 'new root gets an empty registry file')
      assert.deepEqual(JSON.parse(readFileSync(newRegistryFile, 'utf8')), [])
      assert.equal(existsSync(join(NEW_ROOT, seededProject.id)), false, 'no demo project folder created')
      assert.equal(existsSync(join(NEW_ROOT, '_scratchpad')), false, 'scratchpad not created eagerly')

      // Old root left byte-identical and physically intact.
      assert.equal(readFileSync(oldRegistryFile).equals(before), true, 'old registry byte-identical')
      assert.ok(existsSync(join(OLD_ROOT, seededProject.id)), 'old project directory still exists')
    })

    await t.test('state and sessions immediately use the new root', async () => {
      const state = await invoke('/project-hub/state')
      assert.equal(state.status, 200)
      assert.equal(state.json.globalWorkspaceRoot, EFFECTIVE_NEW)
      assert.deepEqual(state.json.projects, [], 'empty new-root registry -> empty project list')

      const sessions = await invoke('/project-hub/sessions')
      assert.equal(sessions.status, 200)
      const ids = sessions.json.sessions.map((row) => row.sessionId)
      assert.ok(ids.includes('HANDOFF-new'), 'new-root handoff listed after the switch')
      assert.equal(ids.includes('HANDOFF-old'), false, 'old-root handoff no longer scanned')
      const row = sessions.json.sessions.find((item) => item.sessionId === 'HANDOFF-new')
      assert.equal(row.cwd, EFFECTIVE_NEW)
    })

    await t.test('leaves a pre-existing registry of the new root untouched', async () => {
      const preseedRoot = join(BASE, 'preseed-root')
      const customProjectDir = join(preseedRoot, 'custom-project')
      mkdirSync(join(preseedRoot, '.dsh-hub'), { recursive: true })
      mkdirSync(customProjectDir, { recursive: true })
      const registryFile = join(preseedRoot, '.dsh-hub', 'projects.json')
      writeFileSync(
        registryFile,
        JSON.stringify(
          [{ id: 'custom-project', name: '自定义项目', path: customProjectDir, defaultTags: ['Custom'] }],
          null,
          2,
        ),
        'utf8',
      )
      const registryBefore = readFileSync(registryFile)

      const switched = await invoke('/project-hub/settings', {
        method: 'POST',
        body: { globalWorkspaceRoot: preseedRoot },
      })
      assert.equal(switched.status, 200)
      assert.equal(switched.json.globalWorkspaceRoot, resolve(preseedRoot))

      const state = await invoke('/project-hub/state')
      assert.equal(state.json.globalWorkspaceRoot, resolve(preseedRoot))
      assert.deepEqual(
        state.json.projects.map((project) => project.id),
        ['custom-project'],
        'projects come from the new root instead of being seeded',
      )
      assert.equal(
        readFileSync(registryFile).equals(registryBefore),
        true,
        'a pre-existing registry is left byte-identical',
      )

      // Back to NEW_ROOT for the remaining subtests.
      const back = await invoke('/project-hub/settings', {
        method: 'POST',
        body: { globalWorkspaceRoot: NEW_ROOT },
      })
      assert.equal(back.status, 200)
      assert.equal(back.json.globalWorkspaceRoot, EFFECTIVE_NEW)
    })

    await t.test('scratchpad, create-project and subtask launch all follow the new root', async () => {
      const scratch = await invoke('/project-hub/launch-session', {
        method: 'POST',
        body: { isScratchpad: true },
      })
      assert.equal(scratch.status, 200)
      const scratchCwd = join(EFFECTIVE_NEW, '_scratchpad')
      assert.equal(scratch.json.cwd, scratchCwd)
      assert.ok(existsSync(scratchCwd), 'new-root scratchpad directory created')

      const created = await invoke('/project-hub/create-project', {
        method: 'POST',
        body: { id: 'post-switch', name: '切换后项目', defaultTags: ['Core'] },
      })
      assert.equal(created.status, 200)
      assert.equal(created.json.ok, true)
      const projectPath = join(EFFECTIVE_NEW, 'post-switch')
      assert.equal(created.json.project.path, projectPath)
      assert.ok(existsSync(join(projectPath, '.dsh-hub', 'docs')), 'project docs created under the new root')
      const newRegistry = JSON.parse(readFileSync(join(NEW_ROOT, '.dsh-hub', 'projects.json'), 'utf8'))
      assert.ok(newRegistry.some((project) => project.id === 'post-switch'), 'registry lives in the new root')

      const launched = await invoke('/project-hub/launch-session', {
        method: 'POST',
        body: { projectId: 'post-switch', projectName: '切换后项目', selectedSmallTags: ['子任务'] },
      })
      assert.equal(launched.status, 200)
      const subtaskCwd = join(projectPath, 'subtasks', '子任务')
      assert.equal(launched.json.cwd, subtaskCwd, 'subtask workspace computed under the new root')
      assert.ok(existsSync(subtaskCwd), 'subtask directory created under the new root')
      const promptText = host.promptedTurns[host.promptedTurns.length - 1].content[0].text
      assert.ok(promptText.includes(subtaskCwd), 'prompt names the new-root sub-workspace path')
    })

    await t.test('remove-project unregisters from the new root only', async () => {
      await invoke('/project-hub/create-project', {
        method: 'POST',
        body: { id: 'remove-later', name: '稍后移除' },
      })
      const removed = await invoke('/project-hub/remove-project', {
        method: 'POST',
        body: { projectId: 'remove-later' },
      })
      assert.equal(removed.status, 200)
      assert.equal(removed.json.ok, true)
      assert.equal(removed.json.removed, true)

      const newRegistry = JSON.parse(readFileSync(join(NEW_ROOT, '.dsh-hub', 'projects.json'), 'utf8'))
      assert.deepEqual(newRegistry.map((project) => project.id), ['post-switch'])
      assert.ok(
        existsSync(join(EFFECTIVE_NEW, 'remove-later')),
        'unregister is registry-only: project folder survives under the new root',
      )
      assert.equal(
        readFileSync(oldRegistryFile).equals(oldRegistryBytes),
        true,
        'old root registry untouched by the new-root unregister',
      )
    })

    await t.test('ingest-history and record_module_done write under the new root', async () => {
      const projectPath = join(EFFECTIVE_NEW, 'post-switch')

      const ingested = await invoke('/project-hub/ingest-history', {
        method: 'POST',
        body: {
          sessionIds: ['s-dynamic'],
          projectId: 'post-switch',
          bigTag: 'Core',
          smallTag: '动态根入库',
          workspacePath: projectPath,
        },
      })
      assert.equal(ingested.status, 200)
      assert.equal(ingested.json.ok, true)
      const docPath = join(projectPath, '.dsh-hub', 'docs', 'Core', '动态根入库.md')
      assert.equal(ingested.json.written[0].file, docPath)
      assert.ok(existsSync(docPath), 'ingested markdown lands under the new root')

      // record_module_done resolves the root getter at EXECUTE time.
      const tool = host.tools.get('record_module_done')
      assert.ok(tool, 'record_module_done tool registered')
      const result = await tool.execute(
        { projectId: 'post-switch', bigTag: 'Core', smallTag: '动态根工具', summary: '切换后工具写入' },
        { session: { id: 's-tool-dynamic', header: { cwd: projectPath } } },
      )
      assert.equal(result.ok, true)
      assert.ok(result.filePath.startsWith(projectPath), 'tool resolved the getter at execute time')
      assert.ok(existsSync(join(projectPath, '.dsh-hub', 'docs', 'Core', '动态根工具.md')))

      // Nothing leaked into the old root.
      assert.equal(existsSync(join(OLD_ROOT, 'post-switch')), false)
      assert.equal(existsSync(join(OLD_ROOT, '_scratchpad')), false)
      assert.equal(
        readFileSync(oldRegistryFile).equals(oldRegistryBytes),
        true,
        'old registry still byte-identical',
      )
    })

    await t.test('a second fresh apply() with the same config uses the persisted root', async () => {
      const second = makeHost()
      apply(second.ctx, { globalWorkspaceRoot: OLD_ROOT, settingsFile: SETTINGS_FILE })
      const invoke2 = makeInvoker(second.routes)

      const settings = await invoke2('/project-hub/settings')
      assert.equal(settings.status, 200)
      assert.equal(settings.json.globalWorkspaceRoot, EFFECTIVE_NEW, 'persisted root wins over the configured root')

      const state = await invoke2('/project-hub/state')
      assert.equal(state.json.globalWorkspaceRoot, EFFECTIVE_NEW)
      assert.ok(
        state.json.projects.some((project) => project.id === 'post-switch'),
        'the new-root registry is the one loaded',
      )
      assert.equal(
        readFileSync(oldRegistryFile).equals(oldRegistryBytes),
        true,
        'old root untouched by the second apply',
      )
    })

    await t.test('invalid persisted settings fall back to the configured root with a warning', async () => {
      // 1) Persisted path that does not exist -> fallback + warn, no auto-create.
      const missingPersisted = join(BASE, 'missing-persisted-root')
      writeFileSync(SETTINGS_FILE, JSON.stringify({ globalWorkspaceRoot: missingPersisted }, null, 2), 'utf8')

      const fallbackHost = makeHost()
      apply(fallbackHost.ctx, { globalWorkspaceRoot: OLD_ROOT, settingsFile: SETTINGS_FILE })
      const invokeFallback = makeInvoker(fallbackHost.routes)
      const settings = await invokeFallback('/project-hub/settings')
      assert.equal(settings.json.globalWorkspaceRoot, EFFECTIVE_OLD)
      assert.equal(existsSync(missingPersisted), false, 'invalid persisted directory is never auto-created')
      assert.ok(
        fallbackHost.warns.some((message) => message.includes('falling back')),
        'a warning is logged for the invalid persisted value',
      )

      // 2) Persisted relative path is invalid too.
      writeFileSync(SETTINGS_FILE, JSON.stringify({ globalWorkspaceRoot: 'work\\x' }, null, 2), 'utf8')
      const relativeHost = makeHost()
      apply(relativeHost.ctx, { globalWorkspaceRoot: OLD_ROOT, settingsFile: SETTINGS_FILE })
      const invokeRelative = makeInvoker(relativeHost.routes)
      assert.equal((await invokeRelative('/project-hub/settings')).json.globalWorkspaceRoot, EFFECTIVE_OLD)
      assert.ok(relativeHost.warns.some((message) => message.includes('falling back')))

      assert.equal(
        readFileSync(oldRegistryFile).equals(oldRegistryBytes),
        true,
        'fallback applies never rewrite the old registry',
      )
    })

    // Isolation guard: this suite never writes the real plugin config.json.
    if (realSettingsBefore === null) {
      assert.equal(existsSync(REAL_SETTINGS_FILE), false, 'real plugin config.json was never created')
    } else {
      assert.equal(
        readFileSync(REAL_SETTINGS_FILE).equals(realSettingsBefore),
        true,
        'real plugin config.json was never modified',
      )
    }
  } finally {
    if (existsSync(BASE)) rmSync(BASE, { recursive: true, force: true })
  }
})
