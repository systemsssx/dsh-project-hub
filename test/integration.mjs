import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

// Keep all test data inside the plugin workspace; never touch C:\work user data.
const TEST_GLOBAL_ROOT = fileURLToPath(new URL('./.tmp-integration', import.meta.url))

// ---------------------------------------------------------------------------
// Raw node:http mocks — webServer.register hands out (req, res), NOT Fetch.
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

test('DSH Project Hub — Full Integration & Route Validation', async (t) => {
  if (existsSync(TEST_GLOBAL_ROOT)) rmSync(TEST_GLOBAL_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_GLOBAL_ROOT, { recursive: true })

  const routes = new Map()
  const tools = new Map()
  const createdSessions = []
  const promptedTurns = []
  const renamedSessions = []
  const createdWorkspaces = []
  let sessionSeq = 0

  const summaryItems = [
    {
      sessionId: 's-old-1',
      updatedAt: Date.now() - 60_000,
      cwd: 'C:\\work\\novel-video',
      blank: false,
      projections: { kind: 'sequenced', asOfSeq: 12, values: { title: '旧会话：时间轴对齐' } },
    },
    {
      sessionId: 's-old-2',
      updatedAt: Date.now() - 120_000,
      cwd: 'C:\\work\\claw-game',
      blank: false,
      projections: { kind: 'sequenced', asOfSeq: 5, values: { title: '旧会话：抓娃娃机控制' } },
    },
    {
      sessionId: 's-subagent',
      updatedAt: Date.now() - 5_000,
      cwd: 'C:\\work\\novel-video',
      blank: false,
      origin: 'subagent',
      projections: { values: { title: '子代理会话（应被过滤）' } },
    },
    {
      sessionId: 's-blank',
      updatedAt: Date.now() - 1_000,
      cwd: 'C:\\work',
      blank: true,
      projections: { values: {} },
    },
  ]

  const inspections = new Map([
    [
      's-old-1',
      {
        meta: { id: 's-old-1', version: 1, createdAt: 1, cwd: 'C:\\work\\novel-video', isSeeded: false },
        inheritedEventCount: 0,
        events: [
          { type: 'session/title', seq: 0, time: 1, data: { title: '旧会话：时间轴对齐' } },
          {
            type: 'user/message',
            seq: 1,
            time: 2,
            data: { message: { role: 'user', content: [{ type: 'text', text: '把音画时间轴对齐一下' }] } },
          },
          { type: 'tool/call', seq: 2, time: 3, data: { name: 'write_file', arguments: '{"file_path":"src/timeline.js"}' } },
          { type: 'tool/call', seq: 3, time: 4, data: { name: 'edit_file', arguments: '{"path":"src/align.js"}' } },
          { type: 'tool/call', seq: 4, time: 5, data: { name: 'read_file', arguments: '{"file_path":"README.md"}' } },
          {
            type: 'assistant/message',
            seq: 5,
            time: 6,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: '时间轴对齐已完成，两个文件已更新。' }] } },
          },
        ],
      },
    ],
    [
      's-old-2',
      {
        meta: { id: 's-old-2', version: 1, createdAt: 1, cwd: 'C:\\work\\claw-game', isSeeded: false },
        inheritedEventCount: 0,
        events: [{ type: 'user/message', seq: 0, time: 1, data: { message: { content: [{ type: 'text', text: '控制台调整' }] } } }],
      },
    ],
  ])

  const mockWebServer = {
    register({ kind, path, handler }) {
      routes.set(path, { kind, handler })
      return () => routes.delete(path)
    },
  }

  const mockSessionController = {
    async create(request) {
      const sessionId = `s-test-${++sessionSeq}`
      createdSessions.push({ sessionId, ...request })
      // The real controller publishes the Session before `create` resolves, so
      // the launcher can pin its permission preset.
      liveSessions.set(sessionId, { id: sessionId, append() {} })
      return { sessionId }
    },
    async rename(request) {
      renamedSessions.push(request)
      return { title: request.title, seq: 1 }
    },
    async prompt(request) {
      promptedTurns.push(request)
      return { accepted: true }
    },
    async list() {
      return { items: summaryItems }
    },
    async inspect(sessionId) {
      return inspections.get(sessionId)
    },
  }

  const mockWorkspaceRegistry = {
    async create(path, title) {
      createdWorkspaces.push({ path, title })
      return { id: `ws-${createdWorkspaces.length}`, cwd: path, title }
    },
    list() {
      return []
    },
  }

  // ── Agent-mode / permission services (「标准模式」 vs 「Computer Use 模式」) ──
  const liveSessions = new Map()
  const pinnedPermissions = []
  let computerUseAvailable = true
  let standardBroken = false

  const mockAgentPresets = {
    async resolve(id) {
      const known = id === 'standard' || (id === 'computer-use' && computerUseAvailable)
      if (!known) {
        const error = new Error(`Unknown agent preset: ${id}`)
        error.code = 'agent-preset/not-found'
        throw error
      }
      if (id === 'standard' && standardBroken) return { id, broken: 'synthetic-broken-composition' }
      return { id }
    },
  }

  const mockSessions = {
    get(sessionId) {
      return liveSessions.get(String(sessionId))
    },
  }

  const mockPermissionPresets = {
    set(session, preset) {
      pinnedPermissions.push({ sessionId: session.id, preset })
    },
  }

  const mockTools = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  }

  const mockCtx = {
    logger: { info() {}, warn() {}, error() {} },
    get(identifier) {
      if (identifier === 'sessionController') return mockSessionController
      if (identifier === 'workspaceRegistry') return mockWorkspaceRegistry
      if (identifier === 'agentPresets') return mockAgentPresets
      if (identifier === 'sessions') return mockSessions
      if (identifier === 'permissionPresets') return mockPermissionPresets
      return undefined
    },
    inject(deps, callback) {
      const hostCtx = {
        webServer: mockWebServer,
        tools: mockTools,
        effect(fn) {
          return fn()
        },
      }
      callback(hostCtx)
    },
  }

  apply(mockCtx, { globalWorkspaceRoot: TEST_GLOBAL_ROOT, settingsFile: join(TEST_GLOBAL_ROOT, 'settings.json') })

  const invoke = async (path, { method = 'GET', body, headers } = {}) => {
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

  await t.test('registers all endpoints with the raw node (req, res) contract and the explicit tool', () => {
    for (const path of [
      '/project-hub/state',
      '/project-hub/sessions',
      '/project-hub/create-project',
      '/project-hub/create-doc',
      '/project-hub/launch-session',
      '/project-hub/ingest-history',
      '/project-hub/remove-project',
    ]) {
      assert.ok(routes.has(path), `${path} registered`)
      assert.equal(routes.get(path).kind, 'exact')
    }
    assert.ok(tools.has('record_module_done'), 'record_module_done tool registered')
  })

  await t.test('answers CORS preflight including Private Network Access', async () => {
    const res = await invoke('/project-hub/state', {
      method: 'OPTIONS',
      headers: {
        origin: 'dsh-app://app',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'dsh-app://app')
    assert.equal(res.headers['Access-Control-Allow-Private-Network'], 'true')
    assert.match(res.headers['Access-Control-Allow-Methods'], /GET/)
  })

  await t.test('GET /project-hub/state returns project tree and always ends the response', async () => {
    const res = await invoke('/project-hub/state')
    assert.equal(res.status, 200)
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'dsh-app://app')
    assert.match(res.headers['Content-Type'], /application\/json/)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.globalWorkspaceRoot, TEST_GLOBAL_ROOT)
    assert.ok(res.json.projects.length >= 3)
    assert.deepEqual(
      res.json.agentModes.map((mode) => [mode.id, mode.available]),
      [
        ['standard', true],
        ['computer-use', true],
      ],
      'both launcher modes are advertised while the computer-use preset resolves',
    )
  })

  await t.test('GET /project-hub/sessions returns titles, time, workspace and changed-file counts', async () => {
    const res = await invoke('/project-hub/sessions')
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    const sessions = res.json.sessions
    assert.ok(Array.isArray(sessions) && sessions.length >= 2)

    const first = sessions.find((item) => item.sessionId === 's-old-1')
    assert.ok(first, 's-old-1 present')
    assert.equal(first.title, '旧会话：时间轴对齐')
    assert.equal(first.cwd, 'C:\\work\\novel-video')
    assert.equal(first.changedFiles, 2, 'two distinct file writes counted')
    assert.ok(first.updatedAt > 0)

    assert.equal(sessions.some((item) => item.sessionId === 's-subagent'), false, 'subagent sessions filtered')
    assert.equal(sessions.some((item) => item.sessionId === 's-blank'), false, 'blank sessions filtered')
  })

  await t.test('POST /project-hub/create-project creates project and answers JSON', async () => {
    const res = await invoke('/project-hub/create-project', {
      method: 'POST',
      body: { id: 'novel-auto', name: '自动小说生成', defaultTags: ['Text', 'Audio'] },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.project.id, 'novel-auto')
    assert.ok(existsSync(join(TEST_GLOBAL_ROOT, 'novel-auto', '.dsh-hub', 'docs')))
  })

  await t.test('POST /project-hub/create-doc writes the five-section MD and refuses duplicates', async () => {
    const created = await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { projectId: 'novel-auto', bigTag: 'Text', smallTag: '时间轴对齐', title: '时间轴对齐' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    const filePath = created.json.filePath
    assert.ok(filePath && existsSync(filePath), 'the ABSOLUTE file path is returned and the file exists')
    assert.equal(
      filePath,
      join(TEST_GLOBAL_ROOT, 'novel-auto', '.dsh-hub', 'docs', 'Text', '时间轴对齐.md'),
      'the path lands under docs/<大标签>/<小标签>.md',
    )
    assert.equal(created.json.smallTag, '时间轴对齐')
    assert.deepEqual(
      created.json.docs.map((row) => row.smallTag),
      ['时间轴对齐'],
      'the refreshed 大标签 archive list is returned',
    )

    const raw = readFileSync(filePath, 'utf8')
    for (const field of [
      'project_id:',
      'project_name:',
      'big_tag:',
      'small_tag:',
      'workspace_path:',
      'last_updated:',
      'session_id:',
      'status:',
    ]) {
      assert.ok(raw.includes(field), `frontmatter carries ${field}`)
    }
    for (const section of ['### 一、', '### 二、', '### 三、', '### 四、', '### 五、']) {
      assert.ok(raw.includes(section), `the template carries ${section}`)
    }

    // A second create (same name, and a case-only variant) answers 409 已存在.
    const duplicate = await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { projectId: 'novel-auto', bigTag: 'Text', smallTag: '时间轴对齐' },
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.ok, false)
    assert.equal(duplicate.json.code, 'doc_exists')
    assert.ok(duplicate.json.error.includes('已存在'))

    await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { projectId: 'novel-auto', bigTag: 'Text', smallTag: 'timeline' },
    })
    const caseDuplicate = await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { projectId: 'novel-auto', bigTag: 'Text', smallTag: 'TIMELINE' },
    })
    assert.equal(caseDuplicate.status, 409, 'a case-insensitive duplicate is rejected')
    assert.equal(caseDuplicate.json.code, 'doc_exists')

    // Validation: illegal characters / padded / empty / missing project.
    for (const body of [
      { projectId: 'novel-auto', bigTag: 'Text', smallTag: 'a/b' },
      { projectId: 'novel-auto', bigTag: 'Text', smallTag: 'a:b' },
      { projectId: 'novel-auto', bigTag: 'Text', smallTag: ' 前后空格 ' },
      { projectId: 'novel-auto', bigTag: ' Text', smallTag: 'x' },
    ]) {
      const bad = await invoke('/project-hub/create-doc', { method: 'POST', body })
      assert.equal(bad.status, 400, `invalid input rejected: ${JSON.stringify(body)}`)
      assert.equal(bad.json.ok, false)
      assert.equal(bad.json.code, 'tag_invalid')
    }
    const emptyName = await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { projectId: 'novel-auto', bigTag: 'Text', smallTag: '' },
    })
    assert.equal(emptyName.status, 400)
    assert.equal(emptyName.json.code, 'tag_required')
    const noProject = await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { bigTag: 'Text', smallTag: 'x' },
    })
    assert.equal(noProject.status, 400)
    assert.equal(noProject.json.code, 'project_required')
    const missingPath = await invoke('/project-hub/create-doc', {
      method: 'POST',
      body: { projectPath: join(TEST_GLOBAL_ROOT, 'never-existed'), bigTag: 'Text', smallTag: 'x' },
    })
    assert.equal(missingPath.status, 400)
    assert.equal(missingPath.json.code, 'project_not_found')
  })

  await t.test('POST /project-hub/launch-session for scratchpad (其他 / 杂务)', async () => {
    const res = await invoke('/project-hub/launch-session', {
      method: 'POST',
      body: { isScratchpad: true },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.ok(res.json.cwd.includes('_scratchpad'))
    assert.ok(existsSync(join(TEST_GLOBAL_ROOT, '_scratchpad')))

    const lastPrompt = promptedTurns[promptedTurns.length - 1]
    const promptText = lastPrompt.content[0].text
    assert.ok(promptText.includes('请问有什么琐事需要处理？'))
    assert.ok(promptText.includes('请只输出下面这一行纯文本'))
    assert.ok(!promptText.includes('选项按钮吗'), 'no option buttons')
  })

  await t.test('POST /project-hub/launch-session for multi-tag project task creates combo workspace', async () => {
    const res = await invoke('/project-hub/launch-session', {
      method: 'POST',
      body: {
        projectId: 'novel-auto',
        projectName: '自动小说生成',
        selectedSmallTags: ['分镜提取', '音频对齐'],
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.ok(res.json.cwd.includes('subtasks'))
    assert.ok(res.json.cwd.includes('combo-'))
    assert.ok(res.json.cwd.includes('分镜提取'))
    assert.ok(res.json.cwd.includes('音频对齐'))
    assert.ok(res.json.sessionId, 'session created')
    assert.ok(res.json.workspaceId, 'workspace registered for grouping')

    const created = createdSessions.find((item) => item.sessionId === res.json.sessionId)
    assert.equal(created.workspaceId, res.json.workspaceId)

    const lastPrompt = promptedTurns[promptedTurns.length - 1]
    const promptText = lastPrompt.content[0].text
    assert.ok(promptText.includes('相关模块背景已同步完毕，复合子工作区已就绪。请问下一步干嘛？'))
    assert.ok(promptText.includes('请只输出下面这一行纯文本'))
    assert.ok(promptText.includes(res.json.cwd), 'prompt names the physical sub-workspace path')

    const lastRename = renamedSessions[renamedSessions.length - 1]
    assert.equal(lastRename.sessionId, res.json.sessionId)
    assert.ok(lastRename.title.includes('自动小说生成'))
  })

  await t.test('POST /project-hub/launch-session without projectId answers 400 JSON', async () => {
    const res = await invoke('/project-hub/launch-session', { method: 'POST', body: {} })
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
  })

  await t.test('launch-session defaults to 标准模式 and pins 完全权限 before the prompt', async () => {
    const pinnedBefore = pinnedPermissions.length
    const res = await invoke('/project-hub/launch-session', {
      method: 'POST',
      body: { projectId: 'novel-auto', projectName: '自动小说生成', selectedSmallTags: ['分镜提取'] },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.mode, 'standard')
    assert.equal(res.json.agentPreset, 'standard')
    assert.equal(res.json.permissionPreset, 'danger-full-access')

    const created = createdSessions.find((item) => item.sessionId === res.json.sessionId)
    assert.equal(created.agentPreset, 'standard', 'the shipped standard preset backs 标准模式')

    assert.equal(pinnedPermissions.length, pinnedBefore + 1, 'exactly one full-access pin per launch')
    const pinned = pinnedPermissions[pinnedPermissions.length - 1]
    assert.equal(pinned.sessionId, res.json.sessionId)
    assert.equal(pinned.preset, 'danger-full-access')

    const promptText = promptedTurns[promptedTurns.length - 1].content[0].text
    assert.ok(promptText.includes('启动模式：标准模式'), 'prompt names the selected mode')
    assert.ok(promptText.includes('完全权限'), 'prompt states the full-access policy')
  })

  await t.test('launch-session Computer Use 模式 names the computer-use preset (also full access)', async () => {
    const res = await invoke('/project-hub/launch-session', {
      method: 'POST',
      body: {
        projectId: 'novel-auto',
        projectName: '自动小说生成',
        selectedSmallTags: ['分镜提取'],
        mode: 'computer-use',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.mode, 'computer-use')
    assert.equal(res.json.modeName, 'Computer Use 模式')
    assert.equal(res.json.agentPreset, 'computer-use')
    assert.equal(res.json.permissionPreset, 'danger-full-access')

    const created = createdSessions.find((item) => item.sessionId === res.json.sessionId)
    assert.equal(created.agentPreset, 'computer-use')
    const promptText = promptedTurns[promptedTurns.length - 1].content[0].text
    assert.ok(promptText.includes('启动模式：Computer Use 模式'))
  })

  await t.test('launch-session rejects unknown and unavailable modes with 400 JSON', async () => {
    const unknown = await invoke('/project-hub/launch-session', {
      method: 'POST',
      body: { projectId: 'novel-auto', mode: 'gui-ultra' },
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.ok, false)
    assert.equal(unknown.json.code, 'agent_mode_unknown')

    computerUseAvailable = false
    try {
      const state = await invoke('/project-hub/state')
      const row = state.json.agentModes.find((mode) => mode.id === 'computer-use')
      assert.equal(row.available, false, 'state reports the unavailable mode')
      const unavailable = await invoke('/project-hub/launch-session', {
        method: 'POST',
        body: { projectId: 'novel-auto', mode: 'computer-use' },
      })
      assert.equal(unavailable.status, 400)
      assert.equal(unavailable.json.ok, false)
      assert.equal(unavailable.json.code, 'agent_mode_unavailable')
    } finally {
      computerUseAvailable = true
    }
  })

  await t.test('a broken standard preset falls back to the roster default (launch still works)', async () => {
    standardBroken = true
    try {
      const state = await invoke('/project-hub/state')
      const row = state.json.agentModes.find((mode) => mode.id === 'standard')
      assert.equal(row.available, true, '标准模式 stays selectable')
      assert.equal(row.presetId, null, 'a broken standard preset is omitted, not named')

      const res = await invoke('/project-hub/launch-session', {
        method: 'POST',
        body: { projectId: 'novel-auto', projectName: '自动小说生成', selectedSmallTags: ['分镜提取'] },
      })
      assert.equal(res.status, 200)
      assert.equal(res.json.agentPreset, null)
      const created = createdSessions.find((item) => item.sessionId === res.json.sessionId)
      assert.equal(created.agentPreset, undefined, 'the default roster preset runs instead')
      assert.equal(res.json.permissionPreset, 'danger-full-access', 'full access is still pinned')
    } finally {
      standardBroken = false
    }
  })

  await t.test('POST /project-hub/ingest-history writes MD with workspace_path frontmatter', async () => {
    const res = await invoke('/project-hub/ingest-history', {
      method: 'POST',
      body: {
        sessionIds: ['s-old-1'],
        projectId: 'novel-auto',
        bigTag: 'Audio',
        smallTag: '历史音频对齐算法',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.count, 1)
    assert.equal(res.json.written[0].workspacePath, 'C:\\work\\novel-video')

    const targetFile = join(TEST_GLOBAL_ROOT, 'novel-auto', '.dsh-hub', 'docs', 'Audio', '历史音频对齐算法.md')
    assert.ok(existsSync(targetFile), 'Target doc exists')
    const content = readFileSync(targetFile, 'utf8')
    assert.match(content, /^---[\s\S]*workspace_path:/)
    assert.ok(content.includes('novel-video'), 'original physical workspace recorded')
    assert.ok(content.includes('时间轴对齐已完成'), 'assistant deliverable extracted from the session log')
    assert.ok(content.includes('src/timeline.js'), 'deliverable file extracted from tool calls')
  })

  await t.test('POST /project-hub/ingest-history validates required fields', async () => {
    const res = await invoke('/project-hub/ingest-history', {
      method: 'POST',
      body: { sessionIds: ['s-old-1'] },
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.ok, false)
  })

  await t.test('POST /project-hub/remove-project unregisters only, never deletes files', async () => {
    const projectDir = join(TEST_GLOBAL_ROOT, 'novel-auto')
    const docFile = join(projectDir, '.dsh-hub', 'docs', 'Audio', '历史音频对齐算法.md')
    assert.ok(existsSync(projectDir), 'project dir exists before unregister')
    assert.ok(existsSync(docFile), 'knowledge-base doc exists before unregister')

    const res = await invoke('/project-hub/remove-project', {
      method: 'POST',
      body: { projectId: 'novel-auto' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.removed, true)
    assert.equal(res.json.scope, 'registry-only')

    const state = await invoke('/project-hub/state')
    assert.equal(
      state.json.projects.some((project) => project.id === 'novel-auto'),
      false,
      'GET /state no longer lists the unregistered project',
    )

    // Unregister is registry-only: the physical project and its docs survive,
    // so the user can register the same folder again later.
    assert.ok(existsSync(projectDir), 'project directory survives the unregister')
    assert.ok(existsSync(docFile), '.dsh-hub docs markdown survives the unregister')

    // Idempotent repeat: a clear 404, not a 500.
    const again = await invoke('/project-hub/remove-project', {
      method: 'POST',
      body: { projectId: 'novel-auto' },
    })
    assert.equal(again.status, 404)
    assert.equal(again.json.ok, false)
    assert.equal(again.json.code, 'project_not_found')
    assert.ok(existsSync(docFile), 'markdown untouched after the idempotent retry')

    // Missing projectId is a client error, not a server error.
    const missing = await invoke('/project-hub/remove-project', { method: 'POST', body: {} })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.code, 'project_id_required')
  })

  // Cleanup
  if (existsSync(TEST_GLOBAL_ROOT)) rmSync(TEST_GLOBAL_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Client URL resolution: /project-hub/* must target an absolute http(s) Host
// base, never the `dsh-app://` document protocol.
// ---------------------------------------------------------------------------

test('DSH Project Hub — client resolves an absolute http(s) Host base', async (t) => {
  const captured = { definition: null }
  globalThis.window = { __ModuleLoader__: { load(definition) { captured.definition = definition } } }
  try {
    const clientPath = new URL('../lib/client.js', import.meta.url).href
    await import(clientPath)
  } finally {
    delete globalThis.window
  }

  assert.ok(captured.definition, 'client module registered through window.__ModuleLoader__')
  assert.equal(captured.definition.id, 'dsh-project-hub')

  const stubRequire = (name) => {
    if (name === 'react') {
      const React = {
        createElement(type, props, ...children) {
          return { type, props: props || {}, children }
        },
        Fragment: Symbol('Fragment'),
        useState(initial) {
          return [typeof initial === 'function' ? initial() : initial, () => {}]
        },
        useEffect() {},
        useRef() {},
        useCallback() {},
        useMemo(factory) {
          return factory()
        },
      }
      return React
    }
    if (name === 'react-dom') return { createPortal() {} }
    throw new Error(`unexpected module ${name}`)
  }
  const client = captured.definition.factory(stubRequire)
  const api = client.__test__
  assert.ok(api && typeof api.resolveHostBase === 'function' && typeof api.buildApiUrl === 'function')

  await t.test('desktop: __DSH_TRANSPORT__.streamBaseUrl provides the Host HTTP origin', () => {
    const scope = {
      __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13709' },
      location: { protocol: 'dsh-app:', host: 'app', origin: 'null', port: '' },
    }
    const base = api.resolveHostBase(scope)
    assert.equal(base, 'http://127.0.0.1:13709')
    const url = api.buildApiUrl(base, '/project-hub/state')
    assert.equal(url, 'http://127.0.0.1:13709/project-hub/state')
    assert.match(url, /^https?:\/\//, 'absolute http(s) URL')
    assert.ok(!url.includes('dsh-app:'), 'never targets the dsh-app:// document protocol')
  })

  await t.test('desktop without transport falls back to the loopback default, not dsh-app://', () => {
    const base = api.resolveHostBase({
      location: { protocol: 'dsh-app:', host: 'app', origin: 'null', port: '' },
    })
    assert.equal(base, api.DEFAULT_HOST_BASE)
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
  })

  await t.test('web mode uses the page http(s) origin', () => {
    const base = api.resolveHostBase({
      location: { protocol: 'http:', host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', port: '19387' },
    })
    assert.equal(base, 'http://127.0.0.1:19387')
  })

  await t.test('every project-hub route is built as an absolute http(s) URL', () => {
    const base = 'http://127.0.0.1:13709'
    for (const path of [
      '/project-hub/state',
      '/project-hub/sessions',
      '/project-hub/create-project',
      '/project-hub/create-doc',
      '/project-hub/launch-session',
      '/project-hub/ingest-history',
      '/project-hub/remove-project',
    ]) {
      const url = api.buildApiUrl(base, path)
      assert.match(url, /^https?:\/\//)
      assert.ok(!url.includes('dsh-app:'))
    }
  })

  await t.test('requestApi fetches the absolute Host origin', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    globalThis.window = {
      __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13709' },
      location: { protocol: 'dsh-app:', host: 'app', origin: 'null', port: '' },
    }
    try {
      const result = await api.requestApi('/project-hub/state')
      assert.equal(result.ok, true)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].input, 'http://127.0.0.1:13709/project-hub/state')
      assert.ok(!calls[0].input.includes('dsh-app:'))
    } finally {
      globalThis.fetch = originalFetch
      delete globalThis.window
    }
  })

  await t.test('desktop IPC bridge provides the Host origin when the transport global is absent', async () => {
    const win = {
      dshDesktopBoot: {
        ready: async () => ({ injections: [], streamBaseUrl: 'http://127.0.0.1:23456' }),
        failed: async () => {},
      },
      location: { protocol: 'dsh-app:', host: 'app', origin: 'null', port: '' },
    }
    const origin = await api.primeHostBaseFromBridge(win)
    assert.equal(origin, 'http://127.0.0.1:23456')
    assert.equal(api.resolveHostBase(win), 'http://127.0.0.1:23456')
    assert.equal(api.buildApiUrl(origin, '/project-hub/state'), 'http://127.0.0.1:23456/project-hub/state')
    assert.ok(!api.buildApiUrl(origin, '/project-hub/state').includes('dsh-app:'))
  })

  await t.test('apply registers the footer action + panellist actions row, never a layout panel slot', () => {
    const injected = []
    const registered = []
    const components = []
    const slots = {
      inject(slotName, callback) {
        injected.push(slotName)
        callback()
      },
      register(options, component) {
        registered.push(options)
        if (component !== undefined) components.push(component)
        return options
      },
    }
    const ctx = {
      slots,
      effect(callback) {
        callback()
        return () => {}
      },
    }
    client.apply(ctx)

    // Two declared list slots: the official footer seat and the panel-list
    // 「更多」 menu row. The layout-panel slot must never be touched.
    assert.deepEqual(injected.slice().sort(), ['sidebar.footer.action', 'sidebar.panellist.actions'])
    assert.equal(registered.length, 2)

    const footerIndex = registered.findIndex((row) => row.name === 'sidebar.footer.action')
    const menuIndex = registered.findIndex((row) => row.name === 'sidebar.panellist.actions')
    assert.notEqual(footerIndex, -1, 'sidebar.footer.action registration is kept')
    assert.notEqual(menuIndex, -1, 'sidebar.panellist.actions registration exists')

    // The old panellist entry is what made the sidebar call
    // layout.selectPanel('project-hub-panel') and throw.
    assert.equal(injected.includes('sidebar.panellist'), false)

    // Both seated triggers carry the acceptance marker.
    const footerTrigger = components[footerIndex]()
    assert.equal(typeof footerTrigger, 'object')
    assert.equal(footerTrigger.props['data-project-hub-entry'], '1')
    assert.equal(footerTrigger.props['aria-label'], '项目工坊')
    assert.equal(footerTrigger.props.className, 'dsh-ph-entry-btn')

    const menuRow = components[menuIndex]({})
    assert.equal(typeof menuRow, 'object')
    assert.equal(menuRow.props['data-project-hub-entry'], '1')
    assert.equal(menuRow.props['aria-label'], '项目工坊')
    assert.equal(menuRow.props.className, 'dsh-ph-menu-row')
  })
})
