/**
 * dsh-project-hub — test/client-entry.mjs
 *
 * DOM smoke test for the client entry points in `lib/client.js`.
 *
 * A real browser renderer is not available to the plugin test runner, so this
 * file stubs the exact structural DOM the shipped shell renders:
 *
 *   sidebarCol(mP3x-q_sidebarCol)
 *     └─ root(wtg9ga_root)
 *          ├─ logoRow, newSession
 *          ├─ panelList (nav > button._panelRow [插件 / 自动化任务 / 更多])
 *          ├─ regionArea
 *          │    └─ browser > sectionHeader > headerActions  (⌕ ⇅ ＋ row)
 *          └─ footArea > footerActions (sidebar.footer.action seat)
 *
 * It then evaluates the client factory with stub React modules, calls
 * `exports.apply(ctx)`, and asserts:
 *   - both declared list slots were injected and registered, and neither slot
 *     occupant renders a second trigger while a DOM entry paints;
 *   - the PRIMARY entry is a `+ 项目工坊` row CLONED from a native
 *     `button._panelRow`, mounted INSIDE the sidebar nav list below 「更多」
 *     (`#dsh-project-hub-nav-row`, `data-project-hub-entry="1"`), with the
 *     native `_panelRow` class kept;
 *   - the same row click dispatches `dsh-project-hub:toggle-drawer` and never
 *     touches `layout.selectPanel`;
 *   - re-probing is idempotent (the SAME row is never duplicated);
 *   - the removed secondary workspace-header `+` is NOT mounted: an earlier
 *     revision appended a 4th icon to the native `headerActions` row (after
 *     搜索 / 视图选项 / 添加工作区) and the user asked for it to be deleted.
 *     The native three icons must stay untouched, and no stale
 *     `#dsh-project-hub-entry-btn` may survive;
 *   - collapsing the sidebar (regionArea/footArea 0×0, the Windows-titlebar
 *     rail state, where the native CSS hides `panelList`) relocates the nav row
 *     into the sidebar rail column glyph-only; re-expanding moves the same row
 *     back below 「更多」;
 *   - a vanished nav list degrades to the sidebar root column and recovers;
 *   - the drawer host (`#dsh-project-hub-portal-host`) exists.
 *
 * Run directly:  node test/client-entry.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

// ── Minimal DOM ─────────────────────────────────────────────────────────────

function parseSelector(selector) {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function matchCompound(element, compound) {
  let match = /^\[class\*=["']?([^"'\]]+)["']?\]$/.exec(compound)
  if (match) return String(element.className || '').includes(match[1])
  match = /^\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(compound)
  if (match) return String(element.getAttribute(match[1]) ?? '') === match[2]
  match = /^\[([\w-]+)\]$/.exec(compound)
  if (match) return element.getAttribute(match[1]) !== null
  return String(element.tagName || '').toLowerCase() === compound.toLowerCase()
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentElement = null
    this.attributes = Object.create(null)
    this.style = {}
    this.listeners = Object.create(null)
    this._textContent = ''
    this.className = ''
    this.isConnected = true
    this.offsetParent = {}
    this.__rect = { width: 24, height: 24 }
    this._id = ''
  }

  get id() {
    return this._id
  }

  set id(value) {
    this._id = String(value)
    this.ownerDocument._register(this)
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null
  }

  get firstElementChild() {
    return this.children[0] || null
  }

  /** Real-DOM semantics: reads the descendants, writes replace all children. */
  get textContent() {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('')
    return this._textContent
  }

  set textContent(value) {
    this._textContent = String(value == null ? '' : value)
    for (const child of this.children.slice()) child.remove()
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'id') this.id = value
    else if (name === 'class') this.className = String(value)
  }

  getAttribute(name) {
    if (name === 'id') return this._id || null
    if (name === 'class') return this.className || null
    return name in this.attributes ? this.attributes[name] : null
  }

  removeAttribute(name) {
    if (name === 'class') {
      this.className = ''
      delete this.attributes['class']
      return
    }
    if (name === 'id') {
      const old = this._id
      this._id = ''
      if (old && this.ownerDocument._byId.get(old) === this) this.ownerDocument._byId.delete(old)
      return
    }
    delete this.attributes[name]
  }

  cloneNode(deep) {
    const copy = new FakeElement(String(this.tagName || 'div').toLowerCase(), this.ownerDocument)
    copy.className = this.className
    copy._textContent = this._textContent
    copy.attributes = { ...this.attributes }
    copy.style = { ...this.style }
    copy.__rect = { ...this.__rect }
    copy.__display = this.__display
    if (deep) {
      for (const child of this.children) copy.appendChild(child.cloneNode(true))
    }
    return copy
  }

  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node)
    if (node.parentElement) node.remove()
    const index = this.children.indexOf(reference)
    if (index < 0) return this.appendChild(node)
    node.parentElement = this
    this.children.splice(index, 0, node)
    this.ownerDocument._register(node)
    return node
  }

  appendChild(child) {
    if (child.parentElement) child.remove()
    child.parentElement = this
    this.children.push(child)
    this.ownerDocument._register(child)
    return child
  }

  remove() {
    const parent = this.parentElement
    if (parent) {
      const index = parent.children.indexOf(this)
      if (index >= 0) parent.children.splice(index, 1)
    }
    this.parentElement = null
    this.ownerDocument._unregister(this)
  }

  addEventListener(type, listener) {
    ;(this.listeners[type] || (this.listeners[type] = [])).push(listener)
  }

  removeEventListener(type, listener) {
    const list = this.listeners[type]
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, event) {
    for (const listener of this.listeners[type] || []) listener(event)
  }

  getBoundingClientRect() {
    return { ...this.__rect }
  }

  getClientRects() {
    return this.__rect.width > 0 && this.__rect.height > 0 ? [this.getBoundingClientRect()] : []
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const compounds = parseSelector(selector)
    return this._descendants().filter((element) =>
      compounds.some((compound) => matchCompound(element, compound)),
    )
  }

  _descendants() {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

class FakeDocument {
  constructor() {
    this._byId = new Map()
    this.documentElement = new FakeElement('html', this)
    this.head = new FakeElement('head', this)
    this.body = new FakeElement('body', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
  }

  createElement(tag) {
    return new FakeElement(tag, this)
  }

  getElementById(id) {
    return this._byId.get(String(id)) || null
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector)
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector)
  }

  _register(element) {
    if (element.id) this._byId.set(element.id, element)
  }

  _unregister(element) {
    if (element.id && this._byId.get(element.id) === element) this._byId.delete(element.id)
  }
}

// ── Stub React / react-dom ─────────────────────────────────────────────────

const stubReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value ?? null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const stubReactDom = {
  createRoot() {
    return { render() {}, unmount() {} }
  },
  render() {},
}

const stubs = {
  react: stubReact,
  'react-dom': stubReactDom,
  'react-dom/client': { createRoot: stubReactDom.createRoot },
}
const stubRequire = (id) => {
  if (id in stubs) return stubs[id]
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
}

// ── Stub browser globals + evaluate the client bundle ─────────────────────

const document = new FakeDocument()
const windowListeners = Object.create(null)
const windowStub = {
  document,
  location: { origin: 'http://127.0.0.1:3777', protocol: 'http:', host: '127.0.0.1:3777', port: '3777' },
  addEventListener(type, listener) {
    ;(windowListeners[type] || (windowListeners[type] = [])).push(listener)
  },
  removeEventListener(type, listener) {
    const list = windowListeners[type]
    if (!list) return
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  },
  dispatchEvent(event) {
    for (const listener of windowListeners[event.type] || []) listener(event)
    return true
  },
  getComputedStyle(element) {
    return {
      display: element.__display || 'flex',
      visibility: 'visible',
      opacity: '1',
    }
  },
  setTimeout(callback) {
    callback()
    return 0
  },
  clearTimeout() {},
}

class FakeCustomEvent {
  constructor(type) {
    this.type = type
  }
}
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    FakeMutationObserver.instances.push(this)
  }
  observe() {}
  disconnect() {}
}
FakeMutationObserver.instances = []

const loads = []
windowStub.__ModuleLoader__ = {
  load(registration) {
    loads.push(registration)
  },
}

const sandbox = {
  window: windowStub,
  document,
  MutationObserver: FakeMutationObserver,
  CustomEvent: FakeCustomEvent,
  setTimeout: windowStub.setTimeout,
  clearTimeout: windowStub.clearTimeout,
  console,
}
vm.createContext(sandbox)
new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInContext(sandbox)

assert.equal(loads.length, 1, 'bundle must register exactly one client module')
assert.equal(loads[0].id, 'dsh-project-hub')
const client = loads[0].factory(stubRequire)

// ── Build the shipped sidebar structure ────────────────────────────────────

const element = (tag, className) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

const sidebarCol = element('div', 'mP3x-q_sidebarCol')
const root = element('div', 'wtg9ga_root')
root.__rect = { width: 280, height: 800 }
sidebarCol.appendChild(root)
root.appendChild(element('div', 'wtg9ga_logoRow'))
root.appendChild(element('button', 'wtg9ga_newSession'))

// Native global-panel nav list: 「插件 / 自动化任务 / 更多」 rows, exactly the
// structure the shipped ui-sidebar renders (`nav._panelList` >
// `button._panelRow` > `span._panelGlyph` + `span._panelTitle`; the 「更多」
// row is wrapped in `div._moreAnchor` because it owns a popup menu).
const panelList = element('nav', 'wtg9ga_panelList')
panelList.__rect = { width: 256, height: 120 }
root.appendChild(panelList)

const makePanelRow = (label) => {
  const row = element('button', 'wtg9ga_panelRow')
  row.__rect = { width: 240, height: 36 }
  const glyph = element('span', 'wtg9ga_panelGlyph')
  glyph.__rect = { width: 16, height: 16 }
  row.appendChild(glyph)
  if (label) {
    const title = element('span', 'wtg9ga_panelTitle wtg9ga_wide')
    title.textContent = label
    row.appendChild(title)
  }
  return row
}
const moreAnchor = element('div', 'wtg9ga_moreAnchor')
const moreRow = makePanelRow('更多')
moreRow.setAttribute('aria-haspopup', 'menu')
moreRow.setAttribute('aria-expanded', 'false')
moreAnchor.appendChild(moreRow)
panelList.appendChild(makePanelRow('插件'))
panelList.appendChild(makePanelRow('自动化任务'))
panelList.appendChild(moreAnchor)

const regionArea = element('div', 'wtg9ga_regionArea')
regionArea.__rect = { width: 256, height: 600 }
root.appendChild(regionArea)
const browser = element('div', 'GAkraW_root')
regionArea.appendChild(browser)
const sectionHeader = element('div', 'GAkraW_sectionHeader')
browser.appendChild(sectionHeader)
sectionHeader.appendChild(element('div', 'GAkraW_searchSlot'))
const headerActions = element('div', 'GAkraW_headerActions')
headerActions.__rect = { width: 72, height: 24 }
sectionHeader.appendChild(headerActions)
headerActions.appendChild(element('button', 'GAkraW_iconButton'))
headerActions.appendChild(element('button', 'GAkraW_iconButton'))

const footArea = element('div', 'wtg9ga_footArea')
footArea.__rect = { width: 256, height: 40 }
root.appendChild(footArea)
const footerActions = element('div', 'wtg9ga_footerActions')
footerActions.__rect = { width: 200, height: 28 }
footArea.appendChild(footerActions)
footArea.appendChild(element('div', 'wtg9ga_settingsArea'))

document.body.appendChild(sidebarCol)

// ── apply(ctx): both slots injected, drawer host + DOM entries mounted ─────

const injected = []
const registered = []
const ctx = {
  slots: {
    inject(name, callback) {
      injected.push(name)
      return callback()
    },
    register(options, Component) {
      registered.push({ options, Component })
      return { dispose() {} }
    },
  },
  effect(factory, label) {
    factory()
    return { label }
  },
}

assert.doesNotThrow(() => client.apply(ctx), 'client apply() must not throw')
assert.ok(injected.includes('sidebar.footer.action'), 'footer.action slot must be injected')
assert.ok(injected.includes('sidebar.panellist.actions'), 'panellist.actions slot must be injected')
assert.ok(
  registered.some((row) => row.options.name === 'sidebar.footer.action'),
  'footer.action registration must be kept',
)
assert.ok(
  registered.some((row) => row.options.name === 'sidebar.panellist.actions'),
  'panellist.actions registration must exist',
)
assert.equal(injected.includes('sidebar.panellist'), false, 'the layout panel-list slot must never be touched')

const portalHost = document.getElementById('dsh-project-hub-portal-host')
assert.ok(portalHost, 'drawer portal host must be mounted')

// ── THE discoverable entry: a native-styled row in the sidebar nav list ────

const navRow = document.getElementById('dsh-project-hub-nav-row')
assert.ok(navRow, 'the nav-list entry row must be mounted')
assert.equal(navRow.parentElement, panelList, 'nav row must be mounted INTO the sidebar panel list <nav>')
assert.equal(
  panelList.children[panelList.children.length - 1],
  navRow,
  'nav row must sit below the native rows (after 「更多」), not reorder them',
)
assert.equal(navRow.tagName, 'BUTTON', 'the row is a button, like the native panel rows')
assert.ok(
  String(navRow.className).includes('wtg9ga_panelRow'),
  'nav row must reuse the native panel-row class for native spacing/hover',
)
assert.ok(String(navRow.className).includes('dsh-ph-nav-row'))
assert.equal(navRow.getAttribute('data-project-hub-entry'), '1')
assert.equal(navRow.getAttribute('aria-label'), '项目工坊')
const navGlyph = navRow.querySelector('[class*="_panelGlyph"]')
const navLabel = navRow.querySelector('[class*="_panelTitle"]')
assert.ok(navGlyph && navGlyph.textContent === '+', 'nav row must start with a minimal + glyph')
assert.ok(navLabel && navLabel.textContent === '项目工坊', 'nav row must show the 项目工坊 label')
assert.ok(
  String(navRow.textContent).includes('+') && String(navRow.textContent).includes('项目工坊'),
  'nav row must read as 「+ 项目工坊」',
)
assert.equal(client.__test__.isNavRowVisible(), true, 'nav row must validate as visible')
assert.ok(
  !String(navRow.className).includes('dsh-ph-nav-row-rail'),
  'wide sidebar keeps the text label',
)
assert.equal(String(panelList.children[0].textContent).trim(), '插件', 'native row order preserved')
assert.equal(String(panelList.children[1].textContent).trim(), '自动化任务', 'native row order preserved')
assert.equal(String(panelList.children[2].textContent).trim(), '更多', 'native row order preserved')

// The row styling is injected once as a `--dsw-*`-only stylesheet. The old
// header-widen rule (`:has(> #dsh-project-hub-entry-btn)`) is intentionally
// left alone but is inert now: this revision never creates that button.
const stylesheet = document.getElementById('dsh-project-hub-styles')
assert.ok(stylesheet, 'the entry stylesheet must be injected')
assert.ok(stylesheet.textContent.includes('.dsh-ph-nav-row'), 'nav-row CSS must be present')
assert.ok(stylesheet.textContent.includes('.dsh-ph-nav-row-rail'), 'rail CSS must be present')
assert.ok(stylesheet.textContent.includes('.dsh-ph-nav-glyph'), 'glyph CSS must be present')
assert.ok(stylesheet.textContent.includes('.dsh-ph-nav-label'), 'label CSS must be present')

// ── The workspace-header 4th icon (`+`) was REMOVED on user request ───────
//
// Core ui-workspace renders exactly three icons next to the 「工作区」 title:
// 搜索 (searchSlot) / 视图选项（滑杆）/ 添加工作区（文件夹+）in `headerActions`.
// An earlier revision of THIS plugin appended a plain `+` button into that
// `headerActions` row as a 4th icon; it triggered a UI bug, so neither the
// button nor its click handler may exist anymore.
assert.equal(
  document.getElementById('dsh-project-hub-entry-btn'),
  null,
  'the workspace-header + must not be mounted anymore (removed on user request)',
)
assert.equal(headerActions.children.length, 2, 'the native header actions keep their own two buttons')
for (const child of headerActions.children) {
  assert.ok(
    String(child.className).includes('GAkraW_iconButton'),
    'the native header icons are left untouched',
  )
}
assert.equal(
  document.querySelectorAll('[data-project-hub-entry="1"]').length,
  1,
  'only the nav row carries the plugin entry marker (no header + trigger)',
)
assert.equal(client.__test__.isDomEntryVisible(), true, 'the nav row keeps the footer occupant stood down')
assert.equal(typeof client.__test__.syncEntryButton, 'undefined', 'the removed header + has no sync path')
assert.equal(typeof client.__test__.isPaintedWithinClip, 'undefined', 'the removed header + clip validator is gone')

// ── Re-probing must never duplicate the SAME nav row ──────────────────────

client.__test__.syncNavEntry()
client.__test__.syncNavEntry()
assert.equal(document.querySelectorAll('[id="dsh-project-hub-nav-row"]').length, 1, 'never duplicate the nav row')
assert.equal(document.getElementById('dsh-project-hub-nav-row'), navRow, 're-probe must reuse the same node')
assert.equal(panelList.children.length, 4, 'nav list keeps exactly the three native rows + our row')
assert.equal(document.querySelectorAll('[data-project-hub-entry="1"]').length, 1, 'one trigger: the nav row')

// ── The remaining trigger dispatches the local toggle; layout is never touched ──

let toggles = 0
windowStub.addEventListener('dsh-project-hub:toggle-drawer', () => {
  toggles += 1
})
const clickEvent = () => ({
  preventDefault() {},
  stopPropagation() {},
})
navRow.dispatch('click', clickEvent())
assert.equal(toggles, 1, 'nav-row click must dispatch dsh-project-hub:toggle-drawer')

// ── Slot occupants stand down while the DOM entries paint ─────────────────

const footerRegistration = registered.find((row) => row.options.name === 'sidebar.footer.action')
assert.ok(footerRegistration && typeof footerRegistration.Component === 'function')
assert.equal(
  footerRegistration.Component(),
  null,
  'sidebar.footer.action occupant must stand down while a DOM entry is painted',
)
const menuRegistration = registered.find((row) => row.options.name === 'sidebar.panellist.actions')
assert.ok(menuRegistration && typeof menuRegistration.Component === 'function')
assert.equal(
  menuRegistration.Component({}),
  null,
  'the 「更多」 menu row must stand down while the nav row paints (no duplicate entry)',
)

// ── Collapsed Windows-titlebar rail: native panelList/regionArea/footArea
//    are display:none in the shipped CSS → the nav row relocates into the
//    sidebar rail column and becomes glyph-only. ─────────────────────────────

regionArea.__rect = { width: 0, height: 0 }
headerActions.__rect = { width: 0, height: 0 }
sectionHeader.__rect = { width: 0, height: 0 }
footArea.__rect = { width: 0, height: 0 }
footerActions.__rect = { width: 0, height: 0 }
panelList.__rect = { width: 0, height: 0 }
root.__rect = { width: 56, height: 800 }
FakeMutationObserver.instances[0].callback()
client.__test__.syncNavEntry()

const railNavRow = document.getElementById('dsh-project-hub-nav-row')
assert.equal(railNavRow, navRow, 'the rail state keeps the SAME nav-row node')
assert.equal(railNavRow.parentElement, root, 'collapsed sidebar relocates the nav row into the sidebar rail column')
assert.ok(
  String(railNavRow.className).includes('dsh-ph-nav-row-rail'),
  'collapsed rail mode must switch the nav row to glyph-only',
)
assert.ok(
  String(railNavRow.className).includes('wtg9ga_panelRow'),
  'the relocated row keeps the native panel-row class',
)
assert.equal(client.__test__.isNavRowVisible(), true, 'the rail glyph is a visible entry')
assert.equal(client.__test__.isDomEntryVisible(), true, 'the footer occupant stays stood down in the rail too')
assert.equal(
  document.getElementById('dsh-project-hub-entry-btn'),
  null,
  'the removed header + stays absent in the rail state',
)
assert.equal(panelList.children.length, 3, 'the collapsed native nav list keeps its three rows only')

// ── Re-expand: the same row moves back below 「更多」; no header + returns

regionArea.__rect = { width: 256, height: 600 }
headerActions.__rect = { width: 72, height: 24 }
sectionHeader.__rect = { width: 240, height: 36 }
footArea.__rect = { width: 256, height: 40 }
footerActions.__rect = { width: 200, height: 28 }
panelList.__rect = { width: 256, height: 120 }
root.__rect = { width: 280, height: 800 }
FakeMutationObserver.instances[0].callback()
client.__test__.syncNavEntry()

const expandedNavRow = document.getElementById('dsh-project-hub-nav-row')
assert.equal(expandedNavRow, navRow, 'expanding keeps the SAME nav-row node')
assert.equal(expandedNavRow.parentElement, panelList, 'the row returns INTO the native nav list')
assert.equal(
  panelList.children[panelList.children.length - 1],
  expandedNavRow,
  'the expanded row sits below 「更多」 again',
)
assert.ok(
  !String(expandedNavRow.className).includes('dsh-ph-nav-row-rail'),
  'expanded sidebar shows the 项目工坊 label again',
)
assert.equal(client.__test__.isNavRowVisible(), true)
assert.equal(
  document.getElementById('dsh-project-hub-entry-btn'),
  null,
  'no header + appears when the sidebar is expanded again',
)
assert.equal(document.querySelectorAll('[data-project-hub-entry="1"]').length, 1, 'still exactly one trigger, no duplicates')

// ── A React re-render erasing the row must be repaired by the observer ─────

const wipedRow = document.getElementById('dsh-project-hub-nav-row')
wipedRow.remove()
wipedRow.isConnected = false
FakeMutationObserver.instances[0].callback()
const recoveredRow = document.getElementById('dsh-project-hub-nav-row')
assert.ok(recoveredRow, 'a nav row wiped by a React re-render must be re-mounted')
assert.notEqual(recoveredRow, wipedRow, 'the detached node is replaced, not left orphaned')
assert.equal(recoveredRow.parentElement, panelList, 'the re-mounted row is back in the native nav list')
assert.equal(document.querySelectorAll('[id="dsh-project-hub-nav-row"]').length, 1, 're-mount never duplicates the row')
assert.equal(client.__test__.isNavRowVisible(), true)

// ── Vanished nav list: degrade to the sidebar root column, then recover ────

panelList.remove()
FakeMutationObserver.instances[0].callback()
assert.doesNotThrow(() => client.__test__.syncNavEntry(), 'a missing nav list must never throw')
assert.equal(
  document.getElementById('dsh-project-hub-nav-row').parentElement,
  root,
  'without a nav list the row degrades into the sidebar root column',
)
assert.equal(client.__test__.isNavRowVisible(), true, 'the degraded row is still a visible entry')

root.insertBefore(panelList, regionArea)
client.__test__.syncNavEntry()
assert.equal(
  document.getElementById('dsh-project-hub-nav-row').parentElement,
  panelList,
  'the row is re-attached once the native nav list comes back',
)
assert.equal(document.querySelectorAll('[id="dsh-project-hub-nav-row"]').length, 1, 'recovery never leaves a duplicate')

// A completely detached sidebar must not throw and must clean the row up.
sidebarCol.remove()
assert.doesNotThrow(() => client.__test__.syncNavEntry(), 'a detached sidebar must never throw')
assert.equal(client.__test__.isNavRowVisible(), false, 'a detached sidebar reports the row as not visible')
assert.equal(document.querySelectorAll('[data-project-hub-entry="1"]').length, 0, 'no entry paints while the sidebar is detached')
document.body.appendChild(sidebarCol)
client.__test__.syncNavEntry()
assert.equal(client.__test__.isNavRowVisible(), true, 'the row recovers with the sidebar')
assert.equal(document.querySelectorAll('[id="dsh-project-hub-nav-row"]').length, 1, 'no duplicate after recovery')

console.log('client entry: nav row 「+ 项目工坊」 below 「更多」 — OK (workspace-header + removed)')
console.log('  wide sidebar   -> nav row in <nav> (native _panelRow clone); native header icons untouched')
console.log('  collapsed rail -> the SAME row relocates to the sidebar rail, glyph-only')
