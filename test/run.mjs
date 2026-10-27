import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initProjectRegistry,
  listProjectsWithDocs,
  createProject,
  computeSubWorkspace,
  writeTagDoc,
  readTagDocs,
  removeProjectFromRegistry,
  validateTagName,
} from '../lib/doc-manager.js'
import { isGenuineTaskCompletion, registerModuleDoneTool } from '../lib/completion-gate.js'

// Keep all test data inside the plugin workspace; never touch C:\work user data.
const TEST_ROOT = fileURLToPath(new URL('./.tmp-doc-manager', import.meta.url))

test('DSH Project Hub — Doc Manager & 3-Tier Workspaces', async (t) => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })

  await t.test('initializes registry and lists initial projects', () => {
    const list = initProjectRegistry(TEST_ROOT)
    assert.equal(Array.isArray(list), true)
    assert.ok(list.length >= 3)
  })

  await t.test('creates a new project', () => {
    const created = createProject(TEST_ROOT, {
      id: 'test-project',
      name: '测试项目',
      defaultTags: ['UI', 'Core'],
    })
    assert.equal(created.id, 'test-project')
    assert.ok(existsSync(join(TEST_ROOT, 'test-project')))
  })

  await t.test('computes sub-workspaces correctly (3-Tier hierarchy)', () => {
    // 0 tags -> root
    const rootWs = computeSubWorkspace(TEST_ROOT, 'test-project', [])
    assert.equal(rootWs.mode, 'root')
    assert.equal(rootWs.cwd, join(TEST_ROOT, 'test-project'))

    // 1 tag -> single subtask
    const singleWs = computeSubWorkspace(TEST_ROOT, 'test-project', ['UI组件'])
    assert.equal(singleWs.mode, 'single')
    assert.ok(singleWs.cwd.includes('subtasks'))
    assert.ok(existsSync(singleWs.cwd))

    // >1 tags -> combo subtask
    const comboWs = computeSubWorkspace(TEST_ROOT, 'test-project', ['UI组件', 'Core算法'])
    assert.equal(comboWs.mode, 'combo')
    assert.ok(comboWs.cwd.includes('subtasks'))
    assert.ok(comboWs.cwd.includes('combo-'))
    assert.ok(existsSync(comboWs.cwd))
  })

  await t.test('writes and reads high-fidelity tag docs with workspace_path', () => {
    const res = writeTagDoc(TEST_ROOT, {
      projectId: 'test-project',
      projectName: '测试项目',
      bigTag: 'UI',
      smallTag: '侧边栏按钮',
      workspacePath: 'C:\\work\\test-project\\subtasks\\single-ui',
      sessionId: 's-12345',
      summary: '侧边栏按钮已重构完成',
      details: '去除了所有 Emoji，采用极简无图标设计。',
      deliverables: ['lib/client.js'],
    })
    assert.ok(existsSync(res.filePath))

    const docs = readTagDocs(TEST_ROOT, 'test-project', ['侧边栏按钮'])
    assert.equal(docs.length, 1)
    assert.equal(docs[0].smallTag, '侧边栏按钮')
    assert.equal(docs[0].workspacePath, 'C:\\work\\test-project\\subtasks\\single-ui')
    assert.ok(docs[0].content.includes('物理工作区'))
  })

  await t.test('unregisters a project (registry-only): files and docs stay on disk', () => {
    createProject(TEST_ROOT, { id: 'registry-only', name: '仅移出注册', defaultTags: ['UI'] })
    writeTagDoc(TEST_ROOT, {
      projectId: 'registry-only',
      projectName: '仅移出注册',
      bigTag: 'UI',
      smallTag: '保留档案',
      sessionId: 's-unregister',
      summary: '移出列表只动注册表，这份档案必须原样保留',
    })
    const projDir = join(TEST_ROOT, 'registry-only')
    const docFile = join(projDir, '.dsh-hub', 'docs', 'UI', '保留档案.md')
    assert.ok(existsSync(docFile), 'doc exists before unregister')

    const first = removeProjectFromRegistry(TEST_ROOT, 'registry-only')
    assert.equal(first.removed, true)
    assert.equal(first.projectId, 'registry-only')
    assert.equal(
      listProjectsWithDocs(TEST_ROOT).some((project) => project.id === 'registry-only'),
      false,
      'the project disappears from the registry-backed state list',
    )
    // Unregister is registry-only: no physical delete / move / rename.
    assert.ok(existsSync(projDir), 'project directory must survive')
    assert.ok(existsSync(docFile), 'knowledge-base markdown must survive')

    // Idempotent: a second call reports “not registered” and changes nothing.
    const second = removeProjectFromRegistry(TEST_ROOT, 'registry-only')
    assert.equal(second.removed, false)
    assert.ok(existsSync(docFile), 'markdown still untouched after the idempotent retry')
    assert.equal(removeProjectFromRegistry(TEST_ROOT, 'never-existed').removed, false)
  })

  await t.test('evaluates completion gate', () => {
    // Pure conversation without tools -> reject
    const nonMutatingTurn = {
      reason: { kind: 'completed' },
      turn: { messages: [{ role: 'assistant', text: '你好，这行代码是什么意思？' }] },
    }
    assert.equal(isGenuineTaskCompletion(nonMutatingTurn, {}), false)

    // Interrupted turn -> reject
    const interruptedTurn = {
      reason: { kind: 'aborted' },
      turn: { messages: [{ role: 'assistant', toolCalls: [{ name: 'write_file' }] }] },
    }
    assert.equal(isGenuineTaskCompletion(interruptedTurn, {}), false)

    // Completed turn with file writes -> accept
    const completedTurn = {
      reason: { kind: 'completed' },
      turn: { messages: [{ role: 'assistant', toolCalls: [{ name: 'write_file' }] }] },
    }
    assert.equal(isGenuineTaskCompletion(completedTurn, {}), true)
  })

  await t.test('registers record_module_done through the injected tools service', async () => {
    const registered = new Map()
    const tools = {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    }
    const dispose = registerModuleDoneTool({ tools }, TEST_ROOT)
    assert.equal(typeof dispose, 'function')
    assert.ok(registered.has('record_module_done'))

    const result = await registered.get('record_module_done').execute(
      { projectId: 'test-project', bigTag: 'UI', smallTag: '工具落盘', summary: '通过显式工具沉淀档案' },
      { session: { id: 's-tool-1', header: { cwd: join(TEST_ROOT, 'test-project') } } },
    )
    assert.equal(result.ok, true)
    assert.ok(existsSync(join(TEST_ROOT, 'test-project', '.dsh-hub', 'docs', 'UI', '工具落盘.md')))

    dispose()
    assert.equal(registered.has('record_module_done'), false)
  })

  await t.test('writeTagDoc appends a dated section and never loses the hand-written body', () => {
    const first = writeTagDoc(TEST_ROOT, {
      projectId: 'test-project',
      bigTag: 'UI',
      smallTag: '追加模式',
      workspacePath: 'C:\\work\\test-project',
      sessionId: 's-append-1',
      summary: '第一次沉淀',
      details: '第一版实现',
      deliverables: ['lib/first.js'],
    })
    assert.ok(existsSync(first.filePath))
    assert.equal(first.appended, false, 'a new archive is created from the 5-section template')

    // Hand-written prose that every later archive call must preserve.
    const handWritten = '## 手写补充（人工维护）\n\n这段正文必须在后续归档时原样保留。'
    writeFileSync(first.filePath, readFileSync(first.filePath, 'utf8') + '\n' + handWritten + '\n', 'utf8')
    const before = readFileSync(first.filePath, 'utf8')

    const second = writeTagDoc(TEST_ROOT, {
      projectId: 'test-project',
      bigTag: 'UI',
      smallTag: '追加模式',
      workspacePath: 'C:\\work\\test-project',
      sessionId: 's-append-2',
      summary: '第二次沉淀',
      details: '第二版实现',
      deliverables: ['lib/second.js'],
    })
    assert.equal(second.appended, true, 'an existing archive is appended, not rewritten')
    const after = readFileSync(first.filePath, 'utf8')
    assert.ok(after.includes(handWritten), 'hand-written body is preserved verbatim')
    assert.match(after, /## 追加记录（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/, 'the append heading carries a timestamp')
    assert.ok(after.includes('第二次沉淀'), 'the new summary is appended')
    assert.equal((after.match(/# 模块全景档案：/g) || []).length, 1, 'the 五节模板 is never repeated')
    assert.equal((after.match(/### 一、/g) || []).length, 1, 'section headings are not re-emitted')
    assert.equal((after.match(/last_updated:/g) || []).length, 1, 'frontmatter is not duplicated')

    const field = (text, name) => (new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text) || [])[1] || ''
    assert.equal(field(after, 'project_id'), field(before, 'project_id'), 'frontmatter project_id is untouched')
    assert.equal(field(after, 'big_tag'), field(before, 'big_tag'), 'frontmatter big_tag is untouched')
    assert.notEqual(field(after, 'last_updated'), field(before, 'last_updated'), 'only last_updated moves')

    // The legacy whole-file rewrite is still available explicitly.
    writeTagDoc(TEST_ROOT, {
      projectId: 'test-project',
      bigTag: 'UI',
      smallTag: '追加模式',
      workspacePath: 'C:\\work\\test-project',
      summary: '覆盖模式',
      mode: 'overwrite',
    })
    const finalText = readFileSync(first.filePath, 'utf8')
    assert.equal(finalText.includes('这段正文必须在后续归档时原样保留'), false, "mode:'overwrite' keeps the legacy behaviour")
    assert.ok(finalText.includes('覆盖模式'))

    // 'create' mode refuses to clobber an existing archive.
    assert.throws(
      () => writeTagDoc(TEST_ROOT, { projectId: 'test-project', bigTag: 'UI', smallTag: '追加模式', mode: 'create' }),
      (error) => error && error.code === 'doc_exists',
    )
  })

  await t.test('validateTagName rejects empty / padded / illegal names, accepts normal ones', () => {
    assert.equal(validateTagName('', '小标签').ok, false)
    assert.equal(validateTagName('   ', '小标签').ok, false)
    assert.equal(validateTagName(' 前后空格 ', '小标签').ok, false)
    assert.equal(validateTagName('a/b', '小标签').ok, false)
    assert.equal(validateTagName('a\\b', '小标签').ok, false)
    assert.equal(validateTagName('a:b', '小标签').ok, false)
    assert.equal(validateTagName('a?b', '小标签').ok, false)
    assert.equal(validateTagName('结尾点.', '小标签').ok, false)
    assert.equal(validateTagName('..', '小标签').ok, false)
    assert.equal(validateTagName(undefined, '小标签').ok, false)
    const ok = validateTagName('音画时间轴对齐', '小标签')
    assert.equal(ok.ok, true)
    assert.equal(ok.value, '音画时间轴对齐')
  })

  await t.test('record_module_done (completion-gate chain) appends on the second call', async () => {
    let definition = null
    const tools = {
      register(def) {
        definition = def
        return () => {
          definition = null
        }
      },
    }
    registerModuleDoneTool({ tools }, TEST_ROOT)
    assert.ok(definition, 'record_module_done registered')
    const args = { projectId: 'test-project', bigTag: 'UI', smallTag: '工具追加', summary: '第一次工具沉淀' }
    const first = await definition.execute(args, {
      session: { id: 's-tool-a', header: { cwd: join(TEST_ROOT, 'test-project') } },
    })
    const second = await definition.execute(
      { ...args, summary: '第二次工具沉淀' },
      { session: { id: 's-tool-b', header: { cwd: join(TEST_ROOT, 'test-project') } } },
    )
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.filePath, second.filePath, 'the same archive is reused')

    const raw = readFileSync(first.filePath, 'utf8')
    assert.equal((raw.match(/### 一、/g) || []).length, 1, 'the template is written once')
    assert.equal((raw.match(/## 追加记录（/g) || []).length, 1, 'the second call appends one dated section')
    assert.ok(raw.includes('第二次工具沉淀'))
    assert.ok(raw.includes('第一次工具沉淀'), 'the first delivery survives the append')
  })

  // Cleanup
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
})
