/**
 * dsh-project-hub — test/settings-ui.mjs
 *
 * Tests for the two client-side deliverables:
 *
 *   A. 「总工作区」 settings entry + modal
 *      - the drawer has ONE quiet footer entry (`#dsh-ph-settings-entry`,
 *        plain 「设置」 + 14px line-art gear SVG) below the project list; it
 *        closes the drawer and opens `SettingsModal`;
 *      - `SettingsModal({ globalWorkspaceRoot, onClose, onSaved })` seeds
 *        `#dsh-ph-settings-root` from the prop (the value of
 *        `GET /project-hub/state.globalWorkspaceRoot`), POSTs
 *        `/project-hub/settings` with `{ globalWorkspaceRoot: <trimmed> }`,
 *        calls `onSaved(data.globalWorkspaceRoot)` on success, and on failure
 *        shows the INLINE `#dsh-ph-settings-error` (`role="alert"`, Host
 *        message) while the modal stays open and nothing is toasted.
 *
 *   B. Native-looking form controls (the 「下拉框太丑」 fix)
 *      - rule-block assertions on the stylesheet actually injected by
 *        `ensureStyles()`: `appearance: none` / 32px / layer-3 surface / l4
 *        border / radius-md on `.dsh-ph-input`, the custom inline-SVG chevron
 *        (DSH's own %2381858C) on `.dsh-ph-select`, explicit option colours,
 *        focus/hover/disabled states and the error colour;
 *      - every `--dsw-*` token referenced by `lib/client.js` exists in
 *        `test/dsw-token-manifest.json` (the app.asar byte scan) — the same
 *        guard as test/theme-tokens.mjs, kept here so this file fails fast too.
 *
 * The client bundle is evaluated with a tiny React stub whose `useState` keeps
 * state between manual re-renders, a stub `react-dom`, a fake `document` (only
 * `ensureStyles` needs one) and a programmable `fetch` in the sandbox; the
 * Host origin comes from `window.__DSH_TRANSPORT__.streamBaseUrl`.
 *
 * Run directly:  node test/settings-ui.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const MANIFEST = JSON.parse(readFileSync(new URL('./dsw-token-manifest.json', import.meta.url), 'utf8'))
const HOST_BASE = 'http://127.0.0.1:9999'

// ── Fake DOM (only the pieces ensureStyles() uses) ─────────────────────────

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

  const fetchCalls = []
  let fetchResponder = async () => ({ ok: true, status: 200, data: { ok: true } })
  const documentStub = createFakeDocument()

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          loads.push(registration)
        },
      },
      __DSH_TRANSPORT__: { streamBaseUrl: HOST_BASE },
    },
    document: documentStub,
    URL,
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
    console,
    fetch: async (url, init) => {
      const call = {
        url: String(url),
        method: (init && init.method) || 'GET',
        body: init ? init.body : undefined,
      }
      fetchCalls.push(call)
      const response = await fetchResponder(call)
      return {
        ok: response.ok !== false,
        status: response.status === undefined ? 200 : response.status,
        json: async () => response.data,
      }
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
  assert.ok(api && typeof api.SettingsModal === 'function', 'SettingsModal must be exposed through __test__')
  assert.equal(typeof api.ensureStyles, 'function', 'ensureStyles must be exposed for the CSS assertions')
  assert.equal(typeof api.SettingsGearIcon, 'function', 'SettingsGearIcon must be exposed for the entry assertion')
  assert.equal(typeof api.HubApp, 'function', 'HubApp must be exposed for the drawer-entry assertion')

  return {
    client,
    api,
    fetchCalls,
    /** Program the next Host responses (receives `{url, method, body}`). */
    setFetchResponder(responder) {
      fetchResponder = responder
    },
    /** Forget hook state (fresh mount). */
    resetForm() {
      stateStore.length = 0
      hookIndex = 0
    },
    /** Seed one hook slot before the next render (e.g. openDrawer = true). */
    seedHook(index, value) {
      stateStore[index] = value
    },
    /** Re-render SettingsModal; hook state survives between calls. */
    renderSettings(props) {
      hookIndex = 0
      return api.SettingsModal(props)
    },
    /** Re-render HubApp; hook state survives between calls. */
    renderHub() {
      hookIndex = 0
      return api.HubApp()
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

/** Body of the FIRST rule whose selector header matches `pattern`. */
function ruleBody(css, pattern) {
  const match = pattern.exec(css)
  assert.ok(match, `stylesheet must contain a rule matching ${pattern}`)
  return match[1]
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test('DSH Project Hub — 总工作区设置 entry/modal + native-looking form controls', async (t) => {
  const harness = createClientHarness()
  const api = harness.api

  // ── A1. Drawer footer entry wires the settings modal ────────────────────
  await t.test('抽屉项目列表下方有唯一的「设置」文字入口，点击关闭抽屉并打开设置弹窗', () => {
    harness.resetForm()
    harness.seedHook(0, true) // openDrawer = true
    let tree = harness.renderHub()

    const drawer = collectElements(tree).find(
      (element) => element.props && element.props['data-project-hub-drawer'] === '1',
    )
    assert.ok(drawer, 'drawer must render inside the portal host')

    const all = collectElements(drawer)
    const projectList = all.find(
      (element) => element.props && element.props.style && element.props.style.maxHeight === '260px',
    )
    assert.ok(projectList, 'the project list container must be present')
    const entry = all.find((element) => element.props && element.props.id === 'dsh-ph-settings-entry')
    assert.ok(entry, 'the drawer must own a #dsh-ph-settings-entry')
    assert.ok(all.indexOf(projectList) < all.indexOf(entry), 'the entry must sit BELOW the project list')
    assert.equal(entry.type, 'button', 'the entry is a native button')
    assert.ok(String(entry.props.className).includes('dsh-ph-settings-entry'))
    assert.equal(String(entry.props.className).includes('dsh-ph-btn'), false, 'entry must not use a filled button')
    assert.equal(textOf(entry).trim(), '设置', 'entry text is exactly 「设置」')

    // Line-art gear: inline SVG with `stroke="currentColor" fill="none"` — no
    // icon font, no dependency and absolutely no colour emoji.
    const gearChild = (entry.children || []).find(
      (child) => child && child.type === api.SettingsGearIcon,
    )
    assert.ok(gearChild, 'the entry is preceded by the inline line-art gear')
    const gear = api.SettingsGearIcon()
    assert.equal(gear.type, 'svg')
    assert.equal(gear.props.width, 14)
    assert.equal(gear.props.height, 14)
    assert.equal(gear.props.fill, 'none')
    assert.equal(gear.props.stroke, 'currentColor')
    assert.ok(Array.isArray(gear.children) && gear.children.length > 0)

    // Click: drawer closes, SettingsModal opens with the current global root.
    entry.props.onClick()
    tree = harness.renderHub()
    assert.equal(
      collectElements(tree).some((element) => element.props && element.props['data-project-hub-drawer'] === '1'),
      false,
      'clicking the entry closes the drawer',
    )
    const modal = collectElements(tree).find((element) => element.type === api.SettingsModal)
    assert.ok(modal, 'clicking the entry opens SettingsModal')
    assert.equal(modal.props.globalWorkspaceRoot, 'C:\\work', 'modal receives HubApp state root')
    assert.equal(typeof modal.props.onClose, 'function')
    assert.equal(typeof modal.props.onSaved, 'function')

    // Same wiring at source level (the entry exists only in the drawer footer).
    assert.match(SOURCE, /id: 'dsh-ph-settings-entry'/)
    assert.match(SOURCE, /h\(SettingsGearIcon\)/)
  })

  // ── A2. Default value + edit + POST body ────────────────────────────────
  await t.test('弹窗默认值来自 globalWorkspaceRoot，保存只发一次 POST /project-hub/settings', async () => {
    harness.resetForm()
    harness.fetchCalls.length = 0
    harness.setFetchResponder(async (call) => {
      const body = JSON.parse(call.body)
      return { ok: true, status: 200, data: { ok: true, globalWorkspaceRoot: body.globalWorkspaceRoot } }
    })
    const props = { globalWorkspaceRoot: 'C:\\work', onClose: () => {}, onSaved: () => {} }
    let tree = harness.renderSettings(props)

    const input = findById(tree, 'dsh-ph-settings-root')
    assert.ok(input, 'the root-directory input exists')
    assert.equal(input.type, 'input')
    assert.ok(String(input.props.className).includes('dsh-ph-input'))
    assert.equal(input.props.value, 'C:\\work', 'input is seeded from the globalWorkspaceRoot prop')

    // Clearing the field disables 保存 (empty values are never POSTed).
    input.props.onChange({ target: { value: '   ' } })
    tree = harness.renderSettings(props)
    assert.equal(findById(tree, 'dsh-ph-settings-save').props.disabled, true, 'empty root disables 保存')
    assert.equal(
      findByButtonLabel(tree, '取消') !== null,
      true,
      'a cancel button sits next to 保存 (no primary fill required)',
    )

    // Type a new root and save.
    findById(tree, 'dsh-ph-settings-root').props.onChange({ target: { value: 'D:\\work2' } })
    tree = harness.renderSettings(props)
    const save = findById(tree, 'dsh-ph-settings-save')
    assert.ok(save && save.type === 'button')
    assert.equal(save.props.disabled, false, 'non-empty root enables 保存')
    assert.equal(save.props.className, 'dsh-ph-btn dsh-ph-settings-save', 'save class stays off the primary helper')
    assert.equal(findByButtonLabel(tree, '保存').props.id, 'dsh-ph-settings-save')

    const pending = save.props.onClick()
    // While the request is in flight 保存 is disabled.
    tree = harness.renderSettings(props)
    assert.equal(findById(tree, 'dsh-ph-settings-save').props.disabled, true, '保存 is disabled while saving')
    await pending

    const posts = harness.fetchCalls.filter((call) => call.method === 'POST')
    assert.equal(posts.length, 1, 'exactly one POST is sent')
    assert.equal(posts[0].url, `${HOST_BASE}/project-hub/settings`, 'the POST targets /project-hub/settings')
    assert.deepEqual(JSON.parse(posts[0].body), { globalWorkspaceRoot: 'D:\\work2' }, 'body carries the new root')
  })

  // ── A3. Failure -> inline error, modal stays open ───────────────────────
  await t.test('保存失败显示内联 #dsh-ph-settings-error（role=alert），弹窗不关闭', async () => {
    harness.resetForm()
    harness.fetchCalls.length = 0
    harness.setFetchResponder(async () => ({
      ok: false,
      status: 400,
      data: { ok: false, code: 'root_not_found', message: '目录不存在' },
    }))
    let closeCalls = 0
    const saved = []
    const props = {
      globalWorkspaceRoot: 'C:\\work',
      onClose: () => {
        closeCalls += 1
      },
      onSaved: (root) => saved.push(root),
    }
    let tree = harness.renderSettings(props)
    assert.equal(findById(tree, 'dsh-ph-settings-error'), null, 'no error before saving')

    findById(tree, 'dsh-ph-settings-root').props.onChange({ target: { value: 'E:\\missing' } })
    tree = harness.renderSettings(props)
    await findById(tree, 'dsh-ph-settings-save').props.onClick()
    tree = harness.renderSettings(props)

    const error = findById(tree, 'dsh-ph-settings-error')
    assert.ok(error, 'failure renders the inline error node')
    assert.equal(error.type, 'div')
    assert.equal(error.props.role, 'alert', 'the inline error is announced as an alert')
    assert.ok(String(error.props.className).includes('dsh-ph-settings-error'))
    assert.ok(textOf(error).includes('目录不存在'), 'the Host message is shown verbatim')
    assert.equal(saved.length, 0, 'onSaved must not fire on failure')
    assert.equal(closeCalls, 0, 'the modal must stay open on failure')
    assert.ok(findById(tree, 'dsh-ph-settings-root'), 'the modal (and its input) is still mounted')
    assert.equal(harness.fetchCalls.filter((call) => call.method === 'POST').length, 1)
  })

  // ── A4. Success -> onSaved(data.globalWorkspaceRoot) ────────────────────
  await t.test('保存成功回调 onSaved(data.globalWorkspaceRoot)', async () => {
    harness.resetForm()
    harness.fetchCalls.length = 0
    harness.setFetchResponder(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, globalWorkspaceRoot: 'D:\\work2' },
    }))
    const saved = []
    const props = {
      globalWorkspaceRoot: 'C:\\work',
      onClose: () => {},
      onSaved: (root) => saved.push(root),
    }
    let tree = harness.renderSettings(props)
    findById(tree, 'dsh-ph-settings-root').props.onChange({ target: { value: 'D:\\work2' } })
    tree = harness.renderSettings(props)
    await findById(tree, 'dsh-ph-settings-save').props.onClick()

    assert.deepEqual(saved, ['D:\\work2'], 'onSaved receives the root confirmed by the Host')
    tree = harness.renderSettings(props)
    assert.equal(findById(tree, 'dsh-ph-settings-error'), null, 'a successful save shows no error')
  })

  // ── A5. Network throw stays inline too (no toast/popup) ─────────────────
  await t.test('网络异常同样内联报错，不产生 toast/弹窗', async () => {
    harness.resetForm()
    harness.fetchCalls.length = 0
    harness.setFetchResponder(async () => {
      throw new Error('ECONNREFUSED')
    })
    const saved = []
    const props = { globalWorkspaceRoot: 'C:\\work', onClose: () => {}, onSaved: (root) => saved.push(root) }
    let tree = harness.renderSettings(props)
    findById(tree, 'dsh-ph-settings-root').props.onChange({ target: { value: 'D:\\work2' } })
    tree = harness.renderSettings(props)
    await findById(tree, 'dsh-ph-settings-save').props.onClick()
    tree = harness.renderSettings(props)

    const error = findById(tree, 'dsh-ph-settings-error')
    assert.ok(error, 'a thrown fetch also lands in the inline error region')
    assert.equal(error.props.role, 'alert')
    assert.ok(textOf(error).includes('保存失败'))
    assert.equal(saved.length, 0)
  })

  // ── B1. Injected form-control CSS (rule bodies, not class existence) ────
  await t.test('注入的样式表：原生感 input/select（appearance/32px/自定义 chevron）', () => {
    const stylesheet = harness.stylesheet()
    assert.ok(stylesheet, 'the stylesheet must be injected into document.head')
    assert.equal(stylesheet.id, 'dsh-project-hub-styles')
    const css = stylesheet.textContent

    // `.dsh-ph-input` base rule.
    const inputRule = ruleBody(css, /\.dsh-ph-input\s*\{([^}]*)\}/)
    assert.match(inputRule, /(?:^|[;\s])-webkit-appearance:\s*none/)
    assert.match(inputRule, /(?:^|[;\s])appearance:\s*none/)
    assert.match(inputRule, /height:\s*32px/)
    assert.match(inputRule, /border-radius:\s*var\(--dsw-radius-md\)/)
    assert.match(inputRule, /background-color:\s*var\(--dsw-alias-bg-layer-3\)/)
    assert.match(inputRule, /border:\s*1px solid var\(--dsw-alias-border-l4\)/)
    assert.match(inputRule, /color:\s*var\(--dsw-alias-label-primary\)/)
    assert.match(inputRule, /font-size:\s*13px/)
    assert.match(inputRule, /line-height:\s*20px/)
    assert.match(inputRule, /outline:\s*none/)
    assert.match(inputRule, /width:\s*100%/)
    assert.match(inputRule, /box-sizing:\s*border-box/)
    assert.match(inputRule, /transition:/)
    assert.match(inputRule, /font:\s*inherit/)

    // Hover: border-l3 only.
    const hoverRule = ruleBody(css, /\.dsh-ph-input:hover[^{]*\{([^}]*)\}/)
    assert.match(hoverRule, /border-color:\s*var\(--dsw-alias-border-l3\)/)

    // Focus: shell focus-ring width + business-primary ring.
    const focusRule = ruleBody(css, /\.dsh-ph-input:focus[^{]*\{([^}]*)\}/)
    assert.match(focusRule, /outline:[^;]*var\(--dsw-focus-ring-width\)/)
    assert.match(focusRule, /--dsw-alias-state-business-primary/)
    assert.match(focusRule, /outline-offset:\s*1px/)

    // Disabled.
    const disabledRule = ruleBody(css, /\.dsh-ph-input:disabled\s*\{([^}]*)\}/)
    assert.match(disabledRule, /background-color:\s*var\(--dsw-alias-bg-layer-2\)/)
    assert.match(disabledRule, /color:\s*var\(--dsw-alias-label-tertiary\)/)
    assert.match(disabledRule, /border-color:\s*var\(--dsw-alias-border-l2\)/)
    assert.match(disabledRule, /opacity:\s*0?\.55/)
    assert.match(disabledRule, /cursor:\s*not-allowed/)

    // `.dsh-ph-select`: DSH's exact chevron, right-aligned, text kept clear.
    const selectRule = ruleBody(css, /\.dsh-ph-select\s*\{([^}]*)\}/)
    assert.match(selectRule, /background-image:\s*url\("data:image\/svg\+xml/)
    assert.match(selectRule, /stroke='%2381858C'/)
    assert.match(selectRule, /background-position:\s*right 10px center/)
    assert.match(selectRule, /background-repeat:\s*no-repeat/)
    assert.match(selectRule, /background-size:\s*12px 12px/)
    assert.match(selectRule, /padding:\s*0 32px 0 12px/)
    assert.match(selectRule, /cursor:\s*pointer/)
    assert.doesNotMatch(selectRule, /(?:^|[;\s])background\s*:/, 'never use the background shorthand (it erases the chevron)')

    // Option rows: explicit colours stay readable in dark AND light shells.
    const optionRule = ruleBody(css, /\.dsh-ph-select option\s*\{([^}]*)\}/)
    assert.match(optionRule, /background-color:\s*var\(--dsw-alias-bg-layer-2\)/)
    assert.match(optionRule, /color:\s*var\(--dsw-alias-label-primary\)/)
    const optionDisabledRule = ruleBody(css, /\.dsh-ph-select option:disabled\s*\{([^}]*)\}/)
    assert.match(optionDisabledRule, /color:\s*var\(--dsw-alias-label-tertiary\)/)

    // Shared field-label rhythm and hint styling.
    const labelRule = ruleBody(css, /\.dsh-ph-field-label\s*\{([^}]*)\}/)
    assert.match(labelRule, /color:\s*var\(--dsw-alias-label-secondary\)/)
    assert.match(labelRule, /font-size:\s*12px/)
    assert.match(labelRule, /margin-bottom:\s*6px/)
    const hintRule = ruleBody(css, /\.dsh-ph-hint\s*\{([^}]*)\}/)
    assert.match(hintRule, /font-size:\s*11px/)
    assert.match(hintRule, /color:\s*var\(--dsw-alias-label-tertiary/)

    // The stylesheet was injected exactly once.
    assert.equal(harness.stylesheet(), stylesheet, 'ensureStyles() is idempotent')
  })

  // ── B2. Settings-modal CSS: inline error + native save button ───────────
  await t.test('注入的样式表：设置弹窗错误色 + 原生保存按钮', () => {
    const css = harness.stylesheet().textContent

    const errorRule = ruleBody(css, /\.dsh-ph-settings-error\s*\{([^}]*)\}/)
    assert.match(errorRule, /color:\s*var\(--dsw-alias-state-error-primary\)/)
    assert.match(errorRule, /font-size:\s*12px/)

    // The drawer entry stays a quiet text row: transparent fill, secondary
    // label, never the primary button fill.
    const entryRule = ruleBody(css, /\.dsh-ph-settings-entry\s*\{([^}]*)\}/)
    assert.match(entryRule, /background:\s*transparent/)
    assert.match(entryRule, /color:\s*var\(--dsw-alias-label-secondary\)/)
    assert.match(entryRule, /box-sizing:\s*border-box/)
    assert.doesNotMatch(entryRule, /button-primary-fill/)
    const entryHoverRule = ruleBody(css, /\.dsh-ph-settings-entry:hover\s*\{([^}]*)\}/)
    assert.match(entryHoverRule, /color:\s*var\(--dsw-alias-label-primary\)/)

    const saveRule = ruleBody(css, /\.dsh-ph-settings-save\s*\{([^}]*)\}/)
    assert.match(saveRule, /background:\s*var\(--dsw-alias-label-primary\)/)
    assert.match(saveRule, /color:\s*var\(--dsw-alias-bg-layer-3\)/)
    assert.match(saveRule, /border:\s*1px solid transparent/)
    assert.match(saveRule, /border-radius:\s*var\(--dsw-radius-md\)/)
    const saveHoverRule = ruleBody(css, /\.dsh-ph-settings-save:hover:not\(:disabled\)\s*\{([^}]*)\}/)
    assert.match(saveHoverRule, /opacity:\s*0?\.85/)
    // The generic .dsh-ph-btn:hover must not repaint the inverted fill.
    assert.match(saveHoverRule, /background:\s*var\(--dsw-alias-label-primary\)/)
    assert.match(saveHoverRule, /color:\s*var\(--dsw-alias-bg-layer-3\)/)
    const saveDisabledRule = ruleBody(css, /\.dsh-ph-settings-save:disabled\s*\{([^}]*)\}/)
    assert.match(saveDisabledRule, /opacity:\s*0?\.4/)
    assert.match(saveDisabledRule, /cursor:\s*default/)

    // Guard rails untouched by the form restyle.
    assert.match(SOURCE, /\.dsh-ph-btn:disabled\s*\{[^}]*opacity:\s*0\.55/, '.dsh-ph-btn:disabled stays visible')
    const primaryRule = /\.dsh-ph-btn-primary\s*\{([\s\S]*?)\}/.exec(SOURCE)
    assert.ok(primaryRule, 'the primary-button base rule exists')
    assert.doesNotMatch(primaryRule[1], /(?:^|[;\s])color\s*:/, 'the primary base rule must not set color')
    // …and the settings save never joins the primary/measured-contrast family.
    assert.equal((SOURCE.match(/primaryButtonProps\(\{/g) || []).length, 4, 'primaryButtonProps call count is unchanged')
  })

  // ── B3. Token allow-list (app.asar scan) ────────────────────────────────
  await t.test('client.js 引用的每个 --dsw-* token 都在 app.asar 扫描清单中', () => {
    const known = new Set(Array.isArray(MANIFEST.tokens) ? MANIFEST.tokens : [])
    assert.ok(known.size >= 400, `the manifest is the real app.asar token scan (${known.size} tokens)`)

    const used = new Set(SOURCE.match(/--dsw-[a-z0-9-]+/g) || [])
    assert.ok(used.size >= 15, 'client.js references the themed surface')
    const unknown = [...used].filter((token) => !known.has(token)).sort()
    assert.deepEqual(unknown, [], `client.js references tokens absent from the shipped theme: ${unknown.join(', ')}`)

    // The form-control redesign must actually use the verified set.
    const required = [
      '--dsw-alias-bg-layer-3',
      '--dsw-alias-border-l4',
      '--dsw-alias-border-l3',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-state-business-primary',
      '--dsw-alias-state-error-primary',
      '--dsw-focus-ring-width',
      '--dsw-radius-md',
    ]
    for (const token of required) {
      assert.ok(known.has(token), `${token} must be a real app.asar token`)
      assert.ok(SOURCE.includes(token), `${token} must be used by the project-hub stylesheet`)
    }

    // The two guessed names that broke earlier must never come back.
    assert.equal(SOURCE.includes('--dsw-alias-label-primary-foreground'), false)
    assert.equal(SOURCE.includes('--dsw-alias-button-primary-label'), false)
  })
})

/** Find a `<button>` by its visible text (handles the stub tree shape). */
function findByButtonLabel(tree, label) {
  return (
    collectElements(tree).find(
      (element) => element.type === 'button' && textOf(element).trim() === label,
    ) || null
  )
}
