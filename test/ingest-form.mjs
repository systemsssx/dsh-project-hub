/**
 * dsh-project-hub — test/ingest-form.mjs
 *
 * Focused tests for the 「归类历史」 ingest modal form:
 *
 *   1. 三个字段共用自定义 IngestDropdown 列表框（不再有原生 <select> 的
 *      OS 绘制弹层）：目标归属项目 = 项目 id 选项；归属大标签 = 项目
 *      tagTree 键 ∪ defaultTags（去重、顺序稳定；跨项目切换时刷新，非法旧值
 *      重置为第一项；项目没有任何大标签时禁用并给出明确提示，不退回自由输入）。
 *   2. 小标签 = 同一个 IngestDropdown（选项来自 `/project-hub/state` 的
 *      `tagTree[大标签]` 数组，该数组由 `listProjectsWithDocs` 从
 *      `.dsh-hub/docs/<大标签>/*.md` 推导），菜单底部带「＋ 新建小标签」动作，
 *      可新建全新小标签（对话框确认后与选择已有项走同一个 onChange 值通道）。
 *   3. 主按钮（`.dsh-ph-btn-primary`：确认归档入库 / 创建项目 / 启动会话 /
 *      抽屉内「确认移出」）的文字可见性：不依赖任何"可能不存在"的 label token，
 *      而是测量按钮 computed 背景的亮度后确定性地选择近黑或近白文字。
 *      测试直接喂 `rgb(249, 250, 251)` 近白底与深色底给它，断言选出的文字色
 *      达到 WCAG 对比度（>= 4.5），并断言四个主按钮都接上了测量逻辑。
 *
 * The client factory is evaluated with a tiny React stub whose `useState`
 * keeps state between manual re-renders, so project/big-tag switches can be
 * driven the same way a browser would.
 *
 * Run directly:  node test/ingest-form.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createProject, initProjectRegistry, listProjectsWithDocs } from '../lib/doc-manager.js'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const TEST_ROOT = fileURLToPath(new URL('./.tmp-ingest-form', import.meta.url))

// ── React stub with persistent hook state (manual re-render) ────────────────

function createClientHarness() {
  const loads = []
  const stateStore = []
  let hookIndex = 0

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in stateStore)) {
        stateStore[index] = typeof initial === 'function' ? initial() : initial
      }
      return [
        stateStore[index],
        (next) => {
          stateStore[index] = typeof next === 'function' ? next(stateStore[index]) : next
        },
      ]
    },
    useEffect() {},
    useRef(value) {
      return { current: value === undefined ? null : value }
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }
  const reactDom = {
    createRoot() {
      return { render() {}, unmount() {} }
    },
    render() {},
  }

  const computedStyles = new Map()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          loads.push(registration)
        },
      },
      // Fake `getComputedStyle`: tests register a computed background per fake
      // button; the default is "transparent" (unmeasurable).
      getComputedStyle(element) {
        return computedStyles.get(element) || { backgroundColor: 'rgba(0, 0, 0, 0)' }
      },
    },
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    console,
  }
  vm.createContext(sandbox)
  new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInContext(sandbox)
  assert.equal(loads.length, 1, 'client bundle must register exactly one module')
  assert.equal(loads[0].id, 'dsh-project-hub')

  const requireStub = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return reactDom
    if (name === 'react-dom/client') return { createRoot: reactDom.createRoot }
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  }

  const client = loads[0].factory(requireStub)
  const api = client.__test__
  assert.ok(api && typeof api.IngestSessionsModal === 'function', 'ingest modal must be exposed through __test__')
  assert.ok(typeof api.IngestDropdown === 'function', 'the custom dropdown must be exposed through __test__')

  return {
    client,
    api,
    /** Forget hook state (fresh mount of the modal). */
    resetForm() {
      stateStore.length = 0
      hookIndex = 0
    },
    /** Re-render the ingest modal; hook state survives between calls. */
    render(props) {
      hookIndex = 0
      return api.IngestSessionsModal(props)
    },
    /** Render any other exported function component (fresh hook state). */
    renderComponent(component, props) {
      stateStore.length = 0
      hookIndex = 0
      return component(props)
    },
    /** Give one fake element the computed style the browser would report. */
    setComputedStyle(element, style) {
      computedStyles.set(element, style)
    },
  }
}

// ── Tiny element-tree helpers (the stub returns plain React-element objects) ──

function collectElements(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, out)
    return out
  }
  if (node.type !== undefined) out.push(node)
  for (const child of node.children || []) collectElements(child, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

function findById(tree, id) {
  return collectElements(tree).find((element) => element.props && element.props.id === id) || null
}

function findByButtonText(tree, label) {
  return (
    collectElements(tree).find((element) => element.type === 'button' && textOf(element).trim() === label) || null
  )
}

/** Options carried by one IngestDropdown element (strings or `{ value }`). */
function dropdownValues(dropdownElement) {
  // The component runs inside the vm realm, so copy into a host array before
  // comparing (same reason the tag-option helpers use Array.from above).
  const values = []
  if (!dropdownElement || !dropdownElement.props) return values
  const options = Array.isArray(dropdownElement.props.options) ? dropdownElement.props.options : []
  for (const option of options) {
    values.push(typeof option === 'string' ? option : option && option.value)
  }
  return values
}

/** Count OS-drawn controls that the custom listbox intentionally replaced. */
function nativePopupControls(tree) {
  return collectElements(tree).filter(
    (element) => element.type === 'select' || element.type === 'datalist',
  )
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SESSIONS = [
  {
    sessionId: 's-1',
    title: '旧会话：时间轴对齐',
    updatedAt: Date.now() - 60_000,
    changedFiles: 2,
    cwd: 'C:\\work\\alpha',
  },
]

const ALPHA = {
  id: 'alpha',
  name: '项目甲',
  tagTree: {
    '[Media-多媒体渲染]': [{ smallTag: '音画时间轴对齐' }, { smallTag: '渲染管线' }],
    '[UI-交互界面]': [],
  },
  defaultTags: ['[Media-多媒体渲染]', '[Core-业务核心]'],
}

const BETA = {
  id: 'beta',
  name: '项目乙',
  tagTree: { 'Physics-物理核心': [{ smallTag: '抓取判定' }] },
  defaultTags: ['Physics-物理核心'],
}

const NO_TAGS = { id: 'empty', name: '空标签项目', tagTree: {}, defaultTags: [] }

function ingestProps(projects, selectedIds = ['s-1']) {
  return {
    projects,
    sessions: SESSIONS,
    selectedIds,
    setSelectedIds: () => {},
    onClose: () => {},
    onDone: () => {},
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test('DSH Project Hub — 归类历史 ingest form: custom listbox + small-tag create', async (t) => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })

  const harness = createClientHarness()
  const api = harness.api

  // The client factory runs inside a Node `vm` realm, so its returned arrays
  // are cross-realm; copy them into host arrays before comparing.
  const bigTagOptions = (project) => Array.from(api.listBigTagOptions(project))
  const smallTagSuggestions = (project, bigTag) => Array.from(api.listSmallTagSuggestions(project, bigTag))

  // ── 1. 大标签 options: tagTree keys ∪ defaultTags, de-duped, stable ──────
  await t.test('大标签选项 = tagTree 键 ∪ defaultTags，去重且顺序稳定', () => {
    const project = {
      tagTree: { 'B-标签': [], 'A-标签': [] },
      defaultTags: ['A-标签', 'C-标签', 'B-标签', 'A-标签', '   ', null],
    }
    assert.deepEqual(
      bigTagOptions(project),
      ['B-标签', 'A-标签', 'C-标签'],
      'tagTree keys first, then defaultTags not already present, first-seen order',
    )
    // tagTree-only project: keys keep their own order.
    assert.deepEqual(bigTagOptions({ tagTree: { Z: [], Y: [] } }), ['Z', 'Y'])
    // defaultTags-only project: registry order is kept.
    assert.deepEqual(bigTagOptions({ defaultTags: ['UI', 'Core', 'UI'] }), ['UI', 'Core'])
    assert.deepEqual(bigTagOptions({}), [])
    assert.deepEqual(bigTagOptions(null), [])
  })

  // ── 2. Project switch: refresh + reset invalid old value to first ────────
  await t.test('切换项目后大标签选项刷新，非法旧值重置为第一项', () => {
    assert.equal(api.resolveBigTagSelection(ALPHA, '[Media-多媒体渲染]'), '[Media-多媒体渲染]', 'valid value kept')
    assert.equal(
      api.resolveBigTagSelection(BETA, '[Media-多媒体渲染]'),
      'Physics-物理核心',
      'value that does not exist in the new project resets to the first option',
    )
    assert.equal(api.resolveBigTagSelection(ALPHA, ''), '[Media-多媒体渲染]', 'empty selection resolves to first option')
    assert.equal(api.resolveBigTagSelection(NO_TAGS, 'anything'), '', 'a project without tags has no legal big tag')
    assert.equal(api.resolveBigTagSelection(null, 'x'), '')
    // Option list also refreshes for the new project.
    assert.deepEqual(bigTagOptions(BETA), ['Physics-物理核心'])
    assert.deepEqual(bigTagOptions(ALPHA), ['[Media-多媒体渲染]', '[UI-交互界面]', '[Core-业务核心]'])
  })

  // ── 3. 小标签 suggestions from tagTree[bigTag] ───────────────────────────
  await t.test('小标签建议来自 tagTree[大标签] 数组，可自定义（仅建议不限制）', () => {
    assert.deepEqual(smallTagSuggestions(ALPHA, '[Media-多媒体渲染]'), ['音画时间轴对齐', '渲染管线'])
    assert.deepEqual(smallTagSuggestions(ALPHA, '[UI-交互界面]'), [], 'empty tagTree children -> no suggestion')
    assert.deepEqual(smallTagSuggestions(BETA, '[Media-多媒体渲染]'), [], 'other project has no such big tag')
    assert.deepEqual(smallTagSuggestions(null, 'x'), [])
    // Defensive: plain strings and duplicates are normalised.
    assert.deepEqual(smallTagSuggestions({ tagTree: { A: ['x', 'y', 'x'] } }, 'A'), ['x', 'y'])
  })

  // ── 4. tagTree children really are derived from docs/*.md on disk ────────
  await t.test('tagTree 子项由 .dsh-hub/docs/<大标签>/ 下实际 MD 文件推导', () => {
    initProjectRegistry(TEST_ROOT)
    createProject(TEST_ROOT, { id: 'docs-derived', name: '文档推导项目', defaultTags: ['UI-交互界面'] })
    const docsRoot = join(TEST_ROOT, 'docs-derived', '.dsh-hub', 'docs')
    mkdirSync(join(docsRoot, 'UI-交互界面'), { recursive: true })
    writeFileSync(join(docsRoot, 'UI-交互界面', '已有模块.md'), '# 已有模块\n', 'utf8')
    writeFileSync(join(docsRoot, 'UI-交互界面', '忽略我.txt'), 'not markdown', 'utf8')
    // A big tag that only exists as a docs directory (not in defaultTags).
    mkdirSync(join(docsRoot, 'Audio-音频'), { recursive: true })
    writeFileSync(join(docsRoot, 'Audio-音频', '混音.md'), '# 混音\n', 'utf8')

    const project = listProjectsWithDocs(TEST_ROOT).find((item) => item.id === 'docs-derived')
    assert.ok(project, 'project must be listed by /project-hub/state data')

    const options = bigTagOptions(project)
    assert.ok(options.includes('UI-交互界面'), 'defaultTags key present')
    assert.ok(options.includes('Audio-音频'), 'docs-directory big tag present')
    assert.equal(new Set(options).size, options.length, 'big tag options are de-duplicated')

    assert.deepEqual(smallTagSuggestions(project, 'UI-交互界面'), ['已有模块'])
    assert.deepEqual(smallTagSuggestions(project, 'Audio-音频'), ['混音'])
    assert.ok(
      !smallTagSuggestions(project, 'UI-交互界面').includes('忽略我'),
      'non-markdown files are not small-tag suggestions',
    )
  })

  // ── 5. Custom themed listbox: all three fields are IngestDropdown ────────
  await t.test('三个字段都是自定义 IngestDropdown（无原生 select/datalist），大标签仅可选、小标签可新建', () => {
    harness.resetForm()
    const tree = harness.render(ingestProps([ALPHA, BETA, NO_TAGS]))

    const projectField = findById(tree, 'dsh-ph-ingest-project')
    assert.ok(projectField, 'target-project control exists')
    assert.equal(projectField.type, api.IngestDropdown, 'project is a custom listbox, not a native <select>')
    assert.equal(projectField.props.value, 'alpha')
    assert.deepEqual(dropdownValues(projectField), ['alpha', 'beta', 'empty'])
    assert.equal(Boolean(projectField.props.allowCreate), false, 'project field is choose-only')

    const bigField = findById(tree, 'dsh-ph-ingest-big-tag')
    assert.ok(bigField, 'big-tag control exists')
    assert.equal(bigField.type, api.IngestDropdown)
    assert.equal(bigField.props.disabled, false)
    assert.deepEqual(dropdownValues(bigField), [
      '[Media-多媒体渲染]',
      '[UI-交互界面]',
      '[Core-业务核心]',
    ])
    assert.equal(
      bigField.props.value,
      '[Media-多媒体渲染]',
      'initial value is the first real project tag (no hard-coded example)',
    )
    assert.equal(Boolean(bigField.props.allowCreate), false, 'big-tag field stays choose-only')

    const smallField = findById(tree, 'dsh-ph-ingest-small-tag')
    assert.ok(smallField, 'small-tag control exists')
    assert.equal(smallField.type, api.IngestDropdown, 'small tag uses the SAME custom listbox')
    assert.equal(smallField.props.allowCreate, true, 'small-tag menu adds the 新建 action row')
    assert.equal(Boolean(smallField.props.disabled), false)
    assert.deepEqual(dropdownValues(smallField), ['音画时间轴对齐', '渲染管线'])
    assert.equal(smallField.props.createTitle, '新建小标签')
    assert.ok(String(smallField.props.createContext).includes('项目甲'), 'dialog context names the project')
    assert.ok(String(smallField.props.createContext).includes('[Media-多媒体渲染]'), 'dialog context names the big tag')

    // No OS-drawn controls are left anywhere in the ingest modal.
    assert.deepEqual(nativePopupControls(tree), [], 'no native <select>/<datalist> popup remains')

    const submit = findById(tree, 'dsh-ph-ingest-submit')
    assert.ok(submit && submit.type === 'button')
    assert.equal(textOf(submit), '确认归档入库')
    assert.ok(String(submit.props.className).includes('dsh-ph-btn-primary'))
  })

  // ── 6. Listbox-driven interactions: refresh / keep / reset ───────────────
  await t.test('切换大标签刷新小标签选项且不清空已选/新建值；切换项目重置非法大标签', () => {
    harness.resetForm()
    const props = ingestProps([ALPHA, BETA, NO_TAGS])
    let tree = harness.render(props)

    const bigField = () => findById(tree, 'dsh-ph-ingest-big-tag')
    const smallField = () => findById(tree, 'dsh-ph-ingest-small-tag')

    // Selecting the UI big tag goes through the listbox onChange (same channel
    // as clicking an option row): small-tag options refresh to the UI children.
    bigField().props.onChange('[UI-交互界面]')
    tree = harness.render(props)
    assert.equal(bigField().props.value, '[UI-交互界面]')
    assert.deepEqual(dropdownValues(smallField()), [])

    // A brand-new small tag: the 新建 dialog confirms through the SAME onChange.
    smallField().props.onChange('全新的小标签')
    tree = harness.render(props)
    assert.equal(smallField().props.value, '全新的小标签')
    assert.equal(
      findById(tree, 'dsh-ph-ingest-submit').props.disabled,
      false,
      'created small tag + valid big tag + selected session enables 确认归档',
    )

    // Switch back to the Media big tag: options refresh, created value stays.
    bigField().props.onChange('[Media-多媒体渲染]')
    tree = harness.render(props)
    assert.deepEqual(dropdownValues(smallField()), ['音画时间轴对齐', '渲染管线'])
    assert.equal(
      smallField().props.value,
      '全新的小标签',
      'switching the big tag must not clear the selected/created small tag',
    )

    // Switch the target project: options refresh and the old big tag (not in
    // the new project) resets to the new project's first tag.
    findById(tree, 'dsh-ph-ingest-project').props.onChange('beta')
    tree = harness.render(props)
    const refreshedBig = bigField()
    assert.deepEqual(dropdownValues(refreshedBig), ['Physics-物理核心'])
    assert.equal(refreshedBig.props.value, 'Physics-物理核心', 'stale big tag resets to first option')
    assert.deepEqual(dropdownValues(smallField()), ['抓取判定'])
  })

  // ── 7. Project without any big tag: disabled listbox + explicit hint ─────
  await t.test('项目没有大标签时禁用 listbox 并给明确提示，不退回自由输入', () => {
    harness.resetForm()
    const tree = harness.render(ingestProps([NO_TAGS]))

    const bigField = findById(tree, 'dsh-ph-ingest-big-tag')
    assert.ok(bigField)
    assert.equal(bigField.type, api.IngestDropdown)
    assert.equal(bigField.props.disabled, true, 'big-tag listbox is disabled')
    assert.equal(bigField.props.value, '')
    assert.deepEqual(dropdownValues(bigField), [])
    assert.ok(
      String(bigField.props.placeholder).includes('该项目还没有大标签，请先在新建项目时定义'),
      'the disabled trigger itself explains why',
    )

    const hintText = collectElements(tree)
      .filter((element) => String(element.props && element.props.className) === 'dsh-ph-hint')
      .map(textOf)
      .join('\n')
    assert.ok(hintText.includes('请先在新建项目时定义'), 'a visible hint explains what to do')
    assert.ok(hintText.includes('不会退回自由输入'), 'explicitly no free-form big-tag fallback')

    assert.equal(findById(tree, 'dsh-ph-ingest-submit').props.disabled, true, 'cannot submit without a big tag')

    const smallField = findById(tree, 'dsh-ph-ingest-small-tag')
    assert.equal(smallField.type, api.IngestDropdown, 'small tag is the same custom listbox')
    assert.deepEqual(dropdownValues(smallField), [])
    assert.equal(smallField.props.allowCreate, true, 'the 新建 path stays available')

    // Render the disabled custom trigger itself: combobox that paints the
    // explanation instead of an OS-drawn disabled <select>.
    harness.resetForm()
    const triggerTree = harness.renderComponent(api.IngestDropdown, {
      id: 'dsh-ph-ingest-big-tag',
      value: '',
      options: [],
      disabled: true,
      placeholder: bigField.props.placeholder,
    })
    const trigger = findById(triggerTree, 'dsh-ph-ingest-big-tag')
    assert.ok(trigger && trigger.type === 'button', 'the trigger is a themed button, not a <select>')
    assert.equal(trigger.props.disabled, true)
    assert.equal(trigger.props.role, 'combobox')
    assert.ok(textOf(trigger).includes('该项目还没有大标签'))
  })

  // ── 8. 主按钮文字对比度：实测背景亮度决定 label 颜色（不再猜 token） ─────
  await t.test('主按钮文字色由实测背景亮度决定（近白→深色、深色→浅色）', () => {
    const api = harness.api
    const lightBackground = 'rgb(249, 250, 251)'
    const darkBackground = 'rgb(24, 25, 30)'

    // Parser/contrast sanity (the formats a real `getComputedStyle` can return).
    assert.equal(api.contrastRatio('#000000', '#ffffff'), 21)
    assert.equal(api.pickReadableTextColor('#f9fafb'), api.PRIMARY_TEXT_DARK)
    assert.equal(api.pickReadableTextColor('rgba(249, 250, 251, 1)'), api.PRIMARY_TEXT_DARK)
    assert.equal(api.pickReadableTextColor('color(srgb 0.976 0.98 0.984)'), api.PRIMARY_TEXT_DARK)
    assert.equal(api.pickReadableTextColor('rgb(9.4% 9.8% 10.2%)'), api.PRIMARY_TEXT_LIGHT)

    // (a) Pure decision: the candidate with the HIGHER WCAG contrast wins.
    const lightLabel = api.pickReadableTextColor(lightBackground)
    assert.equal(lightLabel, api.PRIMARY_TEXT_DARK, 'near-white fill must get a near-black label')
    assert.ok(
      api.contrastRatio(lightBackground, lightLabel) >= 4.5,
      'near-white fill: the chosen label must reach WCAG AA contrast',
    )

    const darkLabel = api.pickReadableTextColor(darkBackground)
    assert.equal(darkLabel, api.PRIMARY_TEXT_LIGHT, 'dark fill must get a near-white label')
    assert.ok(
      api.contrastRatio(darkBackground, darkLabel) >= 4.5,
      'dark fill: the chosen label must reach WCAG AA contrast',
    )

    // (b) The real measurement path used by the buttons (ref callback):
    //     getComputedStyle -> backgroundColor -> inline style.color.
    const lightButton = { style: {} }
    harness.setComputedStyle(lightButton, { backgroundColor: lightBackground })
    assert.equal(api.applyReadablePrimaryText(lightButton), api.PRIMARY_TEXT_DARK)
    assert.equal(lightButton.style.color, api.PRIMARY_TEXT_DARK)
    assert.ok(api.contrastRatio(lightBackground, lightButton.style.color) >= 4.5)

    const darkButton = { style: {} }
    harness.setComputedStyle(darkButton, { backgroundColor: darkBackground })
    assert.equal(api.applyReadablePrimaryText(darkButton), api.PRIMARY_TEXT_LIGHT)
    assert.equal(darkButton.style.color, api.PRIMARY_TEXT_LIGHT)
    assert.ok(api.contrastRatio(darkBackground, darkButton.style.color) >= 4.5)

    // (c) Hover: the shell only swaps the background, so the same measurement
    //     must re-derive a readable label for the hover fill.
    harness.setComputedStyle(lightButton, { backgroundColor: 'rgb(235, 238, 242)' })
    assert.equal(api.applyReadablePrimaryText(lightButton), api.PRIMARY_TEXT_DARK, 'near-white hover stays dark')
    harness.setComputedStyle(lightButton, { backgroundColor: 'rgb(37, 99, 235)' })
    const hoverLabel = api.applyReadablePrimaryText(lightButton)
    assert.ok(
      api.contrastRatio('rgb(37, 99, 235)', hoverLabel) >= 4,
      'blue hover fill must get a readable label too',
    )

    // (d) Translucent / unparsable fills cannot be reasoned about -> neutral
    //     high-contrast fallback (same background/border/label as 「取消」),
    //     never a white-on-white guess.
    assert.equal(api.pickReadableTextColor('rgba(255, 255, 255, 0.4)'), null)
    assert.equal(api.pickReadableTextColor('color-mix(in srgb, red, blue)'), null)
    const fallbackButton = { style: {} }
    assert.equal(api.applyReadablePrimaryText(fallbackButton), null)
    assert.equal(fallbackButton.style.background, 'transparent')
    assert.equal(fallbackButton.style.color, api.PRIMARY_TEXT_FALLBACK)
    assert.match(fallbackButton.style.color, /--dsw-alias-label-primary/)

    // (e) The stylesheet must not delegate the primary label to ANY token.
    const primaryRule = /\.dsh-ph-btn-primary\s*\{([\s\S]*?)\}/.exec(SOURCE)
    assert.ok(primaryRule, '.dsh-ph-btn-primary rule exists')
    assert.doesNotMatch(primaryRule[1], /(?:^|[;\s])color\s*:/, 'CSS must not set the primary label colour')
    assert.doesNotMatch(SOURCE, /var\(--dsw-alias-label-primary-foreground/)
    assert.doesNotMatch(SOURCE, /var\(--dsw-alias-button-primary-label/)
    assert.match(SOURCE, /\.dsh-ph-btn:disabled\s*\{[^}]*opacity:\s*0\.55/, 'disabled state stays visible')
  })

  // ── 9. All primary buttons share the deterministic contrast wiring ───────
  await t.test('四个 dsh-ph-btn-primary 按钮全部接入确定性对比逻辑', () => {
    const api = harness.api

    const renderedPrimaryButtons = []
    harness.resetForm()
    let tree = harness.renderComponent(api.NewProjectModal, { onClose: () => {}, onCreated: () => {} })
    renderedPrimaryButtons.push(['创建项目', findByButtonText(tree, '创建项目')])

    harness.resetForm()
    tree = harness.render(ingestProps([ALPHA, BETA, NO_TAGS]))
    renderedPrimaryButtons.push(['确认归档入库', findByButtonText(tree, '确认归档入库')])

    harness.resetForm()
    tree = harness.renderComponent(api.ProjectTaskModal, {
      project: ALPHA,
      globalRoot: 'C:\\work',
      onClose: () => {},
    })
    renderedPrimaryButtons.push(['启动会话', findByButtonText(tree, '启动会话')])

    for (const [label, button] of renderedPrimaryButtons) {
      assert.ok(button, `${label} button must render`)
      assert.equal(button.props.type, 'button')
      assert.ok(
        String(button.props.className).includes(api.PRIMARY_BUTTON_CLASS),
        `${label} must carry the primary class`,
      )
      assert.equal(
        button.props.ref,
        api.primaryButtonRef,
        `${label} must measure its computed background after mount`,
      )
      assert.equal(typeof button.props.onMouseEnter, 'function', `${label} must re-derive on hover`)
      assert.equal(typeof button.props.onMouseLeave, 'function', `${label} must restore on hover leave`)
    }

    // Drive the actual wiring of one rendered primary button: mount (ref),
    // hover (near-white -> dark label), then hover-leave (restore).
    const ingestButton = renderedPrimaryButtons[1][1]
    const fakeNode = { style: {} }
    harness.setComputedStyle(fakeNode, { backgroundColor: 'rgb(249, 250, 251)' })
    assert.equal(
      ingestButton.props.ref(fakeNode),
      undefined,
      'callback ref must return nothing (React cleanup-function contract)',
    )
    assert.equal(fakeNode.style.color, api.PRIMARY_TEXT_DARK, 'mount: near-white fill -> dark label')
    harness.setComputedStyle(fakeNode, { backgroundColor: 'rgb(24, 25, 30)' })
    ingestButton.props.onMouseEnter({ currentTarget: fakeNode })
    assert.equal(fakeNode.style.color, api.PRIMARY_TEXT_LIGHT, 'hover: dark fill -> light label')
    harness.setComputedStyle(fakeNode, { backgroundColor: 'rgb(249, 250, 251)' })
    ingestButton.props.onMouseLeave({ currentTarget: fakeNode })
    assert.equal(fakeNode.style.color, api.PRIMARY_TEXT_DARK, 'hover-leave restores the readable label')

    // The fourth primary button (「移出列表」内联确认的「确认移出」) lives in the
    // drawer; structurally prove every primary button goes through the helper:
    // the class literal exists once (the constant) and the helper is used by
    // exactly the four primary buttons (3 modals + 移出确认).
    assert.equal(
      (SOURCE.match(/dsh-ph-btn dsh-ph-btn-primary/g) || []).length,
      1,
      'the primary class literal must live only in PRIMARY_BUTTON_CLASS',
    )
    assert.equal(
      (SOURCE.match(/primaryButtonProps\(\{/g) || []).length,
      4,
      'all four primary buttons (3 modals + 移出确认) must use primaryButtonProps',
    )
  })

  // ── 10. 「启动会话」会话模式：标准模式 / Computer Use 模式（都完全权限） ──
  await t.test('启动会话 modal offers 标准模式 / Computer Use 模式, defaulting to 标准模式', () => {
    const api = harness.api

    // Host catalog advertises both modes (the dsh-orb computer-use preset is
    // installed in the desktop profile this bundle ships with).
    harness.resetForm()
    let tree = harness.renderComponent(api.ProjectTaskModal, {
      project: ALPHA,
      globalRoot: 'C:\\work',
      onClose: () => {},
      agentModes: [
        { id: 'standard', name: '标准模式', description: '常规开发 / 文档会话。', available: true },
        { id: 'computer-use', name: 'Computer Use 模式', description: '桌面 GUI 操作。', available: true },
      ],
    })
    const standardButton = findById(tree, 'dsh-ph-task-mode-standard')
    const computerButton = findById(tree, 'dsh-ph-task-mode-computer-use')
    assert.ok(standardButton, '标准模式 button renders')
    assert.ok(computerButton, 'Computer Use 模式 button renders')
    assert.equal(standardButton.props['aria-pressed'], 'true', '标准模式 is the default selection')
    assert.equal(computerButton.props['aria-pressed'], 'false', 'Computer Use starts unselected')
    assert.equal(typeof computerButton.props.onClick, 'function', 'Computer Use is selectable')
    assert.ok(
      textOf(tree).includes('完全权限'),
      'the form states both modes start with full permissions',
    )

    // No Host catalog yet (older Host) -> only 标准模式; Computer Use is hidden.
    harness.resetForm()
    tree = harness.renderComponent(api.ProjectTaskModal, {
      project: ALPHA,
      globalRoot: 'C:\\work',
      onClose: () => {},
    })
    assert.ok(findById(tree, 'dsh-ph-task-mode-standard'), 'fallback keeps 标准模式')
    assert.equal(findById(tree, 'dsh-ph-task-mode-computer-use'), null, 'no phantom Computer Use mode')

    // Unavailable modes are filtered out of the catalog.
    assert.deepEqual(
      Array.from(api.normalizeTaskModes([
        { id: 'standard', name: '标准模式', available: true },
        { id: 'computer-use', name: 'Computer Use 模式', available: false },
      ])).map((mode) => mode.id),
      ['standard'],
      'unavailable modes never render',
    )
    assert.deepEqual(
      Array.from(api.normalizeTaskModes(undefined)).map((mode) => mode.id),
      ['standard'],
      'a missing catalog falls back to 标准模式',
    )
    assert.deepEqual(
      Array.from(api.normalizeTaskModes([])).map((mode) => mode.id),
      ['standard'],
      'an empty catalog falls back to 标准模式',
    )
  })

  // Cleanup
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
})
