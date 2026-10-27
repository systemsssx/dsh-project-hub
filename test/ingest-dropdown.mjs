/**
 * dsh-project-hub — test/ingest-dropdown.mjs
 *
 * Tests for the custom themed dropdown that replaced the OS-drawn native
 * <select> popup inside the 「归类历史」 ingest modal (user feedback:
 * "这个下箭号点下去的这个选项框太粗糙了"), plus the nested 「新建小标签」 dialog
 * of the 归属小标签 field.
 *
 * Covered:
 *   1. Trigger = themed button (role=combobox, aria-haspopup=listbox,
 *      aria-expanded/aria-controls, .dsh-ph-input + .dsh-ph-select skin), value
 *      ellipsis text, tertiary placeholder, disabled = non-interactive.
 *   2. Open menu = position:fixed listbox above the modal (z-index 10020) with
 *      role=option rows, selected row highlighted + monochrome ✓ check.
 *   3. Click an option -> onChange(value) and menu closes.
 *   4. Dismiss wiring (`bindDropdownDismiss`): outside pointerdown, captured
 *      Escape (stopPropagation so the modal stays), resize, page scroll; a
 *      scroll INSIDE the menu does not close it.
 *   5. Keyboard: Enter/Space/ArrowDown open, ArrowUp/Down move, Enter selects,
 *      Escape closes.
 *   6. 小标签 menu = existing options + divider + 「＋ 新建小标签」 action row.
 *   7. The action opens the nested NewSmallTagDialog (context: project + big tag).
 *   8. Dialog: inline role=alert required error, Enter confirms, 确定 confirms
 *      trimmed name, Esc/backdrop close ONLY the dialog (capture +
 *      stopPropagation), never the ingest modal.
 *   9. Injected stylesheet rule-block assertions (fixed listbox, themed surface
 *      tokens, shadow, scrollbar, option hover, selected check colour, dialog
 *      layering/error colour) — not just class presence.
 *  10. Token allow-list: every `--dsw-*` token used by client.js exists in
 *      test/dsw-token-manifest.json.
 *  11. IngestSessionsModal integration: all three fields are IngestDropdown and
 *      the real 小标签 props drive the 新建 flow.
 *
 * Run directly:  node test/ingest-dropdown.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const MANIFEST = JSON.parse(readFileSync(new URL('./dsw-token-manifest.json', import.meta.url), 'utf8'))

// ── Fake DOM (only what ensureStyles() uses) ────────────────────────────────

function createFakeDocument() {
  const byId = new Map()
  const head = {
    appendChild(element) {
      if (element && element.id) byId.set(element.id, element)
      return element
    },
  }
  return {
    head,
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), id: '', textContent: '', style: {} }
    },
    getElementById(id) {
      return byId.get(String(id)) || null
    },
  }
}

// ── Fake window for the dismiss-listener helpers ────────────────────────────

function createFakeWindow() {
  const listeners = Object.create(null)
  return {
    listeners,
    addEventListener(type, listener, options) {
      ;(listeners[type] || (listeners[type] = [])).push({ listener, options })
    },
    removeEventListener(type, listener) {
      const list = listeners[type] || []
      const index = list.findIndex((entry) => entry.listener === listener)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type, event) {
      for (const entry of [...(listeners[type] || [])]) entry.listener(event)
    },
    count(type) {
      return (listeners[type] || []).length
    },
  }
}

// ── Harness: client bundle + stub React with persistent hook state ─────────

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

  const documentStub = createFakeDocument()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          loads.push(registration)
        },
      },
      __DSH_TRANSPORT__: { streamBaseUrl: 'http://127.0.0.1:9999' },
    },
    document: documentStub,
    URL,
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    console,
    fetch: async () => {
      throw new Error('unexpected network call in the dropdown unit test')
    },
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
  assert.ok(typeof api.IngestDropdown === 'function', 'IngestDropdown must be exposed through __test__')
  assert.ok(typeof api.NewSmallTagDialog === 'function', 'NewSmallTagDialog must be exposed through __test__')

  return {
    client,
    api,
    /** Forget hook state (fresh mount). */
    resetForm() {
      stateStore.length = 0
      hookIndex = 0
    },
    /** Render a component once, with fresh hook state. */
    renderComponent(component, props) {
      stateStore.length = 0
      hookIndex = 0
      return component(props)
    },
    /** Re-render IngestDropdown; hook state survives between calls. */
    renderDropdown(props) {
      hookIndex = 0
      return api.IngestDropdown(props)
    },
    /** Re-render NewSmallTagDialog; hook state survives between calls. */
    renderDialog(props) {
      hookIndex = 0
      return api.NewSmallTagDialog(props)
    },
    /** The stylesheet that ensureStyles() really injected. */
    stylesheet() {
      api.ensureStyles()
      return documentStub.getElementById('dsh-project-hub-styles')
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

function findByRole(tree, role) {
  return collectElements(tree).find((element) => element.props && element.props.role === role) || null
}

function findAllByRole(tree, role) {
  return collectElements(tree).filter((element) => element.props && element.props.role === role)
}

function findByClass(tree, className) {
  return (
    collectElements(tree).find(
      (element) => typeof element.type === 'string' && String(element.props && element.props.className).split(/\s+/).includes(className),
    ) || null
  )
}

/** Any OS-drawn popup controls left in the tree (must always be zero). */
function nativePopupControls(tree) {
  const found = []
  for (const element of collectElements(tree)) {
    if (element.type === 'select' || element.type === 'datalist') found.push(element)
  }
  return found
}

/** Body of the FIRST rule whose selector header matches `pattern`. */
function ruleBody(css, pattern) {
  const match = pattern.exec(css)
  assert.ok(match, `stylesheet must contain a rule matching ${pattern}`)
  return match[1]
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALPHA = {
  id: 'alpha',
  name: '项目甲',
  tagTree: {
    '[Media-多媒体渲染]': [{ smallTag: '音画时间轴对齐' }, { smallTag: '渲染管线' }],
    '[UI-交互界面]': [],
  },
  defaultTags: ['[Media-多媒体渲染]', '[Core-业务核心]'],
}

const SESSION = {
  sessionId: 's-1',
  title: '旧会话：时间轴对齐',
  updatedAt: Date.now() - 60_000,
  changedFiles: 2,
  cwd: 'C:\\work\\alpha',
}

const DROPDOWN_OPTIONS = ['选项一', '选项二', '选项三']

function dropdownProps(overrides = {}) {
  return Object.assign(
    {
      id: 'dsh-ph-test-dropdown',
      value: '选项一',
      options: DROPDOWN_OPTIONS,
      onChange: () => {},
    },
    overrides,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test('DSH Project Hub — custom themed dropdown + 新建小标签 dialog', async (t) => {
  const harness = createClientHarness()
  const api = harness.api

  // ── 1. Trigger: themed combobox button, value/placeholder, disabled ─────
  await t.test('trigger 是主题化 combobox 按钮（值/占位符/禁用非交互），不再是原生 select', () => {
    harness.resetForm()
    const props = dropdownProps()
    let tree = harness.renderDropdown(props)

    assert.deepEqual(nativePopupControls(tree), [], 'no native <select> is rendered')

    const trigger = findById(tree, props.id)
    assert.ok(trigger, 'trigger carries the field id (dsh-ph-ingest-*)')
    assert.equal(trigger.type, 'button', 'trigger is a button, not a <select>')
    assert.equal(trigger.props.role, 'combobox')
    assert.equal(trigger.props['aria-haspopup'], 'listbox')
    assert.equal(trigger.props['aria-expanded'], 'false')
    assert.equal(trigger.props['aria-controls'], undefined, 'no aria-controls while closed')
    const triggerClass = String(trigger.props.className)
    assert.ok(triggerClass.includes('dsh-ph-input'), 'trigger keeps the shared input skin')
    assert.ok(triggerClass.includes('dsh-ph-select'), 'trigger keeps the themed chevron skin')
    assert.ok(triggerClass.includes('dsh-ph-dropdown-trigger'))
    assert.equal(textOf(trigger).trim(), '选项一')

    // Click opens (aria-expanded + aria-controls point at the listbox).
    trigger.props.onClick()
    tree = harness.renderDropdown(props)
    const opened = findById(tree, props.id)
    assert.equal(opened.props['aria-expanded'], 'true')
    assert.equal(opened.props['aria-controls'], api.dropdownMenuId(props.id))
    assert.ok(findByRole(tree, 'listbox'), 'the listbox is rendered once open')

    // Placeholder for an empty value, painted in the tertiary label token.
    harness.resetForm()
    const emptyProps = dropdownProps({ id: 'dsh-ph-empty', value: '', placeholder: '请选择目标项目' })
    const emptyTree = harness.renderDropdown(emptyProps)
    const emptyTrigger = findById(emptyTree, emptyProps.id)
    assert.equal(textOf(emptyTrigger).trim(), '请选择目标项目')
    const placeholderSpan = collectElements(emptyTrigger).find(
      (element) => String(element.props && element.props.className).includes('dsh-ph-dropdown-placeholder'),
    )
    assert.ok(placeholderSpan, 'placeholder span carries the tertiary-colour class')

    // Disabled: non-interactive, no menu, no change event.
    harness.resetForm()
    const changes = []
    const disabledProps = dropdownProps({
      id: 'dsh-ph-disabled',
      value: '',
      options: [],
      disabled: true,
      onChange: (value) => changes.push(value),
    })
    tree = harness.renderDropdown(disabledProps)
    const disabledTrigger = findById(tree, disabledProps.id)
    assert.equal(disabledTrigger.props.disabled, true)
    disabledTrigger.props.onClick()
    disabledTrigger.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
    tree = harness.renderDropdown(disabledProps)
    assert.equal(findByRole(tree, 'listbox'), null, 'a disabled trigger never opens the menu')
    assert.equal(changes.length, 0, 'a disabled trigger never emits a change')
  })

  // ── 2. Open menu: fixed listbox, option rows, selected highlight + ✓ ────
  await t.test('打开的菜单是 position:fixed 的 listbox（浮在弹窗之上），选中行高亮 + 单色 ✓', () => {
    harness.resetForm()
    const props = dropdownProps({ value: '选项二' })
    let tree = harness.renderDropdown(props)
    findById(tree, props.id).props.onClick()
    tree = harness.renderDropdown(props)

    const menu = findByRole(tree, 'listbox')
    assert.ok(menu, 'listbox rendered')
    assert.equal(menu.props.id, api.dropdownMenuId(props.id))
    assert.equal(menu.props.style.position, 'fixed', 'fixed so it escapes .dsh-ph-card overflow:hidden')
    assert.equal(menu.props.style.zIndex, 10020, 'layers above the modal backdrop')
    assert.equal(typeof menu.props.style.left, 'string')
    assert.equal(typeof menu.props.style.top, 'string')
    assert.equal(typeof menu.props.style.width, 'string')
    assert.equal(typeof menu.props.style.maxHeight, 'string')

    const rows = findAllByRole(tree, 'option')
    assert.equal(rows.length, 3, 'one role=option row per option')
    const selected = rows[1]
    assert.equal(selected.props['aria-selected'], 'true')
    assert.ok(String(selected.props.className).includes('is-selected'), 'selected row is highlighted')
    const check = collectElements(selected).find(
      (element) => String(element.props && element.props.className).includes('dsh-ph-dropdown-check'),
    )
    assert.ok(check, 'selected row shows a check glyph')
    assert.equal(textOf(check), '✓', 'the check is the monochrome ✓ glyph (no emoji)')
    assert.equal(collectElements(selected).filter((element) => textOf(element) === '✓').length >= 1, true)

    assert.deepEqual(nativePopupControls(tree), [], 'still no native popup')
  })

  // ── 3. Option click selects + closes ────────────────────────────────────
  await t.test('点击选项回传值并关闭菜单', () => {
    harness.resetForm()
    const changes = []
    const props = dropdownProps({ onChange: (value) => changes.push(value) })
    let tree = harness.renderDropdown(props)
    findById(tree, props.id).props.onClick()
    tree = harness.renderDropdown(props)
    const rows = findAllByRole(tree, 'option')
    rows[2].props.onClick()
    tree = harness.renderDropdown(props)

    assert.deepEqual(changes, ['选项三'], 'onChange fires with the clicked option value')
    assert.equal(findByRole(tree, 'listbox'), null, 'menu closes after selection')
    assert.equal(findById(tree, props.id).props['aria-expanded'], 'false')
  })

  // ── 4. Dismiss wiring: outside pointerdown / Escape / resize / scroll ───
  await t.test('外部 pointerdown / 捕获阶段 Esc / resize / scroll 关闭；菜单内部滚动不关闭', () => {
    const fakeWindow = createFakeWindow()
    const inside = { kind: 'menu-or-trigger' }
    const outside = { kind: 'page' }
    let closed = 0
    const unsubscribe = api.bindDropdownDismiss(
      {
        isInside: (target) => target === inside,
        onClose: () => {
          closed += 1
        },
      },
      fakeWindow,
    )

    assert.equal(fakeWindow.count('pointerdown'), 1)
    assert.equal(fakeWindow.count('keydown'), 1)
    assert.equal(fakeWindow.count('resize'), 1)
    assert.equal(fakeWindow.count('scroll'), 1)
    // Capture phase for pointerdown/keydown/scroll so the modal cannot pre-empt.
    assert.equal(fakeWindow.listeners.pointerdown[0].options, true)
    assert.equal(fakeWindow.listeners.keydown[0].options, true)
    assert.equal(fakeWindow.listeners.scroll[0].options, true)

    fakeWindow.dispatch('pointerdown', { target: inside })
    assert.equal(closed, 0, 'pointerdown on the trigger/menu does not close')

    fakeWindow.dispatch('pointerdown', { target: outside })
    assert.equal(closed, 1, 'outside pointerdown closes the menu')

    fakeWindow.dispatch('keydown', { key: 'ArrowDown', stopPropagation() {}, preventDefault() {} })
    assert.equal(closed, 1, 'non-Escape keys are ignored')

    let stopped = 0
    let prevented = 0
    fakeWindow.dispatch('keydown', {
      key: 'Escape',
      stopPropagation() {
        stopped += 1
      },
      preventDefault() {
        prevented += 1
      },
    })
    assert.equal(closed, 2, 'Escape closes the menu')
    assert.equal(stopped, 1, 'Escape is stopped in capture phase so the modal stays open')
    assert.equal(prevented, 1)

    fakeWindow.dispatch('resize', {})
    assert.equal(closed, 3, 'resize closes the menu')

    fakeWindow.dispatch('scroll', { target: inside })
    assert.equal(closed, 3, 'scrolling INSIDE the menu keeps it open')
    fakeWindow.dispatch('scroll', { target: outside })
    assert.equal(closed, 4, 'scrolling the page closes the menu')

    unsubscribe()
    assert.equal(fakeWindow.count('pointerdown'), 0, 'unsubscribe removes every listener')
    assert.equal(fakeWindow.count('keydown'), 0)
    assert.equal(fakeWindow.count('resize'), 0)
    assert.equal(fakeWindow.count('scroll'), 0)

    // The component really wires it (and only while open).
    assert.match(SOURCE, /bindDropdownDismiss\(\{/)
    assert.match(SOURCE, /if \(!open\) return undefined/)
  })

  // ── 5. Keyboard interaction ─────────────────────────────────────────────
  await t.test('键盘：Enter/Space/ArrowDown 打开，↑↓ 移动，Enter 选择，Esc 关闭', () => {
    harness.resetForm()
    const changes = []
    const props = dropdownProps({ id: 'dsh-ph-keyboard', onChange: (value) => changes.push(value) })
    let tree = harness.renderDropdown(props)
    const trigger = () => findById(tree, props.id)
    const press = (key, extra) => {
      trigger().props.onKeyDown(Object.assign({ key, preventDefault() {}, stopPropagation() {} }, extra))
    }

    // Enter opens (active row = current selection).
    press('Enter')
    tree = harness.renderDropdown(props)
    assert.equal(trigger().props['aria-expanded'], 'true', 'Enter opens the listbox')
    let rows = findAllByRole(tree, 'option')
    assert.ok(String(rows[0].props.className).includes('is-active'), 'current selection is the active row')

    press('ArrowDown')
    tree = harness.renderDropdown(props)
    rows = findAllByRole(tree, 'option')
    assert.ok(String(rows[1].props.className).includes('is-active'), 'ArrowDown moves the active row')

    press('ArrowUp')
    tree = harness.renderDropdown(props)
    rows = findAllByRole(tree, 'option')
    assert.ok(String(rows[0].props.className).includes('is-active'), 'ArrowUp moves back')

    press('ArrowDown') // -> 选项二
    tree = harness.renderDropdown(props)
    press('Enter')
    tree = harness.renderDropdown(props)
    assert.deepEqual(changes, ['选项二'], 'Enter selects the active option')
    assert.equal(findByRole(tree, 'listbox'), null, 'menu closes after Enter selection')

    // Space opens as well.
    harness.resetForm()
    tree = harness.renderDropdown(props)
    press(' ')
    tree = harness.renderDropdown(props)
    assert.equal(trigger().props['aria-expanded'], 'true', 'Space opens the listbox')

    // Escape closes and stops propagation (the modal must not close).
    let stopped = 0
    press('Escape', {
      stopPropagation() {
        stopped += 1
      },
    })
    tree = harness.renderDropdown(props)
    assert.equal(findByRole(tree, 'listbox'), null, 'Escape closes the menu')
    assert.equal(stopped, 1, 'trigger Escape stops propagation too')
  })

  // ── 6. 小标签 menu = options + divider + 「＋ 新建小标签」 ────────────────
  await t.test('小标签菜单 = 已有选项 + 分隔线 + 「＋ 新建小标签」动作行', () => {
    harness.resetForm()
    const props = dropdownProps({
      id: 'dsh-ph-ingest-small-tag',
      value: '',
      options: ['已有A', '已有B'],
      allowCreate: true,
    })
    let tree = harness.renderDropdown(props)
    findById(tree, props.id).props.onClick()
    tree = harness.renderDropdown(props)

    const menu = findByRole(tree, 'listbox')
    assert.ok(menu)
    const rows = findAllByRole(tree, 'option')
    assert.equal(rows.length, 2, 'existing small tags are listed as options')

    const createRow = findById(tree, props.id + '-create')
    assert.ok(createRow, 'the menu has the 新建 action row')
    assert.equal(createRow.type, 'button')
    assert.ok(String(createRow.props.className).includes('dsh-ph-dropdown-create'))
    assert.ok(textOf(createRow).includes('新建小标签'))
    const glyph = collectElements(createRow).find(
      (element) => String(element.props && element.props.className).includes('dsh-ph-dropdown-create-glyph'),
    )
    assert.ok(glyph, 'the action row shows a plus glyph')
    assert.equal(textOf(glyph), '+')

    const divider = collectElements(menu).find(
      (element) => String(element.props && element.props.className).includes('dsh-ph-dropdown-divider'),
    )
    assert.ok(divider, 'a divider separates existing options from the create action')

    // Order: option rows ... divider ... create row.
    const all = collectElements(menu)
    assert.ok(all.indexOf(rows[1]) < all.indexOf(divider))
    assert.ok(all.indexOf(divider) < all.indexOf(createRow))
  })

  // ── 7. Create action opens the nested dialog ────────────────────────────
  await t.test('点击「＋ 新建小标签」关闭菜单并打开嵌套对话框（带项目+大标签上下文）', () => {
    harness.resetForm()
    const changes = []
    const props = dropdownProps({
      id: 'dsh-ph-ingest-small-tag',
      value: '',
      options: ['已有A'],
      allowCreate: true,
      createTitle: '新建小标签',
      createContext: '项目：项目甲 · 大标签：[Media-多媒体渲染]',
      createHint: '确定后在提交时会写入项目知识库 .dsh-hub/docs/[Media-多媒体渲染]/<小标签>.md。',
      onChange: (value) => changes.push(value),
    })
    let tree = harness.renderDropdown(props)
    findById(tree, props.id).props.onClick()
    tree = harness.renderDropdown(props)
    findById(tree, props.id + '-create').props.onClick()
    tree = harness.renderDropdown(props)

    assert.equal(findByRole(tree, 'listbox'), null, 'the menu closes when the dialog opens')
    const dialog = collectElements(tree).find((element) => element.type === api.NewSmallTagDialog)
    assert.ok(dialog, 'the nested NewSmallTagDialog is rendered')
    assert.equal(dialog.props.title, '新建小标签')
    assert.ok(dialog.props.contextText.includes('项目甲'), 'dialog shows the project context')
    assert.ok(dialog.props.contextText.includes('[Media-多媒体渲染]'), 'dialog shows the big-tag context')
    assert.ok(dialog.props.hint.includes('.dsh-hub/docs/'), 'dialog explains where the tag will be written')

    // Confirming the dialog feeds the SAME value channel as a normal selection.
    dialog.props.onConfirm('全新小标签')
    assert.deepEqual(changes, ['全新小标签'])
    tree = harness.renderDropdown(props)
    assert.equal(collectElements(tree).some((element) => element.type === api.NewSmallTagDialog), false)
  })

  // ── 8. Dialog internals: inline error / Enter / 确定 ────────────────────
  await t.test('新建对话框：空名内联 role=alert 错误；输入后 Enter/确定 回调 trim 名称', () => {
    harness.resetForm()
    const confirmed = []
    const canceled = []
    const dialogProps = {
      title: '新建小标签',
      contextText: '项目：项目甲 · 大标签：[Media-多媒体渲染]',
      hint: '确定后在提交时会写入项目知识库 .dsh-hub/docs/[Media-多媒体渲染]/<小标签>.md。',
      onCancel: () => canceled.push(true),
      onConfirm: (name) => confirmed.push(name),
    }
    let tree = harness.renderDialog(dialogProps)

    const input = findById(tree, api.NEW_SMALL_TAG_INPUT_ID)
    assert.ok(input, 'the dialog has the new-small-tag input')
    assert.equal(input.type, 'input')
    assert.equal(String(input.props.className).includes('dsh-ph-input'), true)
    assert.equal(input.props.autoFocus, true, 'the new-tag input takes focus so the user can type immediately')

    const cancelButton = findById(tree, api.NEW_SMALL_TAG_CANCEL_ID)
    assert.ok(cancelButton && String(cancelButton.props.className).includes('dsh-ph-btn'))
    assert.equal(textOf(cancelButton).trim(), '取消')

    const confirmButton = findById(tree, api.NEW_SMALL_TAG_CONFIRM_ID)
    assert.ok(confirmButton, 'the dialog has the 确定 button')
    assert.equal(confirmButton.type, 'button')
    const confirmClass = String(confirmButton.props.className)
    assert.ok(confirmClass.includes('dsh-ph-btn'), '确定 uses the shared button base')
    assert.ok(confirmClass.includes('dsh-ph-settings-save'), '确定 mirrors the shell native save button')
    assert.equal(textOf(confirmButton).trim(), '确定')

    assert.equal(findById(tree, api.NEW_SMALL_TAG_ERROR_ID), null, 'no error before confirming')

    // Empty confirm -> inline role=alert error, dialog stays, nothing submitted.
    confirmButton.props.onClick()
    tree = harness.renderDialog(dialogProps)
    const error = findById(tree, api.NEW_SMALL_TAG_ERROR_ID)
    assert.ok(error, 'empty name renders the inline error')
    assert.equal(error.props.role, 'alert')
    assert.ok(String(error.props.className).includes('dsh-ph-dropdown-dialog-error'))
    assert.ok(textOf(error).includes('请输入小标签名称'))
    assert.deepEqual(confirmed, [], 'empty name never confirms')
    assert.ok(findById(tree, api.NEW_SMALL_TAG_INPUT_ID), 'the dialog stays open on error')

    // Type a name and press Enter on the dialog -> confirms the trimmed value.
    findById(tree, api.NEW_SMALL_TAG_INPUT_ID).props.onChange({ target: { value: '  全新 模块  ' } })
    tree = harness.renderDialog(dialogProps)
    const dialogCard = findByClass(tree, 'dsh-ph-dropdown-dialog')
    assert.ok(dialogCard, 'dialog card exists')
    assert.equal(dialogCard.props.role, 'dialog')
    let prevented = 0
    let stopped = 0
    // An Enter that only commits a Chinese IME candidate (isComposing) must
    // NOT confirm the dialog prematurely.
    dialogCard.props.onKeyDown({
      key: 'Enter',
      nativeEvent: { isComposing: true },
      preventDefault() {
        prevented += 1
      },
      stopPropagation() {
        stopped += 1
      },
    })
    assert.deepEqual(confirmed, [], 'IME composition Enter never confirms')
    assert.equal(prevented, 0)
    dialogCard.props.onKeyDown({
      key: 'Enter',
      preventDefault() {
        prevented += 1
      },
      stopPropagation() {
        stopped += 1
      },
    })
    assert.deepEqual(confirmed, ['全新 模块'], 'Enter confirms the trimmed name')
    assert.equal(prevented, 1)

    // Esc on the dialog closes ONLY the dialog and stops the event.
    dialogCard.props.onKeyDown({
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {
        stopped += 1
      },
    })
    assert.deepEqual(canceled, [true])
    assert.equal(stopped, 1, 'dialog Escape stops propagation so the ingest modal stays')

    // Backdrop click closes the dialog; a click inside the card does not.
    harness.resetForm()
    const canceled2 = []
    const dialogProps2 = Object.assign({}, dialogProps, { onCancel: () => canceled2.push(true) })
    tree = harness.renderDialog(dialogProps2)
    const backdrop = findByClass(tree, 'dsh-ph-dropdown-dialog-backdrop')
    assert.ok(backdrop, 'the dialog owns a backdrop layer')
    backdrop.props.onMouseDown({ target: {}, currentTarget: backdrop })
    assert.equal(canceled2.length, 0, 'a click inside the dialog does not close it')
    backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
    assert.equal(canceled2.length, 1, 'a backdrop click closes only the dialog')

    // 确定 with a valid name also confirms.
    harness.resetForm()
    const confirmed3 = []
    const dialogProps3 = Object.assign({}, dialogProps, { onConfirm: (name) => confirmed3.push(name) })
    tree = harness.renderDialog(dialogProps3)
    findById(tree, api.NEW_SMALL_TAG_INPUT_ID).props.onChange({ target: { value: '另一个名称' } })
    tree = harness.renderDialog(dialogProps3)
    findById(tree, api.NEW_SMALL_TAG_CONFIRM_ID).props.onClick()
    assert.deepEqual(confirmed3, ['另一个名称'])
  })

  // ── 9. Dialog Escape capture helper ─────────────────────────────────────
  await t.test('对话框 Esc 使用捕获阶段监听并阻断冒泡（只关对话框，不关弹窗）', () => {
    const fakeWindow = createFakeWindow()
    let closed = 0
    let stopped = 0
    let prevented = 0
    const unsubscribe = api.stopEscapeEventCapture(() => {
      closed += 1
    }, fakeWindow)

    assert.equal(fakeWindow.count('keydown'), 1)
    assert.equal(fakeWindow.listeners.keydown[0].options, true, 'registered in capture phase')

    fakeWindow.dispatch('keydown', { key: 'a' })
    assert.equal(closed, 0, 'non-Escape keys are ignored')

    fakeWindow.dispatch('keydown', {
      key: 'Escape',
      stopPropagation() {
        stopped += 1
      },
      preventDefault() {
        prevented += 1
      },
    })
    assert.equal(closed, 1, 'Escape closes the dialog')
    assert.equal(stopped, 1, 'Escape is stopped before the modal bubble listener')
    assert.equal(prevented, 1)

    unsubscribe()
    assert.equal(fakeWindow.count('keydown'), 0)
    fakeWindow.dispatch('keydown', { key: 'Escape', stopPropagation() {}, preventDefault() {} })
    assert.equal(closed, 1, 'unsubscribe removes the listener')

    // Wired from the dialog component.
    assert.match(SOURCE, /stopEscapeEventCapture\(cancel\)/)
  })

  // ── 10. Placement helper ────────────────────────────────────────────────
  await t.test('computeDropdownPlacement：默认下方、空间不足翻到上方、视口内收边', () => {
    const below = api.computeDropdownPlacement(
      { getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 32, right: 300, bottom: 132 }) },
      { width: 1000, height: 800 },
    )
    assert.equal(below.placement, 'bottom')
    assert.equal(below.left, 100)
    assert.equal(below.top, 136, 'opens 4px below the trigger')
    assert.equal(below.width, 200)
    assert.equal(below.maxHeight, 280)

    const above = api.computeDropdownPlacement(
      { getBoundingClientRect: () => ({ left: 10, top: 700, width: 300, height: 32, right: 310, bottom: 732 }) },
      { width: 800, height: 760 },
    )
    assert.equal(above.placement, 'top', 'flips above when the viewport has no room below')
    assert.ok(above.top < 700)

    const clamped = api.computeDropdownPlacement(
      { getBoundingClientRect: () => ({ left: -50, top: 0, width: 400, height: 32, right: 350, bottom: 32 }) },
      { width: 300, height: 400 },
    )
    assert.equal(clamped.left, 8, 'never escapes the viewport on the left')
    assert.equal(clamped.width, 284, 'width is clamped to the viewport minus margins')

    const fallback = api.computeDropdownPlacement(null, { width: 1000, height: 800 })
    assert.equal(fallback.placement, 'bottom')
    assert.equal(typeof fallback.top, 'number')
  })

  // ── 11. Injected stylesheet: themed listbox / option / scrollbar / dialog ─
  await t.test('注入样式表：fixed 列表框、主题表面/边框/阴影、滚动条 token、选项悬停/选中、对话框层级与错误色', () => {
    const stylesheet = harness.stylesheet()
    assert.ok(stylesheet, 'the stylesheet is injected into document.head')
    assert.equal(stylesheet.id, 'dsh-project-hub-styles')
    const css = stylesheet.textContent

    // The trigger skin (.dsh-ph-select) must stay intact.
    const selectRule = ruleBody(css, /\.dsh-ph-select\s*\{([^}]*)\}/)
    assert.match(selectRule, /background-image:\s*url\("data:image\/svg\+xml/)
    assert.match(selectRule, /background-position:\s*right 10px center/)
    assert.match(selectRule, /padding:\s*0 32px 0 12px/)

    // Trigger layout.
    const triggerRule = ruleBody(css, /\.dsh-ph-dropdown-trigger\s*\{([^}]*)\}/)
    assert.match(triggerRule, /display:\s*flex/)
    assert.match(triggerRule, /cursor:\s*pointer/)
    const valueRule = ruleBody(css, /\.dsh-ph-dropdown-value\s*\{([^}]*)\}/)
    assert.match(valueRule, /text-overflow:\s*ellipsis/)
    assert.match(valueRule, /overflow:\s*hidden/)
    const placeholderRule = ruleBody(css, /\.dsh-ph-dropdown-placeholder\s*\{([^}]*)\}/)
    assert.match(placeholderRule, /color:\s*var\(--dsw-alias-label-tertiary\)/)

    // The open listbox: fixed, themed surface, border, radius, shadow, z-index.
    const menuRule = ruleBody(css, /\.dsh-ph-dropdown-menu\s*\{([^}]*)\}/)
    assert.match(menuRule, /position:\s*fixed/)
    assert.match(menuRule, /z-index:\s*10020/)
    assert.match(menuRule, /background-color:\s*var\(--dsw-alias-bg-layer-2\)/)
    assert.match(menuRule, /border:\s*1px solid var\(--dsw-alias-border-l2\)/)
    assert.match(menuRule, /border-radius:\s*var\(--dsw-radius-md\)/)
    assert.match(menuRule, /box-shadow:\s*var\(--dsw-shadow-lv3\)/)
    assert.match(menuRule, /padding:\s*4px/)
    assert.match(menuRule, /overflow-y:\s*auto/)
    assert.match(menuRule, /scrollbar-color:\s*var\(--dsw-alias-scrollbar-bg-l1\)/)

    // Themed scrollbar.
    const scrollThumb = ruleBody(css, /\.dsh-ph-dropdown-menu::-webkit-scrollbar-thumb\s*\{([^}]*)\}/)
    assert.match(scrollThumb, /background:\s*var\(--dsw-alias-scrollbar-bg-l1\)/)
    assert.match(scrollThumb, /border-radius:\s*var\(--dsw-radius-sm\)/)
    const scrollThumbHover = ruleBody(
      css,
      /\.dsh-ph-dropdown-menu::-webkit-scrollbar-thumb:hover\s*\{([^}]*)\}/,
    )
    assert.match(scrollThumbHover, /background:\s*var\(--dsw-alias-scrollbar-hover-l1\)/)

    // Option rows: 13px/20px radius-sm, hover/active surface, selected check.
    const optionRule = ruleBody(css, /\.dsh-ph-dropdown-option\s*\{([^}]*)\}/)
    assert.match(optionRule, /padding:\s*6px 8px/)
    assert.match(optionRule, /font-size:\s*13px/)
    assert.match(optionRule, /line-height:\s*20px/)
    assert.match(optionRule, /border-radius:\s*var\(--dsw-radius-sm\)/)
    assert.match(optionRule, /cursor:\s*pointer/)
    const optionHover = ruleBody(css, /\.dsh-ph-dropdown-option:hover[^{]*\{([^}]*)\}/)
    assert.match(optionHover, /background-color:\s*var\(--dsw-alias-interactive-bg-hover\)/)
    const optionSelected = ruleBody(css, /\.dsh-ph-dropdown-option\.is-selected\s*\{([^}]*)\}/)
    assert.match(optionSelected, /color:\s*var\(--dsw-alias-state-business-primary\)/)
    const checkRule = ruleBody(css, /\.dsh-ph-dropdown-check\s*\{([^}]*)\}/)
    assert.match(checkRule, /color:\s*var\(--dsw-alias-state-business-primary\)/)
    const emptyRule = ruleBody(css, /\.dsh-ph-dropdown-empty\s*\{([^}]*)\}/)
    assert.match(emptyRule, /color:\s*var\(--dsw-alias-label-tertiary\)/)
    const dividerRule = ruleBody(css, /\.dsh-ph-dropdown-divider\s*\{([^}]*)\}/)
    assert.match(dividerRule, /background-color:\s*var\(--dsw-alias-border-l1\)/)
    const createRule = ruleBody(css, /\.dsh-ph-dropdown-create\s*\{([^}]*)\}/)
    assert.match(createRule, /color:\s*var\(--dsw-alias-label-secondary\)/)

    // Nested dialog layers above the menu (10020) and the modal.
    const dialogBackdrop = ruleBody(css, /\.dsh-ph-dropdown-dialog-backdrop\s*\{([^}]*)\}/)
    assert.match(dialogBackdrop, /position:\s*fixed/)
    assert.match(dialogBackdrop, /z-index:\s*10030/)
    const dialogRule = ruleBody(css, /\.dsh-ph-dropdown-dialog\s*\{([^}]*)\}/)
    assert.match(dialogRule, /z-index:\s*10040/)
    assert.match(dialogRule, /background-color:\s*var\(--dsw-alias-bg-layer-1\)/)
    assert.match(dialogRule, /border:\s*1px solid var\(--dsw-alias-border-l2\)/)
    assert.match(dialogRule, /border-radius:\s*var\(--dsw-radius-md\)/)
    assert.match(dialogRule, /box-shadow:\s*var\(--dsw-shadow-lv3\)/)
    const dialogErrorRule = ruleBody(css, /\.dsh-ph-dropdown-dialog-error\s*\{([^}]*)\}/)
    assert.match(dialogErrorRule, /color:\s*var\(--dsw-alias-state-error-primary\)/)

    // The old form/settings rules are untouched.
    const inputRule = ruleBody(css, /\.dsh-ph-input\s*\{([^}]*)\}/)
    assert.match(inputRule, /appearance:\s*none/)
    assert.match(inputRule, /height:\s*32px/)
    assert.match(SOURCE, /\.dsh-ph-btn:disabled\s*\{[^}]*opacity:\s*0\.55/)
    assert.equal((SOURCE.match(/dsh-ph-btn dsh-ph-btn-primary/g) || []).length, 1)
    assert.equal((SOURCE.match(/primaryButtonProps\(\{/g) || []).length, 4)
  })

  // ── 12. Token allow-list ────────────────────────────────────────────────
  await t.test('新控件引用的每个 --dsw-* token 都在 app.asar 扫描清单中', () => {
    const known = new Set(Array.isArray(MANIFEST.tokens) ? MANIFEST.tokens : [])
    assert.ok(known.size >= 400, `the manifest is the real app.asar token scan (${known.size} tokens)`)

    const used = new Set(SOURCE.match(/--dsw-[a-z0-9-]+/g) || [])
    const unknown = [...used].filter((token) => !known.has(token)).sort()
    assert.deepEqual(unknown, [], `client.js references tokens absent from the shipped theme: ${unknown.join(', ')}`)

    const required = [
      '--dsw-shadow-lv3',
      '--dsw-alias-scrollbar-bg-l1',
      '--dsw-alias-scrollbar-hover-l1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-border-l2',
      '--dsw-alias-border-l1',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-radius-sm',
      '--dsw-radius-md',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-state-business-primary',
      '--dsw-alias-state-error-primary',
    ]
    for (const token of required) {
      assert.ok(known.has(token), `${token} must be a real app.asar token`)
      assert.ok(SOURCE.includes(token), `${token} must be used by the dropdown stylesheet`)
    }

    assert.equal(SOURCE.includes('--dsw-alias-label-primary-foreground'), false)
    assert.equal(SOURCE.includes('--dsw-alias-button-primary-label'), false)
  })

  // ── 13. IngestSessionsModal integration ─────────────────────────────────
  await t.test('IngestSessionsModal：三个字段都是 IngestDropdown，真实小标签 props 驱动新建流程', () => {
    harness.resetForm()
    const modalTree = harness.renderComponent(api.IngestSessionsModal, {
      projects: [ALPHA],
      sessions: [SESSION],
      selectedIds: ['s-1'],
      setSelectedIds: () => {},
      onClose: () => {},
      onDone: () => {},
    })

    const projectField = findById(modalTree, 'dsh-ph-ingest-project')
    const bigField = findById(modalTree, 'dsh-ph-ingest-big-tag')
    const smallField = findById(modalTree, 'dsh-ph-ingest-small-tag')
    for (const [id, field] of [
      ['dsh-ph-ingest-project', projectField],
      ['dsh-ph-ingest-big-tag', bigField],
      ['dsh-ph-ingest-small-tag', smallField],
    ]) {
      assert.ok(field, `${id} field exists`)
      assert.equal(field.type, api.IngestDropdown, `${id} is the custom listbox`)
    }
    assert.equal(Boolean(projectField.props.allowCreate), false)
    assert.equal(Boolean(bigField.props.allowCreate), false)
    assert.equal(smallField.props.allowCreate, true)
    assert.equal(smallField.props.createLabel, '新建小标签')
    assert.ok(Array.isArray(nativePopupControls(modalTree)) && nativePopupControls(modalTree).length === 0)

    // Drive the REAL 小标签 props from the modal: menu -> create -> dialog.
    harness.resetForm()
    const smallProps = smallField.props
    let tree = harness.renderDropdown(smallProps)
    findById(tree, smallProps.id).props.onClick()
    tree = harness.renderDropdown(smallProps)
    const createRow = findById(tree, smallProps.id + '-create')
    assert.ok(createRow, 'the 新建 action appears for the modal small-tag field')
    createRow.props.onClick()
    tree = harness.renderDropdown(smallProps)
    const dialog = collectElements(tree).find((element) => element.type === api.NewSmallTagDialog)
    assert.ok(dialog, 'dialog opened from the modal small-tag dropdown')
    assert.ok(dialog.props.contextText.includes('项目甲'))
    assert.ok(dialog.props.contextText.includes('[Media-多媒体渲染]'))
  })
})
