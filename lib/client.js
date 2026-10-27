// dsh-project-hub — lib/client.js
// Client half for DeepSeek Harness (DSH), 0.2.1-rc.3 desktop.
//
// TOP-LEVEL GUARD — the module bundle is loaded by the client module system
// (`@deepseek-ai/dsh-client-modules`), whose boot contract is:
//   1. the HTML (or the desktop preload's boot-injection table) installs the
//      `window.__ModuleLoader__` registration facade first;
//   2. the facade is then either in `mode: "queue"` (bundle executed before
//      the module system boots — registrations are queued) or live
//      (`load(registration)` forwards to the system);
//   3. only afterwards do the plugin bundles for the boot graph get fetched
//      and executed, and `arrive()` expects a bundle script to have called
//      `__ModuleLoader__.load({ id, factory })` by the time its `load` event
//      fires.
// A renderer reload (DevTools Ctrl+R) has been observed executing this
// bundle before the facade is published. The previous unconditional
// `window.__ModuleLoader__.load(...)` threw a top-level TypeError there; the
// module system reported `dsh-project-hub: import failed` and the whole shell
// landed on the 「web boot: 1 entry did not activate」 error page. So the
// bootstrap below NEVER throws: it registers immediately when the facade is
// already present, otherwise it polls (bounded, silent) and registers when the
// facade shows up, giving up silently at the deadline. No DOM code runs at the
// top level — everything document-related lives inside the factory, which the
// module system only calls after boot.
//
// DESIGN RULES (user constraints):
//   - no floating ball, no `shell.overlay`, no DOM piercing, no badge/toast;
//   - a single minimal `+` entry, `--dsw-*` tokens only, no colour emoji;
//   - drawer closes on backdrop click, outside click and Esc;
//   - the drawer never calls `layout.selectPanel` (local state only).
//
// ═══════════════════════════════════════════════════════════════════════════
// VERIFIED SLOT CONTRACT — 0.2.1-rc.3, read straight out of app.asar:
//   `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` registers the sidebar
//   factory with these children:
//     single : sidebar.brand.mark, sidebar.brand.name, sidebar.toggle.badge,
//              sidebar.workspaces, sidebar.settings
//     list   : sidebar.panellist, sidebar.panellist.actions,
//              sidebar.footer.action
//   SidebarRoot renders `renderSlot("sidebar.footer.action", { wide })` inside
//   `footArea` > `footerActions` (right above the settings gear), and
//   `sidebar.panellist.actions` is rendered INSIDE the panel list's 「更多」 popup
//   (it is the menu content, not the visible header row). Both are DECLARED
//   list slots; registering an undeclared name THROWS (`slot "X" is not
//   declared`), it is not a silent no-op.
//   The 「工作区」 section header (title + 搜索 + 视图选项 + 添加工作区) is
//   rendered by `@deepseek-ai/dsh-client-ui-workspace`
//   (`sectionHeader` > `headerActions`, native `max-width:60px`). That row is
//   NOT a slot and is NOT injected by this plugin anymore: an earlier revision
//   appended its own plain `+` there, producing a 4th icon that triggered a UI
//   bug, so the button was removed on user request (see ENTRY POINTS below).
//   The Windows-titlebar CSS hides `panelList`, `regionArea`
//   and `footArea` while the sidebar is collapsed
//   (`[data-windows-titlebar] .wtg9ga_collapsed .wtg9ga_footArea{display:none}`),
//   so a footer-only entry is invisible in the 56px rail state.
//
// ENTRY POINTS — every rendered trigger carries `data-project-hub-entry="1"`:
//   0. **THE RESTORED, USER-VISIBLE ONE** — a plain-text row in the sidebar's
//      native global-panel nav list (`nav._panelList`), below 「更多」:
//      `+ 项目工坊`. It is a DOM clone of the shell's own panel row
//      (`button._panelRow`), so it keeps the native padding/gap/radius/hover
//      and focus ring; only the glyph (`+`) and the label are ours. While the
//      native nav list is collapsed (56px Windows rail: `panelList` is
//      `display:none`) the ROW ITSELF relocates into the sidebar column
//      (`_root`) and switches to glyph-only (`.dsh-ph-nav-row-rail`), so the
//      discovered entry survives every sidebar state. It dispatches the same
//      `dsh-project-hub:toggle-drawer` event and never calls
//      `layout.selectPanel`; see `syncNavEntry`. While it paints, the
//      `sidebar.panellist.actions` menu row is suppressed to avoid a duplicate.
//   1. `sidebar.footer.action` — declared list slot, kept as the official seat
//      (renders only while no DOM entry is actually visible; see
//      `useDomEntryVisible`);
//   2. `sidebar.panellist.actions` — declared list slot, a `+` row inside the
//      panel list's 「更多」 menu (contract props: entries/onOpen/onPinnedChange/
//      onDismiss; it calls `onDismiss` when it opens the drawer);
//   3. REMOVED (user request): a plain `+` DOM button injected into the
//      workspace header action row. It painted as the 4th icon after the native
//      搜索 / 视图选项（滑杆）/ 添加工作区（文件夹+） controls and triggered a
//      UI bug, so this revision no longer renders it, no longer appends it to
//      `headerActions`, and no longer binds its click handler. The DOM probe
//      now only maintains the `+ 项目工坊` nav row (0); the plugin stays
//      reachable through (1) and (2) as before, and a stale button left in the
//      DOM by an older revision is cleaned up on install.
//
// Every trigger dispatches `dsh-project-hub:toggle-drawer` and never calls
// `layout.selectPanel`.
//
// DRAWER — owned by its own React root mounted into
// `#dsh-project-hub-portal-host`. Every trigger dispatches
// `dsh-project-hub:toggle-drawer`; the root app renders the drawer with
// `data-project-hub-drawer="1"` inside that host. It never calls
// `layout.selectPanel`. Acceptance handles:
//   document.querySelector('#dsh-project-hub-nav-row').parentElement === <nav>
//     (the `+ 项目工坊` row sits below 「更多」)
//   document.querySelectorAll('[data-project-hub-entry="1"]').length >= 1
//   document.querySelector('#dsh-project-hub-portal-host')
//     .querySelector('[data-project-hub-drawer="1"]')             !== null

// ═══════════════════════════════════════════════════════════════════════════
// BUNDLE-SCOPE WRAPPER — DSH serves every plugin `client.js` as a CLASSIC
// script (`<script src="dsh-app://app/plugins/??<id>/client.js&rev=...">`) and
// its live-reload path evaluates the SAME file again in the same realm when
// the bundle revision changes. Top-level `const`/`let` bindings would make
// that replay a SyntaxError ("Identifier 'PROJECT_HUB_MODULE_ID' has already
// been declared"), which the client module system reports as
// `dsh-project-hub: import failed` / `web boot: 1 entry did not activate`
// (observed in the 0.2.1-rc.3 renderer crash log). One IIFE keeps every
// binding script-local, so a replay is safe: the module system invalidates
// the old factory before the replacement script executes. The registration
// contract is unchanged — `__ModuleLoader__.load` is still called exactly
// once per evaluation and the guard below still never throws.
// ═══════════════════════════════════════════════════════════════════════════
;(function () {
/** Client module id (must equal the factory id the module system expects). */
const PROJECT_HUB_MODULE_ID = 'dsh-project-hub'
/** Poll cadence while the loader facade is still missing (renderer reload). */
const LOADER_POLL_INTERVAL_MS = 100
/** Hard stop for the loader poll: silently give up after this budget. */
const LOADER_POLL_BUDGET_MS = 10000

/** The live `window.__ModuleLoader__` facade, or null (never throws). */
function readModuleLoader() {
  try {
    if (typeof window === 'undefined' || window === null) return null
    const loader = window.__ModuleLoader__
    if (!loader || typeof loader.load !== 'function') return null
    return loader
  } catch {
    return null
  }
}

/**
 * Register this bundle with the client module system.
 *
 * Never throws. Registers right away when the facade exists; otherwise polls
 * (`setTimeout`, 100 ms, ≤ 10 s) and registers when the facade appears,
 * silently stopping at the deadline. Node stub tests rely on the timer being
 * `unref()`ed so evaluating the bundle cannot keep a test process alive.
 *
 * @param factory - the CJS-style client factory `(require) => module.exports`.
 */
function bootstrapClientModule(factory) {
  let registered = false

  const registerOnce = () => {
    if (registered) return true
    const loader = readModuleLoader()
    if (!loader) return false
    registered = true
    try {
      loader.load({ id: PROJECT_HUB_MODULE_ID, factory })
    } catch {
      /* duplicate/rejected registration must never escape the bundle */
    }
    return true
  }

  if (registerOnce()) return
  if (typeof setTimeout !== 'function') return

  const schedule = (callback, delay) => {
    const timer = setTimeout(callback, delay)
    try {
      if (timer && typeof timer.unref === 'function') timer.unref()
    } catch {
      /* browsers return a number */
    }
    return timer
  }

  const startedAt = Date.now()
  const poll = () => {
    if (registerOnce()) return
    if (Date.now() - startedAt >= LOADER_POLL_BUDGET_MS) return
    schedule(poll, LOADER_POLL_INTERVAL_MS)
  }
  schedule(poll, LOADER_POLL_INTERVAL_MS)
}

const projectHubClientFactory = (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    let reactDom = null
    try {
      reactDom = require('react-dom')
    } catch {
      reactDom = null
    }
    const createPortal =
      reactDom && typeof reactDom.createPortal === 'function'
        ? reactDom.createPortal
        : reactDom && reactDom.default && typeof reactDom.default.createPortal === 'function'
        ? reactDom.default.createPortal
        : null

    const ROOT_PORTAL_ID = 'dsh-project-hub-portal-host'
    /**
     * Legacy id of the removed workspace-header `+` (deleted on user request).
     * Only used to clean up a stale node after a hot reload — this revision
     * never creates an element with this id.
     */
    const ENTRY_BTN_ID = 'dsh-project-hub-entry-btn'
    /** The plain-text sidebar-nav row: `+ 项目工坊` (the discoverable entry). */
    const NAV_ROW_ID = 'dsh-project-hub-nav-row'
    const NAV_ROW_CLASS = 'dsh-ph-nav-row'
    const NAV_ROW_RAIL_CLASS = 'dsh-ph-nav-row-rail'
    const NAV_GLYPH_CLASS = 'dsh-ph-nav-glyph'
    const NAV_LABEL_CLASS = 'dsh-ph-nav-label'
    /** Only used when the shell's nav list is missing entirely (last resort). */
    const NAV_ROW_FALLBACK_CLASS = 'dsh-ph-nav-row-fallback'
    /** Acceptance marker on every entry trigger (slot-rendered or DOM-probed). */
    const ENTRY_ATTR = 'data-project-hub-entry'
    /** Acceptance marker on the drawer root, always inside the portal host. */
    const DRAWER_ATTR = 'data-project-hub-drawer'
    const TOGGLE_EVENT = 'dsh-project-hub:toggle-drawer'
    /** Fallback Host origin: the shipped desktop Web GUI listens here. */
    const DEFAULT_HOST_BASE = 'http://127.0.0.1:9760'
    /** Built-in 总工作区 root — the value `GET /project-hub/state` defaults to. */
    const DEFAULT_GLOBAL_WORKSPACE_ROOT = 'C:\\work'

    // ═══════════════════════════════════════════════════════════════════════
    // Host base URL — desktop `dsh-app://app/` vs. ordinary http(s) Web page
    // ═══════════════════════════════════════════════════════════════════════

    /** Keep only a real http(s) origin; `dsh-app://...` and junk become ''. */
    function normalizeHttpOrigin(value) {
      if (typeof value !== 'string' || value === '') return ''
      try {
        const url = new URL(value)
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
      } catch {
        /* not a URL */
      }
      return ''
    }

    // ── Desktop IPC bridge fallback ─────────────────────────────────────────
    // `preload-app.cjs` exposes `window.dshDesktopBoot.ready()`; it resolves
    // with `{ injections, streamBaseUrl }` where `streamBaseUrl` is the owned
    // Host's HTTP origin. The shipped web frontend uses it once and publishes
    // `__DSH_TRANSPORT__`, but reading it directly keeps this plugin correct on
    // a build where the transport global is published later (or not at all).
    let bridgedHostBase = ''
    let bridgeProbe = null

    function primeHostBaseFromBridge(scope) {
      const win = scope || (typeof window !== 'undefined' ? window : null)
      if (!win || !win.dshDesktopBoot || typeof win.dshDesktopBoot.ready !== 'function') {
        return Promise.resolve('')
      }
      if (bridgeProbe) return bridgeProbe
      bridgeProbe = Promise.resolve()
        .then(() => win.dshDesktopBoot.ready())
        .then((result) => {
          const origin = normalizeHttpOrigin(result && result.streamBaseUrl)
          if (origin) bridgedHostBase = origin
          return bridgedHostBase
        })
        .catch(() => {
          bridgeProbe = null
          return ''
        })
      return bridgeProbe
    }

    // ── Host origin resolution ─────────────────────────────────────────────
    /**
     * Resolve the Host HTTP origin for plugin routes.
     *
     * Order (first hit wins):
     *   1. `__DSH_TRANSPORT__.streamBaseUrl` — the desktop shell publishes the
     *      owned Host's HTTP origin here for every client plugin
     *      (`dsh-client-file-upload`/`dsh-client-ui-settings-account` read the
     *      same field). This is the origin of `http://127.0.0.1:<port>`.
     *   2. The origin learned from the `dshDesktopBoot.ready()` IPC bridge.
     *   3. `location.origin` when the page really is served over http(s)
     *      (browser / `dsh web` mode).
     *   4. `location.port` when a non-http document exposes a numeric port.
     *   5. The loopback default (`http://127.0.0.1:9760`).
     *
     * It never returns a `dsh-app://` URL.
     */
    function resolveHostBase(scope) {
      const win = scope || (typeof window !== 'undefined' ? window : null)

      let transport = null
      try {
        transport = win && win.__DSH_TRANSPORT__ ? win.__DSH_TRANSPORT__ : null
      } catch {
        transport = null
      }
      if (!transport && typeof globalThis !== 'undefined') {
        try {
          transport = globalThis.__DSH_TRANSPORT__ || null
        } catch {
          transport = null
        }
      }
      if (transport && typeof transport.streamBaseUrl === 'string') {
        const origin = normalizeHttpOrigin(transport.streamBaseUrl)
        if (origin) return origin
      }

      if (bridgedHostBase) return bridgedHostBase

      let location = null
      try {
        location = (win && win.location) || null
      } catch {
        location = null
      }
      if (location) {
        const origin = normalizeHttpOrigin(
          typeof location.origin === 'string' && location.origin !== 'null'
            ? location.origin
            : location.protocol && location.host
            ? `${location.protocol}//${location.host}`
            : '',
        )
        if (origin) return origin
        const port = Number(location.port)
        if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`
      }

      return DEFAULT_HOST_BASE
    }

    /** Absolute http(s) URL for one Host route; never a `dsh-app://` URL. */
    function buildApiUrl(base, path) {
      const cleanBase = String(base || DEFAULT_HOST_BASE).replace(/\/+$/, '')
      const cleanPath = '/' + String(path || '').replace(/^\/+/, '')
      if (!/^https?:\/\//i.test(cleanBase)) return cleanPath
      return cleanBase + cleanPath
    }

    async function fetchJson(url, init) {
      const res = await fetch(url, init)
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      return { ok: res.ok, status: res.status, data }
    }

    /**
     * Call one Host JSON route.
     *
     * Primary transport is the absolute Host origin resolved above (the route
     * answers CORS, including the PNA preflight). If the desktop shell refuses
     * that cross-origin call, fall back to the document-relative route, which
     * the shell's `dsh-app://` handler forwards to the same Host.
     */
    async function requestApi(path, options) {
      const config = options || {}
      const init = {
        method: config.method || 'GET',
        credentials: 'omit',
      }
      if (config.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(config.body)
      }

      let base = resolveHostBase()
      if (
        base === DEFAULT_HOST_BASE &&
        !bridgedHostBase &&
        typeof window !== 'undefined' &&
        window &&
        !window.__DSH_TRANSPORT__ &&
        window.dshDesktopBoot
      ) {
        const bridged = await primeHostBaseFromBridge()
        if (bridged) base = bridged
      }
      const target = buildApiUrl(base, path)
      let primaryError = null
      if (/^https?:\/\//i.test(target)) {
        try {
          return await fetchJson(target, init)
        } catch (error) {
          primaryError = error
        }
      }
      try {
        return await fetchJson(String(path).replace(/^\/+/, ''), init)
      } catch (error) {
        throw primaryError || error
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DOM helpers
    // ═══════════════════════════════════════════════════════════════════════

    function ensurePortalHost() {
      if (typeof document === 'undefined') return null
      let host = document.getElementById(ROOT_PORTAL_ID)
      if (!host) {
        const parent = document.body || document.documentElement
        if (!parent) return null
        host = document.createElement('div')
        host.id = ROOT_PORTAL_ID
        parent.appendChild(host)
      }
      return host
    }

    function formatTime(value) {
      const time = Number(value)
      if (!Number.isFinite(time) || time <= 0) return '时间未知'
      try {
        return new Date(time).toLocaleString()
      } catch {
        return '时间未知'
      }
    }

    /** Minimal dynamic stylesheet, 100 % `--dsw-*` tokens. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-project-hub-styles')) return
      const style = document.createElement('style')
      style.id = 'dsh-project-hub-styles'
      style.textContent = `
        .dsh-ph-backdrop {
          position: fixed; inset: 0;
          background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55));
          z-index: 10000; display: flex; align-items: center; justify-content: center;
          font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
          padding: 24px; box-sizing: border-box;
        }
        .dsh-ph-drawer-backdrop {
          position: fixed; inset: 0; z-index: 9998; background: transparent;
        }
        .dsh-ph-card {
          background: var(--dsw-alias-bg-layer-1, #1b1c21);
          border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.1));
          border-radius: var(--dsw-radius-lg, 16px);
          color: var(--dsw-alias-label-primary, #ededed);
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
          overflow: hidden; display: flex; flex-direction: column;
          box-sizing: border-box;
        }
        .dsh-ph-drawer {
          position: fixed; bottom: 58px; left: 12px; width: 340px;
          max-height: calc(100vh - 96px);
          background: var(--dsw-alias-bg-layer-1, #1b1c21);
          border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
          border-radius: var(--dsw-radius-md, 12px);
          box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55); z-index: 9999;
          color: var(--dsw-alias-label-primary, #ededed);
          padding: 12px; font-size: 13px; box-sizing: border-box;
          overflow-y: auto;
        }
        .dsh-ph-btn {
          background: var(--dsw-alias-bg-layer-2, #24262d);
          border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
          color: var(--dsw-alias-label-primary, #ededed);
          border-radius: var(--dsw-radius-sm, 8px);
          padding: 8px 14px; cursor: pointer; font-size: 12px; font-weight: 500;
          transition: background 0.16s ease, border-color 0.16s ease;
          display: inline-flex; align-items: center; justify-content: center;
          font-family: inherit; line-height: 1.4;
        }
        .dsh-ph-btn:hover {
          background: var(--dsw-alias-interactive-bg-hover, #2f323c);
          border-color: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.2));
        }
        /* Deterministic primary-button contrast — the label colour is NOT read
           from a theme token. Several plausible label tokens are absent from
           some shell builds (their #ffffff fallback produced white text on the
           near-white dark-theme fill, i.e. an apparently empty white block).
           CSS only defines the fill here; primaryButtonProps() +
           applyReadablePrimaryText() measure the *computed* background of
           every .dsh-ph-btn-primary after mount/hover and write an inline
           near-black / near-white label with the higher WCAG contrast. */
        .dsh-ph-btn-primary {
          background: var(--dsw-alias-button-primary-fill, #3b82f6);
          border-color: var(--dsw-alias-button-primary-fill, #3b82f6);
          font-weight: 600;
          /* No colour/background transition: the inline label colour is set by
             the callback ref before the first paint, and hover re-measures
             immediately — a fade would briefly show the wrong contrast. */
          transition: border-color 0.16s ease;
        }
        .dsh-ph-btn-primary:hover:not(:disabled) {
          background: var(--dsw-alias-button-primary-hover, #2563eb);
          border-color: var(--dsw-alias-button-primary-hover, #2563eb);
        }
        .dsh-ph-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .dsh-ph-entry-btn {
          width: 24px; height: 24px; padding: 0; margin: 0 4px;
          display: inline-flex; align-items: center; justify-content: center;
          flex: none; font-size: 16px; line-height: 1; font-family: inherit;
          background: transparent; border: 1px solid transparent;
          border-radius: var(--dsw-radius-sm, 6px);
          color: var(--dsw-alias-label-secondary, #9a9ca6);
          cursor: pointer; -webkit-app-region: no-drag;
          transition: background 0.16s ease, color 0.16s ease;
        }
        .dsh-ph-entry-btn:hover {
          color: var(--dsw-alias-label-primary, #ededed);
          background: var(--dsw-alias-interactive-bg-hover, #2f323c);
        }
        /* Joins the workspace browser's visible ⌕ ⇅ ＋ header action row. */
        .dsh-ph-entry-btn-header {
          width: 22px; height: 22px; margin: 0; font-size: 14px;
          border-radius: var(--dsw-radius-sm, 6px);
        }
        /* Sits in normal flow in the collapsed 56px sidebar rail. */
        .dsh-ph-entry-btn-rail {
          width: 28px; height: 28px; margin: 10px 0 0 0; font-size: 18px;
          align-self: center;
        }
        /* panellist.actions list entry: one row inside the 更多 menu. */
        .dsh-ph-menu-row {
          width: 100%; display: flex; align-items: center; gap: 8px;
          padding: 7px 10px; box-sizing: border-box; cursor: pointer;
          background: transparent; border: none; border-radius: var(--dsw-radius-sm, 6px);
          color: var(--dsw-alias-label-primary, #ededed);
          font-family: inherit; font-size: 13px; text-align: left; line-height: 1.3;
        }
        .dsh-ph-menu-row:hover {
          background: var(--dsw-alias-interactive-bg-hover, #2f323c);
        }
        .dsh-ph-menu-row-glyph {
          width: 16px; display: inline-flex; justify-content: center;
          color: var(--dsw-alias-label-secondary, #9a9ca6); font-size: 14px;
        }
        /* Sidebar nav row: a clone of the native panel row (native classes keep
           spacing, focus and hover highlight); these only add the glyph/label. */
        .dsh-ph-nav-row {
          -webkit-app-region: no-drag;
        }
        .dsh-ph-nav-glyph {
          font-size: 16px; font-weight: 400; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center;
          color: inherit;
        }
        .dsh-ph-nav-label {
          min-width: 0; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap;
        }
        /* 56px Windows rail: only the + glyph stays (native panels do the same). */
        .dsh-ph-nav-row.dsh-ph-nav-row-rail .dsh-ph-nav-label { display: none; }
        .dsh-ph-nav-row.dsh-ph-nav-row-rail {
          box-sizing: border-box; width: 36px; height: 36px;
          flex: none; align-self: center;
          margin: 0 auto 4px; padding: 0; gap: 0;
          justify-content: center; align-items: center;
          display: flex; border-radius: var(--dsw-radius-md, 10px);
        }
        /* Last-resort seat (only when the native nav list is absent): plain row. */
        .dsh-ph-nav-row-fallback {
          box-sizing: border-box; width: calc(100% - 4px); min-height: 36px;
          display: flex; align-items: center; gap: 8px;
          margin: 0 2px; padding: 7px 8px;
          border: none; border-radius: var(--dsw-radius-md, 10px);
          background: transparent; color: var(--dsw-alias-label-primary, #ededed);
          font-family: inherit; font-size: 14px; line-height: 22px;
          text-align: left; cursor: pointer;
        }
        .dsh-ph-nav-row-fallback:hover {
          background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
        }
        /* The workspace header icon row is max-width:60px; overflow:hidden and
           is already exactly full with the shell's own two 28px icons
           (2×28 + 4 gap). Widen it by exactly one 22px slot + gap while our
           + is inside, otherwise the button is laid out beyond the clip box
           and paints outside the visible row. Scoped to :has(our button), so
           removing the entry restores the native row untouched. */
        [class*="_headerActions"]:has(> #dsh-project-hub-entry-btn) {
          max-width: 90px; transition: none;
        }
        /* ── Native-looking form controls ───────────────────────────────────
           Mirrors the shipped DSH settings form (dsh-client-ui-settings): a
           32px control on the layer-3 surface, 1px l4 border, radius-md and
           the shell's own focus ring. The appearance override + a custom inline
           SVG chevron replace the OS-drawn <select> chrome, which is what made
           the 「归类历史」 dropdowns look alien inside the dark shell.
           Every token below exists in test/dsw-token-manifest.json (the
           app.asar theme scan).                                                   */
        .dsh-ph-input {
          -webkit-appearance: none;
          appearance: none;
          background-color: var(--dsw-alias-bg-layer-3);
          border: 1px solid var(--dsw-alias-border-l4);
          color: var(--dsw-alias-label-primary);
          border-radius: var(--dsw-radius-md);
          height: 32px;
          padding: 0 12px;
          width: 100%;
          box-sizing: border-box;
          outline: none;
          font: inherit;
          font-size: 13px;
          line-height: 20px;
          transition: border-color 0.16s ease, background-color 0.16s ease;
        }
        .dsh-ph-input:hover:not(:disabled) {
          border-color: var(--dsw-alias-border-l3);
        }
        .dsh-ph-input:focus,
        .dsh-ph-input:focus-visible {
          outline: var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);
          outline-offset: 1px;
          border-color: var(--dsw-alias-state-business-primary);
        }
        .dsh-ph-input:disabled {
          background-color: var(--dsw-alias-bg-layer-2);
          color: var(--dsw-alias-label-tertiary);
          border-color: var(--dsw-alias-border-l2);
          opacity: 0.55;
          cursor: not-allowed;
        }
        /* Chevron = DSH's own 12px chevron (stroke %2381858C), right-aligned
           with room reserved by padding-right so it never overlaps the text.
           background-color stays on .dsh-ph-input — the background shorthand
           here would erase this image. */
        .dsh-ph-select {
          cursor: pointer;
          padding: 0 32px 0 12px;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
          background-position: right 10px center;
          background-repeat: no-repeat;
          background-size: 12px 12px;
        }
        .dsh-ph-select:disabled {
          cursor: not-allowed;
        }
        /* Native select popup: explicit option colours keep the list readable in
           both the dark and light shell (no light label on an OS-white popup). */
        .dsh-ph-select option {
          background-color: var(--dsw-alias-bg-layer-2);
          color: var(--dsw-alias-label-primary);
        }
        .dsh-ph-select option:disabled {
          color: var(--dsw-alias-label-tertiary);
        }
        datalist option {
          background-color: var(--dsw-alias-bg-layer-2);
          color: var(--dsw-alias-label-primary);
        }
        /* One shared label rhythm for every modal field (12px secondary). */
        .dsh-ph-field-label {
          color: var(--dsw-alias-label-secondary);
          font-size: 12px;
          line-height: 1.4;
          margin-bottom: 6px;
        }
        /* 总工作区设置 — inline, non-blocking error; never a toast/popup. */
        .dsh-ph-settings-error {
          margin-top: 4px;
          color: var(--dsw-alias-state-error-primary);
          font-size: 12px;
          line-height: 1.5;
        }
        /* 「保存」 = the shell's real settings save button: label-primary fill
           with the inverted layer-3 label. Deliberately NOT a
           .dsh-ph-btn-primary (it must not enter the measured-contrast path). */
        .dsh-ph-settings-save {
          background: var(--dsw-alias-label-primary);
          color: var(--dsw-alias-bg-layer-3);
          border: 1px solid transparent;
          border-radius: var(--dsw-radius-md);
          height: 32px;
          padding: 0 16px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
        }
        /* Re-state the fill on hover: the generic .dsh-ph-btn:hover rule must
           never repaint this button with the neutral hover surface (it would
           leave the inverted label unreadable). */
        .dsh-ph-settings-save:hover:not(:disabled) {
          background: var(--dsw-alias-label-primary);
          color: var(--dsw-alias-bg-layer-3);
          border-color: transparent;
          opacity: 0.85;
        }
        .dsh-ph-settings-save:disabled {
          opacity: 0.4;
          cursor: default;
        }
        /* Drawer footer 「设置」 entry — quiet text row, no primary fill. */
        .dsh-ph-settings-entry {
          width: 100%;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 6px;
          margin: 0;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--dsw-radius-sm);
          color: var(--dsw-alias-label-secondary);
          font-family: inherit;
          font-size: 12px;
          line-height: 1.4;
          text-align: left;
          cursor: pointer;
          transition: color 0.16s ease, background 0.16s ease;
        }
        .dsh-ph-settings-entry:hover {
          color: var(--dsw-alias-label-primary);
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-ph-settings-entry svg {
          flex: none;
        }
        /* ── Custom themed dropdown (replaces the OS-drawn native popup) ─────
           The OPEN <select> list was OS-drawn and looked crude inside the dark
           shell, so the ingest form now renders its own listbox. The trigger
           keeps the .dsh-ph-input/.dsh-ph-select skin above (do not restyle that
           block); this menu is position:fixed so it escapes the modal card's
           overflow:hidden, uses the shell surface/border/shadow tokens and a
           themed scrollbar, and layers above the modal (z-index 10020). */
        .dsh-ph-dropdown {
          position: relative;
        }
        .dsh-ph-dropdown-trigger {
          display: flex;
          align-items: center;
          gap: 8px;
          text-align: left;
          cursor: pointer;
        }
        .dsh-ph-dropdown-trigger[aria-expanded='true'] {
          border-color: var(--dsw-alias-state-business-primary);
        }
        .dsh-ph-dropdown-value {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-ph-dropdown-placeholder {
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-ph-dropdown-menu {
          position: fixed;
          z-index: 10020;
          padding: 4px;
          box-sizing: border-box;
          overflow-y: auto;
          overscroll-behavior: contain;
          background-color: var(--dsw-alias-bg-layer-2);
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: var(--dsw-radius-md);
          box-shadow: var(--dsw-shadow-lv3);
          color: var(--dsw-alias-label-primary);
          font-family: inherit;
          font-size: 13px;
          line-height: 20px;
          scrollbar-width: thin;
          scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent;
        }
        .dsh-ph-dropdown-menu::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .dsh-ph-dropdown-menu::-webkit-scrollbar-track {
          background: transparent;
        }
        .dsh-ph-dropdown-menu::-webkit-scrollbar-thumb {
          background: var(--dsw-alias-scrollbar-bg-l1);
          border-radius: var(--dsw-radius-sm);
        }
        .dsh-ph-dropdown-menu::-webkit-scrollbar-thumb:hover {
          background: var(--dsw-alias-scrollbar-hover-l1);
        }
        .dsh-ph-dropdown-option {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 8px;
          border-radius: var(--dsw-radius-sm);
          color: var(--dsw-alias-label-primary);
          font-size: 13px;
          line-height: 20px;
          cursor: pointer;
          transition: background-color 0.12s ease;
        }
        .dsh-ph-dropdown-option:hover,
        .dsh-ph-dropdown-option.is-active {
          background-color: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-ph-dropdown-option.is-selected {
          color: var(--dsw-alias-state-business-primary);
        }
        .dsh-ph-dropdown-option-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dsh-ph-dropdown-check {
          flex: none;
          color: var(--dsw-alias-state-business-primary);
          font-size: 12px;
          line-height: 20px;
        }
        .dsh-ph-dropdown-empty {
          padding: 6px 8px;
          color: var(--dsw-alias-label-tertiary);
          font-size: 12px;
          line-height: 20px;
        }
        .dsh-ph-dropdown-divider {
          height: 1px;
          margin: 4px 6px;
          background-color: var(--dsw-alias-border-l1);
        }
        .dsh-ph-dropdown-create {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 6px 8px;
          border: none;
          border-radius: var(--dsw-radius-sm);
          background: transparent;
          color: var(--dsw-alias-label-secondary);
          font-family: inherit;
          font-size: 13px;
          line-height: 20px;
          text-align: left;
          cursor: pointer;
        }
        .dsh-ph-dropdown-create:hover,
        .dsh-ph-dropdown-create:focus-visible {
          background-color: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-primary);
          outline: none;
        }
        .dsh-ph-dropdown-create-glyph {
          flex: none;
          color: var(--dsw-alias-state-business-primary);
          font-size: 14px;
          line-height: 20px;
        }
        /* Nested 新建小标签 dialog: layers ABOVE the open menu (10020) and the
           ingest modal, and takes its own backdrop/keys so neither the menu nor
           the modal closes underneath it. */
        .dsh-ph-dropdown-dialog-backdrop {
          position: fixed;
          inset: 0;
          z-index: 10030;
          background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55));
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
        }
        .dsh-ph-dropdown-dialog {
          position: relative;
          z-index: 10040;
          width: 380px;
          max-width: 90vw;
          max-height: 86vh;
          overflow-y: auto;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 20px;
          border-radius: var(--dsw-radius-md);
          border: 1px solid var(--dsw-alias-border-l2);
          background-color: var(--dsw-alias-bg-layer-1);
          box-shadow: var(--dsw-shadow-lv3);
          color: var(--dsw-alias-label-primary);
        }
        .dsh-ph-dropdown-dialog-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
        }
        .dsh-ph-dropdown-dialog-context {
          font-size: 11px;
          line-height: 1.5;
          color: var(--dsw-alias-label-tertiary);
          word-break: break-all;
        }
        .dsh-ph-dropdown-dialog-error {
          margin-top: 4px;
          color: var(--dsw-alias-state-error-primary);
          font-size: 12px;
          line-height: 1.5;
        }
        .dsh-ph-hint {
          margin: 6px 0 0; font-size: 11px; line-height: 1.5;
          color: var(--dsw-alias-label-tertiary, #777a86);
        }
        .dsh-ph-project-row {
          padding: 10px 12px; border-radius: var(--dsw-radius-sm, 8px);
          cursor: pointer; border: 1px solid transparent;
          transition: background 0.16s ease, border-color 0.16s ease;
        }
        .dsh-ph-project-row:hover {
          background: var(--dsw-alias-bg-layer-2, #23252c);
          border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
        }
        .dsh-ph-project-row {
          display: flex; align-items: center; gap: 8px;
        }
        .dsh-ph-project-main { flex: 1; min-width: 0; }
        /* “移出列表” — text-only unregister action, never a physical delete. */
        .dsh-ph-remove-btn {
          flex: none; padding: 2px 4px; border: none; border-radius: var(--dsw-radius-sm, 6px);
          background: transparent; color: var(--dsw-alias-label-tertiary, #777a86);
          font-family: inherit; font-size: 11px; line-height: 1.4; cursor: pointer;
        }
        .dsh-ph-remove-btn:hover {
          color: var(--dsw-alias-label-primary, #ededed);
          background: var(--dsw-alias-interactive-bg-hover, #2f323c);
        }
        /* Quiet inline 「刷新」 action (drawer header + 启动会话 tag list): a
           text button on the same tokens as 「移出列表」, never a filled button. */
        .dsh-ph-refresh-btn {
          flex: none; padding: 2px 4px; border: none; border-radius: var(--dsw-radius-sm, 6px);
          background: transparent; color: var(--dsw-alias-label-tertiary, #777a86);
          font-family: inherit; font-size: 11px; line-height: 1.4; cursor: pointer;
        }
        .dsh-ph-refresh-btn:hover:not(:disabled) {
          color: var(--dsw-alias-label-primary, #ededed);
          background: var(--dsw-alias-interactive-bg-hover, #2f323c);
        }
        .dsh-ph-refresh-btn:disabled { opacity: 0.55; cursor: default; }
        /* Inline 新建小标签 failure: role=alert text, never a toast/popup. */
        .dsh-ph-inline-error {
          margin-top: 6px;
          color: var(--dsw-alias-state-error-primary);
          font-size: 12px;
          line-height: 1.5;
        }
        /* Inline confirmation row inside the drawer (no window.confirm). */
        .dsh-ph-confirm-row {
          margin: 2px 0 8px; padding: 8px 10px;
          display: flex; flex-direction: column; gap: 8px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
          border-radius: var(--dsw-radius-sm, 8px);
          background: var(--dsw-alias-bg-layer-2, #24262d);
          color: var(--dsw-alias-label-secondary, #9a9ca6);
          font-size: 11px; line-height: 1.5;
        }
        .dsh-ph-confirm-actions {
          display: flex; justify-content: flex-end; gap: 8px;
        }
        .dsh-ph-btn-sm { padding: 4px 10px; font-size: 11px; }
        .dsh-ph-session-row {
          display: block; padding: 12px 14px;
          border-radius: var(--dsw-radius-sm, 8px);
          border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
          background: var(--dsw-alias-bg-layer-1, #18191e);
          cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease;
        }
        .dsh-ph-session-row.is-checked {
          border-color: var(--dsw-alias-button-primary-fill, #3b82f6);
          background: var(--dsw-alias-bg-layer-2, #23252d);
        }
        .dsh-ph-muted {
          font-size: 11px; color: var(--dsw-alias-label-tertiary, #777a86);
          font-family: monospace; margin-top: 4px; word-break: break-all;
        }
      `
      document.head.appendChild(style)
    }

    /**
     * True only for a connected element that actually paints.
     *
     * Strict on purpose (the entry contract): a zero-sized box, a detached
     * `offsetParent` (display:none somewhere up the tree) or a hidden computed
     * style all mean "not visible".
     */
    function isVisible(element) {
      if (!element || !element.isConnected) return false
      try {
        const rect = element.getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0)) return false
        if (element.offsetParent === null) return false
        const style = window.getComputedStyle(element)
        if (!style) return false
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      } catch {
        return false
      }
    }

    /** Container-level visibility: does this seat have a painted box at all? */
    function isSeatVisible(seat) {
      if (!seat || !seat.isConnected) return false
      try {
        const rect = seat.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      } catch {
        return false
      }
    }

    // ── DOM-entry visibility store ─────────────────────────────────────────
    /**
     * True while the DOM-mounted `+ 项目工坊` nav row is on screen. The official
     * `sidebar.footer.action` occupant subscribes to it and renders nothing
     * while that is the case, so the sidebar never stacks a second entry on top
     * of it.
     */
    let domEntryVisible = false
    const domEntrySubscribers = new Set()
    /** True while the plain-text `+ 项目工坊` nav row is mounted AND paints. */
    let navRowVisible = false
    const navRowSubscribers = new Set()

    /** Recompute the shared "a DOM entry is visible" flag. */
    function refreshDomEntryVisible() {
      setDomEntryVisible(navRowVisible)
    }

    function setDomEntryVisible(next) {
      const value = Boolean(next)
      if (domEntryVisible === value) return
      domEntryVisible = value
      for (const notify of [...domEntrySubscribers]) {
        try {
          notify()
        } catch {
          /* a re-render listener must never break the probe */
        }
      }
    }

    /** Subscribe a React occupant to the DOM-entry visibility flag. */
    function useDomEntryVisible() {
      const [visible, setVisible] = React.useState(domEntryVisible)
      React.useEffect(() => {
        const notify = () => setVisible(domEntryVisible)
        domEntrySubscribers.add(notify)
        notify()
        return () => {
          domEntrySubscribers.delete(notify)
        }
      }, [])
      return visible
    }

    /** Subscribe a React occupant to the nav-row visibility flag. */
    function useNavRowVisible() {
      const [visible, setVisible] = React.useState(navRowVisible)
      React.useEffect(() => {
        const notify = () => setVisible(navRowVisible)
        navRowSubscribers.add(notify)
        notify()
        return () => {
          navRowSubscribers.delete(notify)
        }
      }, [])
      return visible
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Sidebar nav-row entry — `+ 项目工坊`, a row in the native panel list
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The visible, unambiguous entry of the plugin. Instead of another glyph
    // among the workspace-header icons (where a `+` cannot be told apart from
    // the shell's own controls), it is a ROW in the sidebar's global panel
    // navigation — the 「新会话 / 插件 / 自动化任务 / 更多」 column — labelled
    // 「项目工坊」. It is a CLONE of the shell's own panel row, so it inherits
    // the native padding/gap/radius/hover/focus ring; only the glyph (`+`) and
    // the label text are ours. It is inserted directly below 「更多」 and never
    // reorders the native rows.
    //
    // The row is DOM-mounted because the nav list is
    // not a declared injection slot. It is re-validated on every shell
    // mutation. The 56px Windows rail natively sets `display:none` on the whole
    // nav list, so the row RELOCATES into the sidebar root column and becomes
    // glyph-only (`.dsh-ph-nav-row-rail`); when the sidebar expands it moves
    // back below 「更多」. It is never left detached and never duplicated.

    /** `{row, glyph, label, seat, kind}` of the mounted nav entry (null when absent). */
    let navRow = null

    function setNavRowVisible(next) {
      const value = Boolean(next)
      if (navRowVisible === value) return
      navRowVisible = value
      for (const notify of [...navRowSubscribers]) {
        try {
          notify()
        } catch {
          /* a re-render listener must never break the probe */
        }
      }
    }

    /** Add/remove ONE class token without disturbing the native class list. */
    function setClassToken(element, token, enabled) {
      if (!element) return
      try {
        const current = String(element.className || '')
        const tokens = current
          .split(/\s+/)
          .filter(Boolean)
          .filter((value) => value !== token)
        if (enabled) tokens.push(token)
        const next = tokens.join(' ')
        // Only touch the attribute when it actually changes: the entry probe
        // observes `class`, so a no-op rewrite would keep re-scheduling itself.
        if (current !== next) element.className = next
      } catch {
        /* class juggling is cosmetic */
      }
    }

    function addClassToken(element, token) {
      if (!element) return
      try {
        const tokens = String(element.className || '').split(/\s+/).filter(Boolean)
        if (!tokens.includes(token)) tokens.push(token)
        element.className = tokens.join(' ')
      } catch {
        /* ignore */
      }
    }

    /**
     * Find the sidebar's global-panel `<nav>` list
     * (`nav._panelList` in 0.2.1-rc.3, the 「插件 / 自动化任务 / 更多」 column).
     * Structural probes, not one hard-coded compiled class hash.
     */
    function findNavList(root) {
      if (!root) return null
      const lists = []
      try {
        for (const node of root.querySelectorAll('[class*="_panelList"]')) {
          if (node && node.isConnected) lists.push(node)
        }
      } catch {
        /* selector unsupported */
      }
      if (lists.length > 0) {
        for (const node of lists) {
          try {
            if (String(node.tagName || '').toLowerCase() === 'nav') return node
          } catch {
            /* keep looking */
          }
        }
        return lists[0]
      }
      // Fallback: any <nav> whose children look like panel rows.
      try {
        for (const node of root.querySelectorAll('nav')) {
          if (!node || !node.isConnected) continue
          let looksLikePanels = false
          try {
            looksLikePanels = node.querySelectorAll('[class*="_panelRow"]').length > 0
          } catch {
            looksLikePanels = false
          }
          if (looksLikePanels) return node
        }
      } catch {
        /* ignore */
      }
      return null
    }

    /** The native row to clone — 「更多」 when present, else the last panel row. */
    function findNativePanelRow(navList) {
      let rows = []
      try {
        rows = Array.from(navList.querySelectorAll('[class*="_panelRow"]'))
      } catch {
        rows = []
      }
      if (rows.length === 0) {
        try {
          rows = Array.from(navList.children || []).filter(
            (child) => child && String(child.tagName || '').toLowerCase() === 'button',
          )
        } catch {
          rows = []
        }
      }
      for (const row of rows) {
        try {
          if (String(row.textContent || '').trim() === '更多') return row
        } catch {
          /* keep looking */
        }
      }
      return rows.length > 0 ? rows[rows.length - 1] : null
    }

    /** True while the sidebar is in the 56px rail (collapsed) state. */
    function isRailSidebar(root) {
      try {
        const rect = root && typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null
        if (rect && rect.width > 0 && rect.width < 120) return true
        let node = root
        while (node && node !== document.documentElement) {
          if (String(node.className || '').includes('_collapsed')) return true
          node = node.parentElement
        }
      } catch {
        /* fall through */
      }
      return false
    }

    /**
     * Build the nav row: clone the native panel row (native structure + classes
     * → native spacing, hover and focus ring) and swap in `+` / 「项目工坊」.
     * Robust when the shell changes: missing glyph/title nodes are created, and
     * with no reference row at all a plain row is built with `--dsw-*` styles.
     */
    function createNavRow(refRow) {
      try {
        ensureStyles()
      } catch {
        /* styles are cosmetic */
      }
      let row = null
      let cloned = false
      if (refRow && typeof refRow.cloneNode === 'function') {
        try {
          row = refRow.cloneNode(true)
          cloned = Boolean(row)
        } catch {
          row = null
          cloned = false
        }
      }
      if (!row) {
        row = document.createElement('button')
        cloned = false
      }

      // Never inherit the native row's transient state (e.g. the 「更多」
      // popup being open marks it `_panelActive`); only the row layout classes
      // are reused.
      const baseClasses = String(row.className || '')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !/_panelActive$/.test(token))
      row.className = baseClasses.concat(NAV_ROW_CLASS).concat(cloned ? [] : [NAV_ROW_FALLBACK_CLASS]).join(' ')
      row.id = NAV_ROW_ID
      row.setAttribute('type', 'button')
      row.setAttribute('title', '项目工坊')
      row.setAttribute('aria-label', '项目工坊')
      row.setAttribute(ENTRY_ATTR, '1')
      for (const name of ['aria-haspopup', 'aria-expanded', 'aria-current', 'aria-pressed', 'disabled']) {
        if (typeof row.removeAttribute === 'function') {
          try {
            row.removeAttribute(name)
          } catch {
            /* ignore */
          }
        }
      }

      let glyph = null
      let label = null
      try {
        glyph = row.querySelector('[class*="_panelGlyph"]')
      } catch {
        glyph = null
      }
      try {
        label = row.querySelector('[class*="_panelTitle"]')
      } catch {
        label = null
      }
      if (!glyph) {
        glyph = document.createElement('span')
        glyph.className = 'dsh-ph-panel-glyph'
        if (label && label.parentElement === row && typeof row.insertBefore === 'function') {
          try {
            row.insertBefore(glyph, label)
          } catch {
            row.appendChild(glyph)
          }
        } else {
          row.appendChild(glyph)
        }
      }
      if (!label) {
        label = document.createElement('span')
        row.appendChild(label)
      }
      addClassToken(glyph, NAV_GLYPH_CLASS)
      addClassToken(label, NAV_LABEL_CLASS)
      glyph.textContent = '+'
      label.textContent = '项目工坊'

      row.addEventListener('click', (event) => {
        try {
          event.preventDefault()
          event.stopPropagation()
        } catch {
          /* ignore */
        }
        dispatchToggle()
      })
      row.addEventListener('mousedown', (event) => {
        try {
          event.stopPropagation()
        } catch {
          /* ignore */
        }
      })
      return { row, glyph, label, cloned, seat: null, kind: null }
    }

    /** Detach the nav-row trigger (teardown / seat change only). */
    function removeNavRow() {
      try {
        if (navRow && navRow.row) navRow.row.remove()
      } catch {
        /* ignore */
      }
      try {
        const stale = document.getElementById(NAV_ROW_ID)
        if (stale) stale.remove()
      } catch {
        /* ignore */
      }
      navRow = null
    }

    /** Insert the row directly after 「更多」 (append when no anchor exists). */
    function insertNavRow(navList, row) {
      const anchor = findNativePanelRow(navList)
      if (anchor && anchor.parentElement === navList) {
        const siblings = Array.from(navList.children || [])
        const index = siblings.indexOf(anchor)
        if (index >= 0) {
          navList.insertBefore(row, siblings[index + 1] || null)
          return
        }
      }
      navList.appendChild(row)
    }

    /** Insert the row in the sidebar's own column, under the new-session row. */
    function insertNavRowInRail(root, row) {
      let anchor = null
      try {
        anchor = root.querySelector('[class*="_newSession"]')
      } catch {
        anchor = null
      }
      if (anchor && anchor.parentElement === root) {
        const siblings = Array.from(root.children || [])
        const index = siblings.indexOf(anchor)
        if (index >= 0) {
          root.insertBefore(row, siblings[index + 1] || null)
          return
        }
      }
      root.appendChild(row)
    }

    /**
     * Pick the seat for the nav row:
     *   1. the native panel `<nav>` list while it paints (wide sidebar);
     *   2. otherwise the sidebar root column (56px Windows rail, or a shell
     *      that no longer renders the panel list at all).
     */
    function findNavRowSeat(root) {
      const navList = findNavList(root)
      if (navList && isSeatVisible(navList)) return { seat: navList, kind: 'nav', navList }
      if (root && root.isConnected) return { seat: root, kind: 'rail', navList }
      return null
    }

    /** The native row the nav row would clone for this seat (null when none). */
    function referenceRowFor(seatInfo) {
      if (!seatInfo) return null
      try {
        if (seatInfo.kind === 'nav') return findNativePanelRow(seatInfo.seat)
        return seatInfo.navList ? findNativePanelRow(seatInfo.navList) : null
      } catch {
        return null
      }
    }

    /** Insert/move the row into the given seat (nav list or rail column). */
    function insertRowIntoSeat(seat, kind, row) {
      if (kind === 'nav') insertNavRow(seat, row)
      else insertNavRowInRail(seat, row)
    }

    /** Clone + insert the row into the given seat; null when the DOM threw. */
    function mountNavRow(root, seatInfo) {
      const refRow = referenceRowFor(seatInfo)
      const built = createNavRow(refRow)
      try {
        insertRowIntoSeat(seatInfo.seat, seatInfo.kind, built.row)
      } catch {
        return null
      }
      built.seat = seatInfo.seat
      built.kind = seatInfo.kind
      return built
    }

    /**
     * Keep the `+ 项目工坊` row painted in the sidebar.
     *
     * Never throws. Re-adds the row when React wipes it, moves it between the
     * native nav list and the sidebar rail column, and never leaves a
     * duplicate node behind. A row whose rect/offsetParent says "not painted"
     * is relocated to the root column instead of being trusted blindly.
     */
    function syncNavEntry() {
      try {
        if (typeof document === 'undefined') return
        const root = findSidebarRoot()
        if (!root) {
          removeNavRow()
          setNavRowVisible(false)
          refreshDomEntryVisible()
          return
        }

        // Never allow two rows: drop a stale copy (React re-rendered the list,
        // or a previous seat created its own node).
        let stale = null
        try {
          const copies = document.querySelectorAll('[id="' + NAV_ROW_ID + '"]')
          if (copies.length > 0) stale = copies[0]
          for (let index = 1; index < copies.length; index += 1) {
            try {
              copies[index].remove()
            } catch {
              /* ignore */
            }
          }
        } catch {
          stale = null
        }
        if (stale && (!navRow || stale !== navRow.row)) {
          try {
            stale.remove()
          } catch {
            /* ignore */
          }
        }
        if (navRow && navRow.row && !navRow.row.isConnected) navRow = null

        let seatInfo = findNavRowSeat(root)
        if (!seatInfo) {
          removeNavRow()
          setNavRowVisible(false)
          refreshDomEntryVisible()
          return
        }

        // Seat changed (expand/collapse, shell re-render): move the SAME node
        // to the new seat. Only rebuild when the native clone reference
        // availability changed (the native panel classes no longer match).
        if (navRow && (navRow.seat !== seatInfo.seat || navRow.kind !== seatInfo.kind)) {
          const canClone = Boolean(referenceRowFor(seatInfo))
          if (navRow.cloned === canClone) {
            try {
              insertRowIntoSeat(seatInfo.seat, seatInfo.kind, navRow.row)
              navRow.seat = seatInfo.seat
              navRow.kind = seatInfo.kind
            } catch {
              try {
                navRow.row.remove()
              } catch {
                /* ignore */
              }
              navRow = null
            }
          } else {
            try {
              navRow.row.remove()
            } catch {
              /* ignore */
            }
            navRow = null
          }
        }

        if (!navRow) navRow = mountNavRow(root, seatInfo)
        if (!navRow) {
          setNavRowVisible(false)
          refreshDomEntryVisible()
          return
        }

        setClassToken(navRow.row, NAV_ROW_RAIL_CLASS, seatInfo.kind === 'rail' || isRailSidebar(root))
        if (!isVisible(navRow.row) && seatInfo.kind === 'nav') {
          // The nav list exists but the row did not paint in it (unexpected
          // clip/hide): degrade to the sidebar root column with the same node.
          const railSeat = root.isConnected ? { seat: root, kind: 'rail', navList: seatInfo.navList } : null
          if (railSeat) {
            const canClone = Boolean(referenceRowFor(railSeat))
            let moved = false
            if (navRow.cloned === canClone) {
              try {
                insertRowIntoSeat(railSeat.seat, railSeat.kind, navRow.row)
                navRow.seat = railSeat.seat
                navRow.kind = railSeat.kind
                moved = true
              } catch {
                moved = false
              }
            }
            if (!moved) {
              try {
                navRow.row.remove()
              } catch {
                /* ignore */
              }
              navRow = null
              navRow = mountNavRow(root, railSeat)
            }
            if (navRow) {
              seatInfo = railSeat
              setClassToken(navRow.row, NAV_ROW_RAIL_CLASS, true)
            }
          }
        }

        setNavRowVisible(Boolean(navRow && isVisible(navRow.row)))
        refreshDomEntryVisible()
      } catch {
        /* the probe must never break the client module */
      }
    }

    /**
     * Locate the sidebar shell root by STRUCTURE, not by one fragile class.
     *
     * ui-layout owns the `_sidebarCol` grid column; the sidebar package renders
     * a `_root` shell inside it that owns `_footArea` (`footerActions` +
     * `settingsArea`), `_regionArea` and `_newSession`/`_logoRow`. Any layer may
     * rename its CSS module, so several structural probes are tried and the
     * first connected match wins. Returns null when the sidebar is not mounted.
     */
    function findSidebarRoot() {
      if (typeof document === 'undefined') return null
      const candidates = []
      try {
        for (const column of document.querySelectorAll('[class*="_sidebarCol"]')) {
          if (!column || !column.isConnected) continue
          const shell = column.querySelector('[class*="_root"]')
          if (shell) candidates.push(shell)
          else if (column.firstElementChild) candidates.push(column.firstElementChild)
        }
        for (const shell of document.querySelectorAll('[class*="_root"]')) {
          if (!shell || !shell.isConnected) continue
          if (!shell.querySelector('[class*="_footArea"]') && !shell.querySelector('[class*="_footerActions"]')) {
            try {
              if (!shell.querySelector('[class*="_newSession"]') && !shell.querySelector('[class*="_logoRow"]')) continue
            } catch {
              continue
            }
          }
          candidates.push(shell)
        }
      } catch {
        return null
      }
      for (const shell of candidates) {
        try {
          if (!shell.isConnected) continue
          if (!shell.querySelector('[class*="_newSession"],[class*="_logoRow"],[class*="_footArea"]')) continue
          return shell
        } catch {
          /* keep looking */
        }
      }
      return null
    }

    /**
     * Delete a stale `+` button left in the shell DOM by an older revision.
     *
     * This revision NEVER creates that button: the workspace-header `+` was
     * removed on user request because it triggered a UI bug (see ENTRY POINTS
     * at the top of this file). The cleanup only matters when the bundle is
     * hot-reloaded over a page that still has the old node mounted.
     */
    function removeEntryButton() {
      if (typeof document === 'undefined') return
      const button = document.getElementById(ENTRY_BTN_ID)
      if (button) {
        try {
          button.remove()
        } catch {
          /* ignore */
        }
      }
    }

    /** Fan the toggle out to the drawer root (works for every trigger). */
    function dispatchToggle() {
      try {
        window.dispatchEvent(new CustomEvent(TOGGLE_EVENT))
      } catch {
        /* ignore */
      }
    }

    /**
     * Re-sync on every shell mutation (sidebar toggle, rail animation, window
     * resize, titlebar mode) with coalescing; also polls early after load
     * because the sidebar can mount before/after this plugin.
     */
    function installEntryProbe() {
      if (typeof document === 'undefined') return () => {}
      const observationRoot = document.body || document.documentElement
      if (!observationRoot || typeof MutationObserver !== 'function') return () => {}
      // The probe only maintains the `+ 项目工坊` nav row: the workspace-header
      // `+` was removed on request, so no header/footer DOM button is mounted.
      const syncEntries = () => {
        syncNavEntry()
      }
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        window.setTimeout(() => {
          scheduled = false
          syncEntries()
        }, 120)
      }
      const observers = []
      try {
        const observer = new MutationObserver(schedule)
        observer.observe(observationRoot, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'data-sidebar-collapsed', 'data-windows-titlebar', 'data-platform'],
        })
        observers.push(observer)
      } catch {
        /* observation unavailable — the early timers below still mount */
      }
      try {
        // `data-windows-titlebar` / `data-platform` live on <html>, outside body.
        if (document.documentElement) {
          const rootObserver = new MutationObserver(schedule)
          rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-windows-titlebar', 'data-platform', 'data-fullscreen'],
          })
          observers.push(rootObserver)
        }
      } catch {
        /* ignore */
      }
      const onResize = () => schedule()
      try {
        window.addEventListener('resize', onResize)
      } catch {
        /* ignore */
      }
      const timers = [120, 400, 900, 1600, 2600, 4000].map((ms) => window.setTimeout(syncEntries, ms))
      // Drop a header `+` mounted by an older revision (removed on request;
      // this revision never creates it).
      removeEntryButton()
      syncEntries()
      return () => {
        for (const observer of observers) {
          try {
            observer.disconnect()
          } catch {
            /* ignore */
          }
        }
        try {
          window.removeEventListener('resize', onResize)
        } catch {
          /* ignore */
        }
        for (const timer of timers) {
          try {
            window.clearTimeout(timer)
          } catch {
            /* ignore */
          }
        }
        removeEntryButton()
        removeNavRow()
        setNavRowVisible(false)
        setDomEntryVisible(false)
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Shared UI helpers
    // ═══════════════════════════════════════════════════════════════════════

    function useEscape(onClose) {
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [onClose])
    }

    // ── Deterministic primary-button label contrast ─────────────────────────
    /**
     * The shell's primary fill resolves to near-white (#f9fafb) in the dark
     * theme and to a dark colour in the light theme, but the matching label
     * tokens differ between shell builds — some are absent, and their #ffffff
     * fallbacks produced invisible labels (white text on a white fill). The
     * label colour is therefore NEVER read from a theme token; it is derived
     * from the button's *measured* background:
     *
     *   - opaque background -> `#0f1115` or `#ffffff`, whichever has the higher
     *     WCAG contrast ratio (the better of the two is >= 4.58:1 for ANY
     *     opaque colour, so both themes are covered deterministically);
     *   - unknown / translucent background -> transparent fill + border + the
     *     already-proven `--dsw-alias-label-primary` label (the neutral, high
     *     contrast look of the visible 「取消」 button).
     */
    const PRIMARY_TEXT_DARK = '#0f1115'
    const PRIMARY_TEXT_LIGHT = '#ffffff'
    const PRIMARY_TEXT_FALLBACK = 'var(--dsw-alias-label-primary, #ededed)'
    /** Single source of truth for the primary-button class list. */
    const PRIMARY_BUTTON_CLASS = 'dsh-ph-btn dsh-ph-btn-primary'

    function clampChannel(value) {
      return Math.min(255, Math.max(0, value))
    }

    /**
     * Parse the colour strings `getComputedStyle` returns: hex, `rgb()` /
     * `rgba()` (comma or space syntax), and `color(srgb ...)`. Returns
     * `{ r, g, b, a }` or null. Only fully opaque colours can be reasoned
     * about; translucent ones are reported as unparsable by the caller.
     */
    function parseCssColor(value) {
      if (typeof value !== 'string') return null
      const text = value.trim().toLowerCase()
      if (!text) return null

      let match = /^#([0-9a-f]{3,8})$/.exec(text)
      if (match) {
        let hex = match[1]
        if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((char) => char + char).join('')
        if (hex.length !== 6 && hex.length !== 8) return null
        const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: alpha,
        }
      }

      match = /^(?:rgb|rgba)\(([^)]*)\)$/.exec(text)
      if (match) {
        const parts = match[1].split(/[,/\s]+/).map((part) => part.trim()).filter(Boolean)
        if (parts.length < 3) return null
        const channels = parts.slice(0, 3).map((part) => {
          const numeric = part.endsWith('%') ? (parseFloat(part) * 255) / 100 : parseFloat(part)
          return Number.isFinite(numeric) ? clampChannel(numeric) : null
        })
        if (channels.some((channel) => channel === null)) return null
        const alphaValue = parts.length > 3 ? parseFloat(parts[3]) : 1
        if (!Number.isFinite(alphaValue)) return null
        return {
          r: channels[0],
          g: channels[1],
          b: channels[2],
          a: Math.min(1, Math.max(0, alphaValue)),
        }
      }

      match = /^color\(srgb\s+([^)]*)\)$/.exec(text)
      if (match) {
        const parts = match[1].split(/[,/\s]+/).map((part) => part.trim()).filter(Boolean)
        if (parts.length < 3) return null
        const channels = parts.slice(0, 3).map((part) => {
          const numeric = parseFloat(part)
          return Number.isFinite(numeric) ? clampChannel(numeric * 255) : null
        })
        if (channels.some((channel) => channel === null)) return null
        const alphaValue = parts.length > 3 ? parseFloat(parts[3]) : 1
        if (!Number.isFinite(alphaValue)) return null
        return {
          r: channels[0],
          g: channels[1],
          b: channels[2],
          a: Math.min(1, Math.max(0, alphaValue)),
        }
      }

      return null
    }

    function channelLuminance(channel) {
      const value = channel / 255
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
    }

    /** WCAG 2.x relative luminance for a CSS colour string or parsed colour. */
    function relativeLuminance(color) {
      const parsed = typeof color === 'string' ? parseCssColor(color) : color
      if (!parsed) return null
      return (
        0.2126 * channelLuminance(parsed.r) +
        0.7152 * channelLuminance(parsed.g) +
        0.0722 * channelLuminance(parsed.b)
      )
    }

    /** WCAG contrast ratio (1..21) for two CSS colour strings / parsed colours. */
    function contrastRatio(colorA, colorB) {
      const luminanceA = relativeLuminance(colorA)
      const luminanceB = relativeLuminance(colorB)
      if (luminanceA === null || luminanceB === null) return null
      const lighter = Math.max(luminanceA, luminanceB)
      const darker = Math.min(luminanceA, luminanceB)
      return (lighter + 0.05) / (darker + 0.05)
    }

    /**
     * Deterministic label colour for an opaque background: near-black or
     * near-white, whichever contrasts more. `null` means "cannot reason about
     * this background" (unparsable or translucent) — the caller then switches
     * to the neutral fallback look instead of guessing.
     */
    function pickReadableTextColor(background) {
      const parsed = parseCssColor(background)
      if (!parsed || parsed.a < 0.999) return null
      const darkContrast = contrastRatio(parsed, parseCssColor(PRIMARY_TEXT_DARK)) || 0
      const lightContrast = contrastRatio(parsed, parseCssColor(PRIMARY_TEXT_LIGHT)) || 0
      return lightContrast > darkContrast ? PRIMARY_TEXT_LIGHT : PRIMARY_TEXT_DARK
    }

    /**
     * Measure one primary button and make its label readable. Used as the
     * React `ref` callback (runs after mount, before paint) and on hover
     * enter/leave, because the shell only changes the *background* on hover.
     * Never throws; works with or without `window.getComputedStyle`.
     */
    function applyReadablePrimaryText(element) {
      if (!element || !element.style) return null

      let background = ''
      try {
        const win = typeof window !== 'undefined' ? window : null
        if (win && typeof win.getComputedStyle === 'function') {
          const computed = win.getComputedStyle(element)
          if (computed) background = computed.backgroundColor || ''
        }
      } catch {
        background = ''
      }

      const textColor = pickReadableTextColor(background)
      if (textColor) {
        element.style.color = textColor
        // Drop any earlier inline fallback so the themed fill shows through.
        element.style.background = ''
        element.style.borderColor = ''
        return textColor
      }

      // Unknown/translucent fill: neutral high-contrast look (same background,
      // border and label as the visible 「取消」 button in both themes).
      element.style.background = 'transparent'
      element.style.borderColor = 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12))'
      element.style.color = PRIMARY_TEXT_FALLBACK
      return null
    }

    /**
     * React callback `ref` for a primary button. Kept separate from
     * `applyReadablePrimaryText` so it returns NOTHING: React 18/19 treat a
     * callback ref's return value as an unmount cleanup function, so the
     * measurable helper must not leak its colour result into the ref slot.
     */
    function primaryButtonRef(element) {
      applyReadablePrimaryText(element)
      if (!element) return
      try {
        const win = typeof window !== 'undefined' ? window : null
        if (win && typeof win.setTimeout === 'function') {
          // One deferred, idempotent re-measure: covers a build where the
          // plugin stylesheet lands after the ref callback, or a fill token
          // that resolves only after the first style recalc.
          win.setTimeout(() => applyReadablePrimaryText(element), 0)
        }
      } catch {
        /* best effort */
      }
    }

    /**
     * Props shared by EVERY `.dsh-ph-btn-primary` button. Keeps all of them on
     * the same deterministic contrast path (mount + hover), so one overlooked
     * button cannot regress to white-on-white again.
     */
    function primaryButtonProps(extra) {
      const base = extra || {}
      return Object.assign({}, base, {
        type: 'button',
        className: PRIMARY_BUTTON_CLASS + (base.className ? ' ' + base.className : ''),
        ref: primaryButtonRef,
        onMouseEnter: (event) => applyReadablePrimaryText(event && (event.currentTarget || event.target)),
        onMouseLeave: (event) => applyReadablePrimaryText(event && (event.currentTarget || event.target)),
      })
    }

    function ModalBackdrop({ onClose, children }) {
      return h(
        'div',
        {
          className: 'dsh-ph-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        children,
      )
    }

    function CloseButton({ onClose }) {
      return h(
        'button',
        {
          type: 'button',
          style: {
            background: 'none',
            border: 'none',
            color: 'var(--dsw-alias-label-tertiary, #888)',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: 1,
            padding: '2px 6px',
          },
          onClick: onClose,
          'aria-label': '关闭',
        },
        '×',
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Entry triggers — official slot entry + DOM probe fallback
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Official entry rendered by the `sidebar.footer.action` list slot
     * (declared by ui-sidebar in 0.2.1-rc.3, mounted in its `footerActions`
     * row). Stateless on purpose: it only emits the toggle event, so the
     * entry still works when the drawer app lives in its own React root.
     *
     * It renders NOTHING while the DOM fallback entry (the `+ 项目工坊` nav row)
     * is painted, otherwise a wide Windows sidebar would show two entries at
     * once (the slot entry in the foot AND the nav row in the sidebar).
     */
    function ProjectHubEntry() {
      const domEntryVisible = useDomEntryVisible()
      if (domEntryVisible) return null

      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'dsh-ph-entry-btn',
          [ENTRY_ATTR]: '1',
          title: '项目工坊',
          'aria-label': '项目工坊',
          onClick: (event) => {
            try {
              event.preventDefault()
              event.stopPropagation()
            } catch {
              /* ignore */
            }
            dispatchToggle()
          },
          onMouseDown: (event) => {
            try {
              event.stopPropagation()
            } catch {
              /* ignore */
            }
          },
        },
        '+',
      )

      // Degraded build (no own React root): keep the drawer alive by rendering
      // it through a portal from this occupant instead.
      if (!hubRootReady && typeof createPortal === 'function') {
        const host = ensurePortalHost()
        if (host) return h(React.Fragment, null, trigger, createPortal(h(HubApp), host))
      }
      return trigger
    }

    /**
     * Entry rendered by the `sidebar.panellist.actions` list slot.
     *
     * That slot is the CONTENT of the panel list's 「更多」 menu (contract props:
     * `entries`, `onOpen`, `onPinnedChange`, `onDismiss`), not the visible
     * header icon row — so this row is an additional, always-available path to
     * the drawer from inside the shell menu. It dismisses the menu and then
     * dispatches the same local toggle; no layout panel is involved.
     */
    function PanelActionEntry(props) {
      // The `+ 项目工坊` nav row is the primary entry; while it actually paints
      // this duplicate row inside the 「更多」 menu renders nothing, so the user
      // never sees the same entry twice.
      const navRowOnScreen = useNavRowVisible()
      if (navRowOnScreen) return null
      const onDismiss = props && typeof props.onDismiss === 'function' ? props.onDismiss : null
      const activate = (event) => {
        try {
          event.preventDefault()
          event.stopPropagation()
        } catch {
          /* ignore */
        }
        if (onDismiss) {
          try {
            onDismiss()
          } catch {
            /* ignore */
          }
        }
        dispatchToggle()
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-ph-menu-row',
          [ENTRY_ATTR]: '1',
          title: '项目工坊',
          'aria-label': '项目工坊',
          onClick: activate,
          onMouseDown: (event) => {
            try {
              event.stopPropagation()
            } catch {
              /* ignore */
            }
          },
        },
        h('span', { className: 'dsh-ph-menu-row-glyph', 'aria-hidden': 'true' }, '+'),
        h('span', null, '项目工坊'),
      )
    }

    /** True once this module mounted its own React root into the portal host. */
    let hubRootReady = false

    function resolveCreateRoot() {
      if (!reactDom) return null
      if (typeof reactDom.createRoot === 'function') return reactDom.createRoot
      if (reactDom.default && typeof reactDom.default.createRoot === 'function') return reactDom.default.createRoot
      return null
    }

    function resolveLegacyRender() {
      if (!reactDom) return null
      if (typeof reactDom.render === 'function') return reactDom.render
      if (reactDom.default && typeof reactDom.default.render === 'function') return reactDom.default.render
      return null
    }

    /**
     * Mount the drawer app into `#dsh-project-hub-portal-host` as its own React
     * root (React 18 `createRoot`, legacy `render` as a fallback). Owning the
     * root means the drawer never depends on a slot occupant surviving a shell
     * re-render: the `+` only has to dispatch the toggle event.
     */
    function mountHubApp(host) {
      if (!host || typeof document === 'undefined') return null
      try {
        const createRoot = resolveCreateRoot()
        if (typeof createRoot === 'function') {
          const root = createRoot(host)
          root.render(h(HubApp))
          hubRootReady = true
          return () => {
            hubRootReady = false
            try {
              root.unmount()
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        hubRootReady = false
      }
      try {
        const render = resolveLegacyRender()
        if (typeof render === 'function') {
          render(h(HubApp), host)
          hubRootReady = true
          return () => {
            hubRootReady = false
            try {
              render(null, host)
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        hubRootReady = false
      }
      return null
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Drawer app (rendered inside #dsh-project-hub-portal-host)
    // ═══════════════════════════════════════════════════════════════════════

    function HubApp() {
      ensureStyles()

      const [openDrawer, setOpenDrawer] = React.useState(false)
      const [state, setState] = React.useState({
        projects: [],
        globalWorkspaceRoot: DEFAULT_GLOBAL_WORKSPACE_ROOT,
      })
      const [showNewProj, setShowNewProj] = React.useState(false)
      const [showIngest, setShowIngest] = React.useState(false)
      const [activeProj, setActiveProj] = React.useState(null)
      /** 「总工作区设置」modal (opened from the drawer footer 「设置」 entry). */
      const [showSettings, setShowSettings] = React.useState(false)
      const [historySessions, setHistorySessions] = React.useState([])
      const [selectedSessionIds, setSelectedSessionIds] = React.useState([])
      /** Project id whose inline “unregister” confirmation row is open. */
      const [pendingRemoveId, setPendingRemoveId] = React.useState(null)

      const drawerRef = React.useRef(null)

      /** Re-read the Host state; returns the fresh payload (null on failure). */
      const reloadState = React.useCallback(async () => {
        try {
          const res = await requestApi('/project-hub/state')
          if (res && res.ok && res.data) {
            setState(res.data)
            return res.data
          }
        } catch {
          /* silent: the drawer shows an empty list */
        }
        return null
      }, [])

      React.useEffect(() => {
        reloadState()
      }, [reloadState])

      // Both entry triggers (official slot button and the DOM probe fallback)
      // dispatch this event; this app owns the drawer.
      React.useEffect(() => {
        const onToggle = () => setOpenDrawer((open) => !open)
        window.addEventListener(TOGGLE_EVENT, onToggle)
        return () => window.removeEventListener(TOGGLE_EVENT, onToggle)
      }, [])

      // Every time the drawer OPENS, re-read /project-hub/state so an MD file
      // created elsewhere (another session, record_module_done, manual write)
      // shows up immediately. Deliberately no polling timer: reading happens
      // only on open and on the explicit 「刷新」 clicks.
      React.useEffect(() => {
        if (openDrawer) reloadState()
      }, [openDrawer, reloadState])

      // Esc closes the drawer.
      React.useEffect(() => {
        if (!openDrawer) return undefined
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') setOpenDrawer(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [openDrawer])

      // Any close discards an unconfirmed “移出列表” row: a reopened drawer never
      // shows a stale confirmation.
      React.useEffect(() => {
        if (!openDrawer) setPendingRemoveId(null)
      }, [openDrawer])

      // Outside click closes the drawer; a click on either entry trigger is
      // left to its own toggle handler.
      React.useEffect(() => {
        if (!openDrawer) return undefined
        const onPointerDown = (event) => {
          const target = event && event.target
          if (!target) return
          if (drawerRef.current && drawerRef.current.contains(target)) return
          try {
            if (typeof target.closest === 'function' && target.closest('[' + ENTRY_ATTR + ']')) return
          } catch {
            /* ignore */
          }
          setOpenDrawer(false)
        }
        window.addEventListener('pointerdown', onPointerDown)
        return () => window.removeEventListener('pointerdown', onPointerDown)
      }, [openDrawer])

      const openIngestModal = async () => {
        setOpenDrawer(false)
        setShowIngest(true)
        setHistorySessions([])
        try {
          const res = await requestApi('/project-hub/sessions')
          if (res && res.ok && res.data) {
            const sessions = Array.isArray(res.data.sessions) ? res.data.sessions : []
            setHistorySessions(sessions)
            setSelectedSessionIds(sessions.length > 0 ? [sessions[0].sessionId] : [])
          }
        } catch {
          /* silent */
        }
      }

      const launchScratchpad = async () => {
        setOpenDrawer(false)
        try {
          await requestApi('/project-hub/launch-session', { method: 'POST', body: { isScratchpad: true } })
        } catch {
          /* silent */
        }
      }

      /**
       * Open 「启动会话」 for one project. The launcher reads its tag tree from
       * the state snapshot, so state is re-read on open and the modal receives
       * the refreshed project object (newly created MD files appear at once).
       */
      const openProject = async (project) => {
        setOpenDrawer(false)
        setActiveProj(project)
        const fresh = await reloadState()
        const projects = fresh && Array.isArray(fresh.projects) ? fresh.projects : []
        const updated = projects.find((item) => item && item.id === project.id)
        if (updated) setActiveProj(updated)
      }

      /** 「启动会话」 modal's own 刷新 button: re-read state, refresh the project. */
      const refreshActiveProject = React.useCallback(async () => {
        const fresh = await reloadState()
        const projects = fresh && Array.isArray(fresh.projects) ? fresh.projects : []
        setActiveProj((current) => {
          if (!current) return current
          const updated = projects.find((item) => item && item.id === current.id)
          return updated || current
        })
        return fresh
      }, [reloadState])

      /**
       * 「移出列表」= UNREGISTER ONLY (解除登记), never a physical delete.
       *
       * It asks the Host to drop the id from `.dsh-hub/projects.json`; the Host
       * deliberately leaves `C:\\work\\<projectId>` and its `.dsh-hub/docs/**`
       * markdown untouched, so the user can register the same folder again
       * later. The second click on this row is the confirmation — no
       * `window.confirm`, no toast, no badge; success is just the refreshed
       * list (and on any failure the list is re-read silently as well).
       */
      const confirmRemoveProject = async (project) => {
        if (!project || !project.id) return
        try {
          await requestApi('/project-hub/remove-project', {
            method: 'POST',
            body: { projectId: project.id },
          })
        } catch {
          /* silent: an unreachable Host must not surface a notification */
        }
        setPendingRemoveId(null)
        await reloadState()
      }

      // The drawer root is owned by this app; its host is the portal div so the
      // acceptance handles read straight from #dsh-project-hub-portal-host.
      const drawer = openDrawer
        ? h(
            React.Fragment,
            null,
            h('div', { className: 'dsh-ph-drawer-backdrop', onClick: () => setOpenDrawer(false) }),
            h(
              'div',
              {
                ref: drawerRef,
                className: 'dsh-ph-drawer',
                role: 'dialog',
                'aria-label': '项目工坊',
                [DRAWER_ATTR]: '1',
              },
              h(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: '8px',
                    marginBottom: '12px',
                    paddingBottom: '12px',
                    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                  },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ph-btn',
                    style: { height: '36px', fontSize: '12px', padding: '0 6px' },
                    onClick: () => {
                      setOpenDrawer(false)
                      setShowNewProj(true)
                    },
                  },
                  '新建项目',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ph-btn',
                    style: { height: '36px', fontSize: '12px', padding: '0 6px' },
                    onClick: openIngestModal,
                  },
                  '归类历史',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ph-btn',
                    style: { height: '36px', fontSize: '12px', padding: '0 6px' },
                    onClick: launchScratchpad,
                  },
                  '其他 (杂务)',
                ),
              ),
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: 'var(--dsw-alias-label-tertiary, #8a8d98)',
                    padding: '4px 6px 8px 6px',
                    letterSpacing: '0.04em',
                  },
                },
                h('span', null, '选择项目发起任务'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ph-refresh-btn',
                    title: '重新读取项目与档案列表',
                    'aria-label': '刷新项目列表',
                    onClick: () => reloadState(),
                  },
                  '↻ 刷新',
                ),
              ),
              h(
                'div',
                { style: { maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } },
                (state.projects || []).length === 0
                  ? h(
                      'div',
                      { className: 'dsh-ph-muted', style: { padding: '8px 6px' } },
                      '暂无项目，请先「新建项目」。',
                    )
                  : (state.projects || []).map((project) =>
                      h(
                        React.Fragment,
                        { key: project.id },
                        h(
                          'div',
                          { className: 'dsh-ph-project-row', onClick: () => openProject(project) },
                          h(
                            'div',
                            { className: 'dsh-ph-project-main' },
                            h(
                              'div',
                              {
                                style: {
                                  fontWeight: 500,
                                  fontSize: '13px',
                                  color: 'var(--dsw-alias-label-primary, #ededed)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                },
                              },
                              project.name,
                            ),
                            h(
                              'div',
                              { className: 'dsh-ph-muted' },
                              `${project.id} · ${project.mdCount || 0} 份档案`,
                            ),
                          ),
                          // Text-only unregister action; the row click still
                          // opens the project, so the button stops propagation.
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-ph-remove-btn',
                              title: '只从列表移除，C:\\work 下文件与知识库保持不变',
                              'aria-label': `移出列表 ${project.name}`,
                              onClick: (event) => {
                                try {
                                  event.preventDefault()
                                  event.stopPropagation()
                                } catch {
                                  /* ignore */
                                }
                                setPendingRemoveId((current) => (current === project.id ? null : project.id))
                              },
                            },
                            '移出列表',
                          ),
                        ),
                        // Inline confirmation row (drawer-internal, silent).
                        pendingRemoveId === project.id &&
                          h(
                            'div',
                            { className: 'dsh-ph-confirm-row' },
                            h(
                              'div',
                              null,
                              `只从列表移除「${project.name}」，C:\\work 下文件与知识库保持不变；之后仍可重新登记。`,
                            ),
                            h(
                              'div',
                              { className: 'dsh-ph-confirm-actions' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-ph-btn dsh-ph-btn-sm',
                                  onClick: () => setPendingRemoveId(null),
                                },
                                '取消',
                              ),
                              h(
                                'button',
                                primaryButtonProps({
                                  className: 'dsh-ph-btn-sm',
                                  onClick: () => confirmRemoveProject(project),
                                }),
                                '确认移出',
                              ),
                            ),
                          ),
                      ),
                    ),
              ),
              // Footer: one quiet 「设置」 entry (总工作区设置) below the list.
              // Plain text + 14px line-art gear; never a color emoji, never a
              // primary fill. It closes the drawer and opens the settings modal.
              h(
                'div',
                {
                  style: {
                    marginTop: '10px',
                    paddingTop: '10px',
                    borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08))',
                  },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    id: 'dsh-ph-settings-entry',
                    className: 'dsh-ph-settings-entry',
                    title: '总工作区设置',
                    'aria-label': '设置 (总工作区)',
                    onClick: () => {
                      setOpenDrawer(false)
                      setShowSettings(true)
                    },
                  },
                  h(SettingsGearIcon),
                  h('span', null, '设置'),
                ),
              ),
            ),
          )
        : null

      if (!openDrawer && !showNewProj && !showIngest && !activeProj && !showSettings) return null

      return h(
        React.Fragment,
        null,
        drawer,
        showNewProj &&
          h(NewProjectModal, {
            onClose: () => setShowNewProj(false),
            onCreated: () => {
              setShowNewProj(false)
              reloadState()
            },
          }),
        showIngest &&
          h(IngestSessionsModal, {
            projects: state.projects || [],
            sessions: historySessions,
            selectedIds: selectedSessionIds,
            setSelectedIds: setSelectedSessionIds,
            onClose: () => setShowIngest(false),
            onDone: () => {
              setShowIngest(false)
              reloadState()
            },
          }),
        activeProj &&
          h(ProjectTaskModal, {
            project: activeProj,
            globalRoot: state.globalWorkspaceRoot,
            agentModes: state.agentModes,
            onRefresh: refreshActiveProject,
            onClose: () => setActiveProj(null),
          }),
        showSettings &&
          h(SettingsModal, {
            globalWorkspaceRoot: state.globalWorkspaceRoot,
            onClose: () => setShowSettings(false),
            onSaved: async (root) => {
              setShowSettings(false)
              // Reflect the new root immediately, then refresh the project list
              // from the Host so the drawer shows projects of the new 总工作区.
              setState((current) => Object.assign({}, current, { globalWorkspaceRoot: root }))
              await reloadState()
            },
          }),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Modal 1 — New project
    // ═══════════════════════════════════════════════════════════════════════

    function NewProjectModal({ onClose, onCreated }) {
      const [name, setName] = React.useState('')
      const [id, setId] = React.useState('')
      const [tags, setTags] = React.useState('[Media-多媒体渲染], [UI-交互界面], [Core-业务核心]')
      useEscape(onClose)

      const submit = async () => {
        if (!name.trim()) return
        const cleanId = id.trim() || name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
        const tagList = tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        try {
          const res = await requestApi('/project-hub/create-project', {
            method: 'POST',
            body: { id: cleanId, name: name.trim(), defaultTags: tagList },
          })
          if (res && res.ok) onCreated()
        } catch {
          /* silent */
        }
      }

      return h(
        ModalBackdrop,
        { onClose },
        h(
          'div',
          { className: 'dsh-ph-card', style: { width: '480px', padding: '24px', gap: '18px' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '14px',
                borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
              },
            },
            h('span', { style: { fontSize: '15px', fontWeight: 600 } }, '新建模块项目'),
            h(CloseButton, { onClose }),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
            h(
              'div',
              null,
              h('div', { className: 'dsh-ph-field-label' }, '项目中文名称'),
              h('input', {
                className: 'dsh-ph-input',
                placeholder: '例如: 数字人语音互动',
                value: name,
                onChange: (event) => setName(event.target.value),
              }),
            ),
            h(
              'div',
              null,
              h('div', { className: 'dsh-ph-field-label' }, '项目英文 ID (物理文件夹名)'),
              h('input', {
                className: 'dsh-ph-input',
                placeholder: 'digital-avatar',
                value: id,
                onChange: (event) => setId(event.target.value),
              }),
              h('p', { className: 'dsh-ph-muted' }, '物理工作区目录: C:\\work\\<ID>'),
            ),
            h(
              'div',
              null,
              h('div', { className: 'dsh-ph-field-label' }, '初始预设大标签 (逗号分隔)'),
              h('input', {
                className: 'dsh-ph-input',
                value: tags,
                onChange: (event) => setTags(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                paddingTop: '16px',
                borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
              },
            },
            h('button', { type: 'button', className: 'dsh-ph-btn', onClick: onClose }, '取消'),
            h('button', primaryButtonProps({ onClick: submit }), '创建项目'),
          ),
        ),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Ingest form — tag options (数据全部来自 /project-hub/state)
    //
    // The 「归类历史」 modal is a *classification* form: the big tag must be one
    // of the project's already-defined tags (chosen when the project was
    // created), while the small tag may either reuse an existing module or
    // introduce a new one (via the dropdown's 「＋ 新建小标签」 dialog). The pure
    // helpers below can also be asserted from Node (`__test__`), without a
    // renderer; the UI itself is the custom themed `IngestDropdown` listbox.
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * The ONLY legal 大标签 values for a project: `tagTree` keys ∪
     * `defaultTags`, de-duplicated, first-seen order preserved.
     *
     * Both sources are served by `GET /project-hub/state`:
     *   - `tagTree` keys are the big-tag folders physically present under
     *     `<project>/.dsh-hub/docs/`;
     *   - `defaultTags` are the tags picked in 「新建项目」 (persisted in the
     *     registry's `.dsh-hub/projects.json`).
     * A free-form big tag is never accepted here: a typo would create a docs
     * folder outside the project's tag taxonomy.
     */
    function listBigTagOptions(project) {
      const options = []
      const seen = new Set()
      const push = (value) => {
        const tag = typeof value === 'string' ? value.trim() : ''
        if (!tag || seen.has(tag)) return
        seen.add(tag)
        options.push(tag)
      }

      const tagTree = project && project.tagTree && typeof project.tagTree === 'object' ? project.tagTree : {}
      for (const bigTag of Object.keys(tagTree)) push(bigTag)

      const defaultTags = project && Array.isArray(project.defaultTags) ? project.defaultTags : []
      for (const bigTag of defaultTags) push(bigTag)

      return options
    }

    /**
     * Effective 大标签 for the current project. A value carried over from
     * another project is reset to the first option when it is not part of the
     * new project's option set; a still-valid value is kept as-is. With no
     * options at all the result is `''` (the control is disabled + explained).
     */
    function resolveBigTagSelection(project, current) {
      const options = listBigTagOptions(project)
      const value = typeof current === 'string' ? current.trim() : ''
      if (value && options.includes(value)) return value
      return options[0] || ''
    }

    /**
     * 小标签 suggestions for the selected big tag: the MD files already in
     * `<project>/.dsh-hub/docs/<大标签>/`.
     *
     * `GET /project-hub/state` builds `tagTree[bigTag]` by listing exactly that
     * directory (`listProjectsWithDocs` in doc-manager.js), so this array IS
     * the docs-directory projection and no client-side filesystem access is
     * needed (or possible). Entries are normally `{ smallTag, file, ... }`
     * objects; plain strings are tolerated too. These are the existing options
     * of the 小标签 dropdown; a brand-new small tag is created through the
     * menu's 「＋ 新建小标签」 dialog instead of free-text typing.
     */
    function listSmallTagSuggestions(project, bigTag) {
      const suggestions = []
      const seen = new Set()
      const tag = typeof bigTag === 'string' ? bigTag.trim() : ''
      if (!project || !tag) return suggestions

      const tagTree = project.tagTree && typeof project.tagTree === 'object' ? project.tagTree : {}
      const children = Array.isArray(tagTree[tag]) ? tagTree[tag] : []
      for (const child of children) {
        const name =
          typeof child === 'string'
            ? child.trim()
            : child && typeof child.smallTag === 'string'
            ? child.smallTag.trim()
            : ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        suggestions.push(name)
      }
      return suggestions
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Custom themed dropdown — replaces the OS-drawn native <select> popup
    //
    // The user's complaint was about the OPEN option list of the native
    // <select> ("下箭号点下去的这个选项框太粗糙了"): Windows draws that popup,
    // so no CSS token can theme it. `IngestDropdown` therefore renders its own
    // listbox: the trigger keeps the proven .dsh-ph-input/.dsh-ph-select skin
    // (chevron + focus ring + 32px height), and the menu is a themed,
    // position:fixed listbox that layers above the modal card.
    //
    // The pure helpers (option normalisation, placement, dismiss listeners) are
    // exported through `__test__` so Node tests can assert them without a DOM.
    // ═══════════════════════════════════════════════════════════════════════

    /** 新建小标签 dialog ids (asserted from Node tests). */
    const NEW_SMALL_TAG_INPUT_ID = 'dsh-ph-new-small-tag'
    const NEW_SMALL_TAG_ERROR_ID = 'dsh-ph-new-small-tag-error'
    const NEW_SMALL_TAG_CONFIRM_ID = 'dsh-ph-new-small-tag-confirm'
    const NEW_SMALL_TAG_CANCEL_ID = 'dsh-ph-new-small-tag-cancel'

    /** The listbox id owned by one dropdown trigger (`<triggerId>-menu`). */
    function dropdownMenuId(triggerId) {
      return String(triggerId || 'dsh-ph-dropdown') + '-menu'
    }

    /**
     * Accept `['a', 'b']` or `[{ value, label }]` and return clean
     * `{ value, label }` rows: blanks dropped, duplicates de-duped, order kept.
     */
    function normalizeDropdownOptions(options) {
      const list = Array.isArray(options) ? options : []
      const rows = []
      const seen = new Set()
      for (const item of list) {
        const value =
          typeof item === 'string'
            ? item.trim()
            : item && typeof item.value === 'string'
            ? item.value
            : ''
        if (!value || seen.has(value)) continue
        seen.add(value)
        const label =
          item && typeof item === 'object' && typeof item.label === 'string' && item.label
            ? item.label
            : value
        rows.push({ value, label })
      }
      return rows
    }

    /**
     * Fixed-position placement for one dropdown menu, so it escapes the modal
     * card's `overflow:hidden`. Opens below the trigger; flips above when the
     * viewport has no room below. Pure: takes a trigger-like object (only
     * `getBoundingClientRect` is used) so it is unit-testable without a DOM.
     */
    function computeDropdownPlacement(trigger, viewport) {
      const width = viewport && Number(viewport.width) > 0 ? Number(viewport.width) : 1024
      const height = viewport && Number(viewport.height) > 0 ? Number(viewport.height) : 768
      const rect =
        trigger && typeof trigger.getBoundingClientRect === 'function' ? trigger.getBoundingClientRect() : null
      const margin = 8
      const gap = 4
      if (!rect) {
        return { left: margin, top: margin, width: 240, maxHeight: 240, placement: 'bottom' }
      }
      const menuWidth = Math.max(180, Math.min(Number(rect.width) || 240, width - margin * 2))
      const left = Math.max(margin, Math.min(Number(rect.left) || 0, width - menuWidth - margin))
      const triggerBottom = Number(rect.bottom) || 0
      const triggerTop = Number(rect.top) || 0
      const spaceBelow = height - triggerBottom - gap - margin
      const spaceAbove = triggerTop - gap - margin
      const preferred = 280
      const placement = spaceBelow >= Math.min(preferred, 180) || spaceBelow >= spaceAbove ? 'bottom' : 'top'
      const available = placement === 'bottom' ? spaceBelow : spaceAbove
      const maxHeight = Math.max(120, Math.min(preferred, available))
      const top =
        placement === 'bottom' ? triggerBottom + gap : Math.max(margin, triggerTop - gap - maxHeight)
      return { left, top, width: menuWidth, maxHeight, placement }
    }

    /**
     * Global dismiss listeners for an OPEN dropdown menu.
     *
     * Closes on: a pointerdown outside the trigger/menu, Escape (registered in
     * the CAPTURE phase and `stopPropagation()`ed so the ingest modal's own Esc
     * handler never sees it), viewport resize and page scroll. A scroll INSIDE
     * the menu (its own internal overflow) is ignored so the list can scroll.
     * Returns an unsubscribe function; never throws without a window.
     */
    function bindDropdownDismiss(options, scope) {
      const config = options || {}
      const win = scope || (typeof window !== 'undefined' ? window : null)
      if (!win || typeof win.addEventListener !== 'function') return () => {}
      const close = () => {
        if (typeof config.onClose === 'function') config.onClose()
      }
      const isInside = (target) => {
        if (typeof config.isInside !== 'function') return false
        try {
          return Boolean(config.isInside(target))
        } catch {
          return false
        }
      }
      const onPointerDown = (event) => {
        if (!isInside(event && event.target)) close()
      }
      const onKeyDown = (event) => {
        if (!event || event.key !== 'Escape') return
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        if (typeof event.preventDefault === 'function') event.preventDefault()
        close()
      }
      const onViewportChange = () => close()
      const onScroll = (event) => {
        // Scrolls originating inside the menu must not close it.
        if (isInside(event && event.target)) return
        close()
      }
      win.addEventListener('pointerdown', onPointerDown, true)
      win.addEventListener('keydown', onKeyDown, true)
      win.addEventListener('resize', onViewportChange)
      win.addEventListener('scroll', onScroll, true)
      return () => {
        try {
          win.removeEventListener('pointerdown', onPointerDown, true)
          win.removeEventListener('keydown', onKeyDown, true)
          win.removeEventListener('resize', onViewportChange)
          win.removeEventListener('scroll', onScroll, true)
        } catch {
          /* cleanup is best effort */
        }
      }
    }

    /**
     * Capture-phase Escape handler for the NESTED 新建 dialog: closes the
     * dialog only and stops the event before the ingest modal's Esc handler
     * (a bubble listener on window) can close the whole modal. Returns an
     * unsubscribe function; never throws without a window.
     */
    function stopEscapeEventCapture(onEscape, scope) {
      const win = scope || (typeof window !== 'undefined' ? window : null)
      if (!win || typeof win.addEventListener !== 'function') return () => {}
      const onKeyDown = (event) => {
        if (!event || event.key !== 'Escape') return
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof onEscape === 'function') onEscape()
      }
      win.addEventListener('keydown', onKeyDown, true)
      return () => {
        try {
          win.removeEventListener('keydown', onKeyDown, true)
        } catch {
          /* cleanup is best effort */
        }
      }
    }

    /**
     * One themed dropdown (custom listbox) for the 「归类历史」 form.
     *
     * Props: `id` (trigger id, kept for tests/aria), `value`, `options`
     * (strings or `{ value, label }`), `placeholder`, `disabled`,
     * `onChange(value)`, `ariaLabel`, `emptyText`, plus the 小标签 extras
     * `allowCreate` / `createLabel` / `createTitle` / `createContext` /
     * `createHint` which add the bottom 「＋ 新建小标签」 action row and its
     * nested dialog. No native <select>, no <datalist>, no OS popup.
     */
    function IngestDropdown(props) {
      const config = props || {}
      const options = normalizeDropdownOptions(config.options)
      const triggerId = typeof config.id === 'string' && config.id ? config.id : ''
      const menuId = dropdownMenuId(triggerId || 'dsh-ph-dropdown')
      const disabled = Boolean(config.disabled)
      const currentValue = typeof config.value === 'string' ? config.value : ''
      const selected = options.find((option) => option.value === currentValue) || null
      const hasValue = Boolean(currentValue)

      const [open, setOpen] = React.useState(false)
      const [activeIndex, setActiveIndex] = React.useState(-1)
      const [position, setPosition] = React.useState(null)
      const [createOpen, setCreateOpen] = React.useState(false)
      const triggerRef = React.useRef(null)
      const menuRef = React.useRef(null)

      // While open: outside pointerdown / captured Escape / resize / scroll.
      React.useEffect(() => {
        if (!open) return undefined
        return bindDropdownDismiss({
          isInside: (target) => {
            const trigger = triggerRef.current
            const menu = menuRef.current
            const inTrigger =
              trigger && target && typeof trigger.contains === 'function' && trigger.contains(target)
            const inMenu = menu && target && typeof menu.contains === 'function' && menu.contains(target)
            return Boolean(inTrigger || inMenu)
          },
          onClose: () => setOpen(false),
        })
      }, [open])

      const openMenu = (startIndex) => {
        if (disabled) return
        const win = typeof window !== 'undefined' ? window : null
        const viewport = {
          width: win && Number(win.innerWidth) > 0 ? Number(win.innerWidth) : 1024,
          height: win && Number(win.innerHeight) > 0 ? Number(win.innerHeight) : 768,
        }
        setPosition(computeDropdownPlacement(triggerRef.current, viewport))
        const selectedIndex = options.findIndex((option) => option.value === currentValue)
        const wanted = Number.isInteger(startIndex) ? startIndex : selectedIndex
        setActiveIndex(wanted >= 0 && wanted < options.length ? wanted : options.length > 0 ? 0 : -1)
        setOpen(true)
      }

      const selectOption = (nextValue) => {
        setOpen(false)
        if (typeof config.onChange === 'function') config.onChange(nextValue)
      }

      const moveActive = (delta) => {
        if (options.length === 0) return
        setActiveIndex((current) => {
          const base = Number.isInteger(current) ? current : -1
          return (base + delta + options.length) % options.length
        })
      }

      const onTriggerKeyDown = (event) => {
        if (disabled) return
        const key = event && event.key
        if (!key) return
        if (key === 'Escape') {
          if (open) {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof event.preventDefault === 'function') event.preventDefault()
            setOpen(false)
          }
          return
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (!open) {
            openMenu(key === 'ArrowUp' ? options.length - 1 : undefined)
            return
          }
          moveActive(key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          if (!open) {
            openMenu()
            return
          }
          const option = options[activeIndex]
          if (option) selectOption(option.value)
          return
        }
        if (key === 'Tab') setOpen(false)
      }

      const trigger = h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          id: triggerId || undefined,
          className:
            'dsh-ph-input dsh-ph-select dsh-ph-dropdown-trigger' + (open ? ' is-open' : ''),
          role: 'combobox',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': open ? menuId : undefined,
          'aria-label': typeof config.ariaLabel === 'string' && config.ariaLabel ? config.ariaLabel : undefined,
          disabled,
          onClick: () => {
            if (disabled) return
            if (open) setOpen(false)
            else openMenu()
          },
          onKeyDown: onTriggerKeyDown,
        },
        h(
          'span',
          {
            className: 'dsh-ph-dropdown-value' + (hasValue ? '' : ' dsh-ph-dropdown-placeholder'),
          },
          selected ? selected.label : hasValue ? currentValue : config.placeholder || '请选择',
        ),
      )

      const optionRows = options.map((option, index) => {
        const isSelected = option.value === currentValue
        return h(
          'div',
          {
            key: option.value,
            role: 'option',
            'aria-selected': isSelected ? 'true' : 'false',
            className:
              'dsh-ph-dropdown-option' +
              (isSelected ? ' is-selected' : '') +
              (index === activeIndex ? ' is-active' : ''),
            onMouseEnter: () => setActiveIndex(index),
            onClick: () => selectOption(option.value),
          },
          h('span', { className: 'dsh-ph-dropdown-option-label' }, option.label),
          isSelected
            ? h('span', { className: 'dsh-ph-dropdown-check', 'aria-hidden': 'true' }, '✓')
            : null,
        )
      })

      const menu = open
        ? h(
            'div',
            {
              ref: menuRef,
              id: menuId,
              className: 'dsh-ph-dropdown-menu',
              role: 'listbox',
              'aria-label':
                typeof config.ariaLabel === 'string' && config.ariaLabel ? config.ariaLabel : undefined,
              style: position
                ? {
                    position: 'fixed',
                    left: position.left + 'px',
                    top: position.top + 'px',
                    width: position.width + 'px',
                    maxHeight: position.maxHeight + 'px',
                    zIndex: 10020,
                  }
                : { position: 'fixed', zIndex: 10020 },
              onMouseDown: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
              },
              onKeyDown: onTriggerKeyDown,
            },
            options.length === 0
              ? h('div', { className: 'dsh-ph-dropdown-empty' }, config.emptyText || '暂无可选项')
              : optionRows,
            config.allowCreate
              ? [
                  h('div', { key: 'divider', className: 'dsh-ph-dropdown-divider' }),
                  h(
                    'button',
                    {
                      key: 'create',
                      type: 'button',
                      id: triggerId ? triggerId + '-create' : undefined,
                      className: 'dsh-ph-dropdown-create',
                      onClick: () => {
                        setOpen(false)
                        setCreateOpen(true)
                      },
                    },
                    h(
                      'span',
                      { className: 'dsh-ph-dropdown-create-glyph', 'aria-hidden': 'true' },
                      '+',
                    ),
                    h(
                      'span',
                      null,
                      typeof config.createLabel === 'string' && config.createLabel
                        ? config.createLabel
                        : '新建小标签',
                    ),
                  ),
                ]
              : null,
          )
        : null

      const dialog = createOpen
        ? h(NewSmallTagDialog, {
            title: config.createTitle || '新建小标签',
            contextText: config.createContext || '',
            hint: config.createHint || '',
            onCancel: () => setCreateOpen(false),
            onConfirm: (name) => {
              setCreateOpen(false)
              if (typeof config.onChange === 'function') config.onChange(name)
            },
          })
        : null

      return h('div', { className: 'dsh-ph-dropdown' }, trigger, menu, dialog)
    }

    /**
     * Nested 「新建小标签」 dialog.
     *
     * Own backdrop + own Escape handling: closing it never closes the ingest
     * modal or the dropdown behind it. Empty names are rejected with an inline
     * `role="alert"` error (never a toast). Enter confirms; clicking the
     * `确定` button (`#dsh-ph-new-small-tag-confirm`, styled like the shell's
     * native save button) calls `onConfirm(trimmedName)`.
     */
    function NewSmallTagDialog(props) {
      const config = props || {}
      const [name, setName] = React.useState('')
      const [error, setError] = React.useState('')

      const cancel = () => {
        if (typeof config.onCancel === 'function') config.onCancel()
      }

      // Capture + stopPropagation: Esc closes ONLY this dialog.
      React.useEffect(() => stopEscapeEventCapture(cancel), [config.onCancel])

      const confirm = () => {
        const clean = String(name || '').trim()
        if (!clean) {
          setError('请输入小标签名称后再确定。')
          return
        }
        setError('')
        if (typeof config.onConfirm === 'function') config.onConfirm(clean)
      }

      const onKeyDown = (event) => {
        if (!event) return
        if (event.key === 'Escape') {
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          if (typeof event.preventDefault === 'function') event.preventDefault()
          cancel()
          return
        }
        if (event.key === 'Enter') {
          // Chinese IME candidate commit also emits Enter: never confirm while a
          // composition is in progress (React exposes it on nativeEvent).
          const native = event.nativeEvent || {}
          if (native.isComposing || event.isComposing || event.keyCode === 229) return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          confirm()
        }
      }

      return h(
        'div',
        {
          className: 'dsh-ph-dropdown-dialog-backdrop',
          onMouseDown: (event) => {
            if (event && event.target === event.currentTarget) cancel()
          },
        },
        h(
          'div',
          {
            className: 'dsh-ph-dropdown-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': config.title || '新建小标签',
            onKeyDown,
          },
          h('div', { className: 'dsh-ph-dropdown-dialog-title' }, config.title || '新建小标签'),
          config.contextText
            ? h('div', { className: 'dsh-ph-dropdown-dialog-context' }, config.contextText)
            : null,
          h(
            'div',
            null,
            h('div', { className: 'dsh-ph-field-label' }, '小标签名称'),
            h('input', {
              id: NEW_SMALL_TAG_INPUT_ID,
              className: 'dsh-ph-input',
              value: name,
              // The dialog is opened from a menu row whose mousedown is
              // prevented (so the menu does not steal focus), hence focus must
              // land on the input explicitly: open -> type immediately.
              autoFocus: true,
              placeholder: '例如: 音画时间轴对齐',
              onChange: (event) => setName(event.target.value),
            }),
            error
              ? h(
                  'div',
                  {
                    id: NEW_SMALL_TAG_ERROR_ID,
                    className: 'dsh-ph-dropdown-dialog-error',
                    role: 'alert',
                  },
                  error,
                )
              : null,
          ),
          config.hint ? h('p', { className: 'dsh-ph-hint' }, config.hint) : null,
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px' } },
            h(
              'button',
              { type: 'button', id: NEW_SMALL_TAG_CANCEL_ID, className: 'dsh-ph-btn', onClick: cancel },
              '取消',
            ),
            h(
              'button',
              {
                type: 'button',
                id: NEW_SMALL_TAG_CONFIRM_ID,
                className: 'dsh-ph-btn dsh-ph-settings-save',
                onClick: confirm,
              },
              '确定',
            ),
          ),
        ),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Modal 2 — Ingest historical sessions (wide 2-column modal)
    // ═══════════════════════════════════════════════════════════════════════

    function IngestSessionsModal({ projects, sessions, selectedIds, setSelectedIds, onClose, onDone }) {
      const projectList = Array.isArray(projects) ? projects : []
      const [targetProj, setTargetProj] = React.useState((projectList[0] && projectList[0].id) || '')
      // No hard-coded example values: the big tag comes from the project and is
      // resolved through `resolveBigTagSelection` on every render, so switching
      // projects can never leave a stale/invalid option selected.
      const [bigTagDraft, setBigTagDraft] = React.useState('')
      const [smallTag, setSmallTag] = React.useState('')
      useEscape(onClose)

      const selectedProject =
        projectList.find((project) => project && project.id === targetProj) || projectList[0] || null
      const targetProjectId = selectedProject ? selectedProject.id : ''
      const bigTagOptions = listBigTagOptions(selectedProject)
      const bigTag = resolveBigTagSelection(selectedProject, bigTagDraft)
      const smallTagSuggestions = listSmallTagSuggestions(selectedProject, bigTag)
      const canSubmit = Boolean(targetProjectId && bigTag && smallTag.trim() && selectedIds.length > 0)

      // Switching 「目标归属项目」 must refresh the big-tag options; the previous
      // selection survives only while it is still a legal tag of the new
      // project, otherwise it falls back to the new project's first tag.
      const selectProject = (nextProjectId) => {
        setTargetProj(nextProjectId)
        const nextProject = projectList.find((project) => project && project.id === nextProjectId) || null
        setBigTagDraft((current) => resolveBigTagSelection(nextProject, current))
      }

      const toggleSelect = (sessionId) => {
        if (selectedIds.includes(sessionId)) setSelectedIds(selectedIds.filter((value) => value !== sessionId))
        else setSelectedIds([...selectedIds, sessionId])
      }

      const submit = async () => {
        if (!canSubmit) return
        try {
          const res = await requestApi('/project-hub/ingest-history', {
            method: 'POST',
            body: {
              sessionIds: selectedIds,
              projectId: targetProjectId,
              bigTag: bigTag.trim(),
              smallTag: smallTag.trim(),
            },
          })
          if (res && res.ok) onDone()
        } catch {
          /* silent */
        }
      }

      return h(
        ModalBackdrop,
        { onClose },
        h(
          'div',
          { className: 'dsh-ph-card', style: { width: '960px', height: '620px', maxWidth: '96vw', maxHeight: '90vh' } },
          h(
            'div',
            {
              style: {
                padding: '16px 24px',
                borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              },
            },
            h(
              'div',
              null,
              h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '归类历史会话到项目'),
              h(
                'div',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #777)', marginTop: '2px' } },
                '手动勾选已完成的会话，提炼为高保真 Markdown 档案并标注原始物理工作区',
              ),
            ),
            h(CloseButton, { onClose }),
          ),
          h(
            'div',
            { style: { flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 } },
            h(
              'div',
              {
                style: {
                  width: '60%',
                  borderRight: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  background: 'var(--dsw-alias-bg-base, #111215)',
                },
              },
              h(
                'div',
                {
                  style: {
                    padding: '12px 18px',
                    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                    fontSize: '11px',
                    color: 'var(--dsw-alias-label-tertiary, #777)',
                    display: 'flex',
                    justifyContent: 'space-between',
                  },
                },
                h('span', null, '现有会话列表 (勾选目标)'),
                h('span', { style: { fontFamily: 'monospace' } }, `已选 ${selectedIds.length} 条`),
              ),
              h(
                'div',
                { style: { flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' } },
                (sessions || []).length === 0
                  ? h('div', { className: 'dsh-ph-muted', style: { padding: '8px' } }, '正在读取历史会话…')
                  : (sessions || []).map((session) => {
                      const checked = selectedIds.includes(session.sessionId)
                      return h(
                        'label',
                        {
                          key: session.sessionId,
                          className: 'dsh-ph-session-row' + (checked ? ' is-checked' : ''),
                        },
                        h(
                          'div',
                          { style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
                          h('input', {
                            type: 'checkbox',
                            checked,
                            onChange: () => toggleSelect(session.sessionId),
                            style: { marginTop: '3px' },
                          }),
                          h(
                            'div',
                            { style: { flex: 1, minWidth: 0 } },
                            h(
                              'div',
                              {
                                style: {
                                  fontWeight: 500,
                                  fontSize: '13px',
                                  color: 'var(--dsw-alias-label-primary, #ededed)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                },
                              },
                              session.title || session.sessionId,
                            ),
                            h(
                              'div',
                              { className: 'dsh-ph-muted' },
                              `${formatTime(session.updatedAt)} · 改动文件 ${session.changedFiles == null ? '—' : session.changedFiles} 个`,
                            ),
                            h('div', { className: 'dsh-ph-muted' }, `工作区: ${session.cwd || '未知'}`),
                          ),
                        ),
                      )
                    }),
              ),
            ),
            h(
              'div',
              {
                style: {
                  width: '40%',
                  padding: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  minHeight: 0,
                  overflowY: 'auto',
                  background: 'var(--dsw-alias-bg-layer-1, #18191e)',
                },
              },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
                h(
                  'div',
                  null,
                  h('div', { className: 'dsh-ph-field-label' }, '1. 目标归属项目'),
                  // Custom themed listbox (no OS-drawn <select> popup): the
                  // options are the registry projects served by /project-hub/state.
                  h(IngestDropdown, {
                    id: 'dsh-ph-ingest-project',
                    ariaLabel: '目标归属项目',
                    value: targetProjectId,
                    options: projectList.map((project) => ({
                      value: project.id,
                      label: project.name || project.id,
                    })),
                    placeholder: '请选择目标项目',
                    emptyText: '暂无项目，请先「新建项目」。',
                    onChange: (nextProjectId) => selectProject(nextProjectId),
                  }),
                ),
                h(
                  'div',
                  null,
                  h('div', { className: 'dsh-ph-field-label' }, '2. 归属大标签 (主子系统)'),
                  // Choose-only custom listbox: big tags are ONLY the ones
                  // already defined for the project (registry `defaultTags` +
                  // existing `.dsh-hub/docs/<bigTag>/` folders). No free-text
                  // input, no OS-drawn <select> popup.
                  h(IngestDropdown, {
                    id: 'dsh-ph-ingest-big-tag',
                    ariaLabel: '归属大标签',
                    value: bigTag,
                    options: bigTagOptions,
                    placeholder:
                      bigTagOptions.length === 0
                        ? '该项目还没有大标签，请先在新建项目时定义'
                        : '请选择大标签',
                    emptyText: '该项目还没有大标签，请先在新建项目时定义',
                    disabled: bigTagOptions.length === 0,
                    onChange: (nextTag) => setBigTagDraft(nextTag),
                  }),
                  h(
                    'p',
                    { className: 'dsh-ph-hint' },
                    bigTagOptions.length === 0
                      ? '该项目还没有大标签，请先在新建项目时定义；这里不会退回自由输入。'
                      : '只能从项目已有的大标签中选择（新建项目时已定义，含项目知识库中已存在的大标签目录）。',
                  ),
                ),
                h(
                  'div',
                  null,
                  h('div', { className: 'dsh-ph-field-label' }, '3. 归属小标签 (具体交付模块)'),
                  // Same custom listbox as the two fields above; its menu adds a
                  // bottom 「＋ 新建小标签」 row that opens the nested dialog.
                  // Values may be an existing small tag OR a brand-new one —
                  // submit still posts the plain string.
                  h(IngestDropdown, {
                    id: 'dsh-ph-ingest-small-tag',
                    ariaLabel: '归属小标签',
                    value: smallTag,
                    options: smallTagSuggestions,
                    placeholder: '选择已有小标签，或新建一个',
                    emptyText: '当前大标签下还没有已有小标签',
                    allowCreate: true,
                    createLabel: '新建小标签',
                    createTitle: '新建小标签',
                    createContext: `项目：${selectedProject ? selectedProject.name : '—'} · 大标签：${
                      bigTag || '—'
                    }`,
                    createHint: bigTag
                      ? `确定后在提交时会写入项目知识库 .dsh-hub/docs/${bigTag}/<小标签>.md，并作为本次归档的归属小标签。`
                      : '确定后在提交时会写入项目知识库 .dsh-hub/docs/<大标签>/<小标签>.md。',
                    onChange: (nextSmallTag) => setSmallTag(nextSmallTag),
                  }),
                  h(
                    'p',
                    { className: 'dsh-ph-hint' },
                    smallTagSuggestions.length > 0
                      ? `可选可新建：从当前大标签下已有的 ${smallTagSuggestions.length} 个小标签中选择，或点菜单底部「＋ 新建小标签」新建。`
                      : '当前大标签下还没有已有小标签，点菜单底部「＋ 新建小标签」新建一个。',
                  ),
                ),
                h(
                  'div',
                  {
                    style: {
                      padding: '12px 14px',
                      borderRadius: 'var(--dsw-radius-sm, 8px)',
                      background: 'var(--dsw-alias-bg-base, #111215)',
                      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                      fontSize: '11px',
                      color: 'var(--dsw-alias-label-tertiary, #777)',
                      lineHeight: 1.5,
                    },
                  },
                  '归档后将在项目 .dsh-hub/docs/ 下生成规范 MD，并在 frontmatter 中永久标注原始物理工作区绝对路径。',
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '16px' } },
                h('button', { type: 'button', className: 'dsh-ph-btn', onClick: onClose }, '取消'),
                h(
                  'button',
                  primaryButtonProps({
                    id: 'dsh-ph-ingest-submit',
                    disabled: !canSubmit,
                    onClick: submit,
                  }),
                  '确认归档入库',
                ),
              ),
            ),
          ),
        ),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Modal 3 — Project task initiation (small-tag selection)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Launcher mode rows advertised by GET /project-hub/state (`agentModes`).
     * The Host decides availability from the composed Agent-preset roster;
     * this fallback keeps the modal usable against an older Host that never
     * sent the field (only 「标准模式」 then, because no Computer Use preset can
     * be assumed).
     */
    const DEFAULT_AGENT_MODES = [
      {
        id: 'standard',
        name: '标准模式',
        description: '常规开发 / 文档会话：编码、文件、搜索与子代理工具。',
        available: true,
      },
      {
        id: 'computer-use',
        name: 'Computer Use 模式',
        description: '桌面 GUI 操作：截图、鼠标键盘与桌面应用自动化。',
        available: false,
      },
    ]

    /** Normalize the Host mode catalog; never returns an empty list. */
    function normalizeTaskModes(rows) {
      const list = Array.isArray(rows)
        ? rows.filter((row) => row && typeof row.id === 'string' && row.id.trim())
        : []
      const source = list.length > 0 ? list : DEFAULT_AGENT_MODES
      const usable = source
        .filter((row) => row.available !== false)
        .map((row) => ({
          id: String(row.id),
          name: typeof row.name === 'string' && row.name.trim() ? row.name : String(row.id),
          description: typeof row.description === 'string' ? row.description : '',
        }))
      return usable.length > 0 ? usable : [{ id: 'standard', name: '标准模式', description: '' }]
    }

    function ProjectTaskModal({ project, globalRoot, onClose, agentModes, onRefresh }) {
      const [selectedTags, setSelectedTags] = React.useState([])
      // 「新建小标签」 row: local draft + inline error (never a toast/popup) +
      // the 大标签 it will be created under (only ambiguous with 2+ big tags).
      const [newTagName, setNewTagName] = React.useState('')
      const [newTagBig, setNewTagBig] = React.useState('')
      const [createTagError, setCreateTagError] = React.useState('')
      const [creatingTag, setCreatingTag] = React.useState(false)
      const modes = normalizeTaskModes(agentModes)
      const [taskMode, setTaskMode] = React.useState(modes[0] ? modes[0].id : 'standard')
      // The catalog can arrive after mount (`/project-hub/state` is async): a
      // stale/unknown selection falls back to the first usable mode.
      const activeMode = modes.some((mode) => mode.id === taskMode) ? taskMode : modes[0].id
      useEscape(onClose)

      const toggleTag = (tag) => {
        if (selectedTags.includes(tag)) setSelectedTags(selectedTags.filter((value) => value !== tag))
        else setSelectedTags([...selectedTags, tag])
      }

      const launch = async () => {
        try {
          const res = await requestApi('/project-hub/launch-session', {
            method: 'POST',
            body: {
              projectId: project.id,
              projectName: project.name,
              selectedSmallTags: selectedTags,
              mode: activeMode,
            },
          })
          if (res && res.ok) onClose()
        } catch {
          /* silent */
        }
      }

      const isCombo = selectedTags.length > 1
      const isSingle = selectedTags.length === 1
      const tagTree = project.tagTree || {}

      // 新建小标签档案: the Host writes docs/<大标签>/<小标签>.md from the same
      // five-section template (POST /project-hub/create-doc); on success the
      // refreshed state arrives through `onRefresh` and the new tag is checked.
      const bigTagOptions = Object.keys(tagTree)
      const targetBigTag = bigTagOptions.includes(newTagBig) ? newTagBig : bigTagOptions[0] || ''

      const createSmallTag = async () => {
        if (!targetBigTag) {
          setCreateTagError('当前项目还没有大标签，请先用「新建项目」定义大标签。')
          return
        }
        const name = String(newTagName || '').trim()
        if (!name) {
          setCreateTagError('请先输入小标签名称。')
          return
        }
        setCreateTagError('')
        setCreatingTag(true)
        try {
          const res = await requestApi('/project-hub/create-doc', {
            method: 'POST',
            body: {
              projectId: project.id,
              projectPath: project.projDir || '',
              bigTag: targetBigTag,
              smallTag: name,
            },
          })
          const data = res && res.data ? res.data : null
          if (res && res.ok && data && data.ok) {
            setNewTagName('')
            // Auto-check it: the checkbox state is small-tag-name keyed, so the
            // refreshed tag tree will immediately show it as selected.
            setSelectedTags((current) => (current.includes(name) ? current : [...current, name]))
            if (typeof onRefresh === 'function') await onRefresh()
          } else {
            const message = data && (data.error || data.message)
            setCreateTagError(String(message || '新建失败，请检查名称后重试。'))
          }
        } catch {
          setCreateTagError('无法连接项目工坊服务，新建失败。')
        } finally {
          setCreatingTag(false)
        }
      }

      return h(
        ModalBackdrop,
        { onClose },
        h(
          'div',
          { className: 'dsh-ph-card', style: { width: '560px', padding: '24px', gap: '16px', maxHeight: '88vh' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
              },
            },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { style: { fontSize: '15px', fontWeight: 600 } }, project.name),
              h('div', { className: 'dsh-ph-muted' }, project.projDir || project.id),
            ),
            h(CloseButton, { onClose }),
          ),
          h(
            'div',
            // Scrolls inside the fixed-height card: the mode selector adds a
            // fourth field, so short windows must scroll the form body instead
            // of clipping it (the card itself keeps overflow:hidden).
            { style: { display: 'flex', flexDirection: 'column', gap: '14px', minHeight: 0, overflowY: 'auto' } },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  color: 'var(--dsw-alias-label-secondary, #9a9ca6)',
                  fontSize: '12px',
                },
              },
              h('span', null, '请勾选本次任务需要载入参考的小标签 MD 档案：'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ph-refresh-btn',
                  title: '重新读取档案列表',
                  onClick: () => {
                    if (typeof onRefresh === 'function') onRefresh()
                  },
                },
                '↻ 刷新',
              ),
            ),
            h(
              'div',
              { style: { maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' } },
              Object.entries(tagTree).map(([bigTag, items]) =>
                h(
                  'div',
                  {
                    key: bigTag,
                    style: {
                      background: 'var(--dsw-alias-bg-base, #111215)',
                      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                      borderRadius: 'var(--dsw-radius-sm, 8px)',
                      padding: '12px 14px',
                    },
                  },
                  h(
                    'div',
                    {
                      style: {
                        fontWeight: 600,
                        fontSize: '12px',
                        color: 'var(--dsw-alias-label-secondary, #a0a4b0)',
                        marginBottom: '8px',
                      },
                    },
                    `[${bigTag}]`,
                  ),
                  items.length === 0
                    ? h('div', { className: 'dsh-ph-muted', style: { padding: '4px' } }, '暂无小标签 MD')
                    : items.map((item) => {
                        const checked = selectedTags.includes(item.smallTag)
                        return h(
                          'label',
                          {
                            key: item.smallTag,
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '6px 8px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              background: checked ? 'var(--dsw-alias-bg-layer-2, #23252d)' : 'transparent',
                            },
                          },
                          h(
                            'span',
                            { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' } },
                            h('input', {
                              type: 'checkbox',
                              checked,
                              onChange: () => toggleTag(item.smallTag),
                            }),
                            h('span', null, `${item.smallTag}.md`),
                          ),
                          h(
                            'span',
                            { className: 'dsh-ph-muted', style: { marginTop: 0 } },
                            item.workspacePath ? item.workspacePath.split(/[\/\\]/).pop() : '',
                          ),
                        )
                      }),
                ),
              ),
            ),
            // 新建小标签档案 — 输入框 + 按钮（沿用弹窗既有 .dsh-ph-input/.dsh-ph-btn
            // 皮肤）；Host 生成五节模板 MD，成功后刷新列表并自动勾选。
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '12px 14px',
                  borderRadius: 'var(--dsw-radius-sm, 8px)',
                  background: 'var(--dsw-alias-bg-base, #111215)',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                },
              },
              h('div', { className: 'dsh-ph-field-label', style: { marginBottom: 0 } }, '新建小标签档案'),
              bigTagOptions.length > 1
                ? h(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                    bigTagOptions.map((bigTag) => {
                      const active = bigTag === targetBigTag
                      return h(
                        'button',
                        {
                          key: bigTag,
                          type: 'button',
                          className: 'dsh-ph-btn dsh-ph-btn-sm',
                          'aria-pressed': active ? 'true' : 'false',
                          style: {
                            border: active
                              ? '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.2))'
                              : '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                            background: active
                              ? 'var(--dsw-alias-bg-layer-2, #23252d)'
                              : 'var(--dsw-alias-bg-base, #111215)',
                          },
                          onClick: () => setNewTagBig(bigTag),
                        },
                        `[${bigTag}]`,
                      )
                    }),
                  )
                : h(
                    'div',
                    { className: 'dsh-ph-muted', style: { marginTop: 0 } },
                    targetBigTag ? `归属大标签：[${targetBigTag}]` : '当前项目还没有大标签。',
                  ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('input', {
                  className: 'dsh-ph-input',
                  style: { flex: '1 1 auto' },
                  placeholder: '例如: 音画时间轴对齐',
                  value: newTagName,
                  disabled: creatingTag || !targetBigTag,
                  onChange: (event) => {
                    setNewTagName(event.target.value)
                    setCreateTagError('')
                  },
                  onKeyDown: (event) => {
                    if (!event || event.key !== 'Enter') return
                    // Chinese IME candidate commit also emits Enter.
                    const native = event.nativeEvent || {}
                    if (native.isComposing || event.isComposing || event.keyCode === 229) return
                    if (typeof event.preventDefault === 'function') event.preventDefault()
                    createSmallTag()
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ph-btn',
                    disabled: creatingTag || !targetBigTag,
                    onClick: createSmallTag,
                  },
                  creatingTag ? '新建中…' : '新建小标签',
                ),
              ),
              createTagError
                ? h('div', { className: 'dsh-ph-inline-error', role: 'alert' }, createTagError)
                : null,
            ),
            h(
              'div',
              null,
              h('div', { className: 'dsh-ph-field-label' }, '会话模式'),
              h(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: modes.length > 1 ? '1fr 1fr' : '1fr',
                    gap: '8px',
                    marginTop: '6px',
                  },
                },
                modes.map((mode) => {
                  const active = mode.id === activeMode
                  return h(
                    'button',
                    {
                      key: mode.id,
                      type: 'button',
                      id: `dsh-ph-task-mode-${mode.id}`,
                      className: 'dsh-ph-btn' + (active ? ' is-active' : ''),
                      'data-mode': mode.id,
                      'aria-pressed': active ? 'true' : 'false',
                      onClick: () => setTaskMode(mode.id),
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        justifyContent: 'center',
                        gap: '4px',
                        padding: '10px 12px',
                        minHeight: '58px',
                        textAlign: 'left',
                        borderRadius: 'var(--dsw-radius-sm, 8px)',
                        border: active
                          ? '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.2))'
                          : '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                        background: active
                          ? 'var(--dsw-alias-bg-layer-2, #23252d)'
                          : 'var(--dsw-alias-bg-base, #111215)',
                        color: 'var(--dsw-alias-label-primary, #ededed)',
                        cursor: 'pointer',
                      },
                    },
                    h('span', { style: { fontSize: '12px', fontWeight: 600 } }, mode.name),
                    mode.description
                      ? h(
                          'span',
                          {
                            className: 'dsh-ph-muted',
                            style: { marginTop: 0, fontSize: '11px', whiteSpace: 'normal', textAlign: 'left' },
                          },
                          mode.description,
                        )
                      : null,
                  )
                }),
              ),
              h(
                'p',
                { className: 'dsh-ph-hint' },
                '两种模式都以完全权限启动（danger-full-access 文件策略 + never 审批策略），无需再手动切换权限。',
              ),
            ),
            h(
              'div',
              {
                style: {
                  padding: '12px 16px',
                  borderRadius: 'var(--dsw-radius-sm, 8px)',
                  background: 'var(--dsw-alias-bg-base, #111215)',
                  border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))',
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-secondary, #9a9ca6)',
                  lineHeight: 1.5,
                },
              },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
                h('strong', { style: { fontSize: '12px' } }, '子工作区计算:'),
                h(
                  'span',
                  {
                    style: {
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '4px',
                      // Informational badge (not a button): keep the proven
                      // neutral surface + primary label of the visible 「取消」
                      // button rather than the primary fill (whose matching
                      // label token is not reliable across shell builds).
                      background: 'var(--dsw-alias-bg-layer-2, #2c2e36)',
                      border: isCombo
                        ? '1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.2))'
                        : '1px solid transparent',
                      color: 'var(--dsw-alias-label-primary, #ededed)',
                    },
                  },
                  isCombo ? '多标签复合子工作区' : isSingle ? '单标签专属子工作区' : '项目根工作区',
                ),
              ),
              h(
                'div',
                { style: { color: 'var(--dsw-alias-label-tertiary, #777)', marginTop: '4px' } },
                isCombo
                  ? `将自动在 ${globalRoot || '项目目录'}\\<项目>\\subtasks\\ 下新建 combo-<日期>-<标签串> 复合子工作区，并作为新会话 cwd。`
                  : isSingle
                  ? '会话直接定位至该小标签在 subtasks/ 下的独立子工作区。'
                  : '未选择标签，会话直接在项目主根目录下就绪。',
              ),
            ),
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                paddingTop: '12px',
                borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
              },
            },
            h('button', { type: 'button', className: 'dsh-ph-btn', onClick: onClose }, '取消'),
            h('button', primaryButtonProps({ onClick: launch }), '启动会话'),
          ),
        ),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Modal 4 — 总工作区设置 (global workspace root)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 14px line-art gear for the drawer footer 「设置」 entry.
     *
     * Inline SVG (no icon font, no dependency, no colour emoji): the shell
     * paints it via `stroke="currentColor" fill="none"`, so it inherits the
     * entry's quiet label colour in both the dark and light theme.
     */
    const SETTINGS_GEAR_PATH =
      'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'

    function SettingsGearIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: SETTINGS_GEAR_PATH }),
        h('circle', { cx: 12, cy: 12, r: 3 }),
      )
    }

    /**
     * 「总工作区设置」 modal — ONE field (总工作区根目录).
     *
     * The value arrives from `GET /project-hub/state` (`globalWorkspaceRoot`,
     * held in HubApp state and passed down as `globalWorkspaceRoot`) and is
     * persisted with `POST /project-hub/settings`
     * (`{ globalWorkspaceRoot }` -> `{ ok, globalWorkspaceRoot }`).
     *
     * Failure is INLINE and non-blocking: `#dsh-ph-settings-error`
     * (role="alert", `--dsw-alias-state-error-primary`) shows the Host's own
     * message, the modal stays open, and nothing is toasted/popup-ed. On
     * success `onSaved(root)` lets HubApp close the modal, adopt the root and
     * reload the project list from the new 总工作区.
     */
    function SettingsModal({ globalWorkspaceRoot, onClose, onSaved }) {
      const initialRoot =
        typeof globalWorkspaceRoot === 'string' && globalWorkspaceRoot.trim()
          ? globalWorkspaceRoot
          : DEFAULT_GLOBAL_WORKSPACE_ROOT
      const [root, setRoot] = React.useState(initialRoot)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      useEscape(onClose)

      const canSave = Boolean(String(root || '').trim()) && !saving

      const submit = async () => {
        const value = String(root || '').trim()
        if (!value || saving) return
        setSaving(true)
        setError('')
        let savedRoot = ''
        try {
          const res = await requestApi('/project-hub/settings', {
            method: 'POST',
            body: { globalWorkspaceRoot: value },
          })
          const data = res && res.data ? res.data : null
          if (res && res.ok && data && data.ok !== false) {
            savedRoot =
              typeof data.globalWorkspaceRoot === 'string' && data.globalWorkspaceRoot.trim()
                ? data.globalWorkspaceRoot
                : value
          } else {
            // Host contract: 400 { ok:false, code, message }. Show its message.
            setError((data && (data.message || data.error)) || '保存失败：请确认该目录存在且可写。')
          }
        } catch {
          setError('保存失败：无法连接本地服务，请稍后重试。')
        } finally {
          setSaving(false)
        }
        // Called outside the try/catch so a HubApp render error never turns a
        // successful save into an inline error.
        if (savedRoot && typeof onSaved === 'function') onSaved(savedRoot)
      }

      return h(
        ModalBackdrop,
        { onClose },
        h(
          'div',
          { className: 'dsh-ph-card', style: { width: '460px', maxWidth: '92vw', padding: '24px', gap: '16px' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '14px',
                borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
              },
            },
            h('span', { style: { fontSize: '15px', fontWeight: 600 } }, '总工作区设置'),
            h(CloseButton, { onClose }),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('div', { className: 'dsh-ph-field-label' }, '总工作区根目录'),
            h('input', {
              id: 'dsh-ph-settings-root',
              className: 'dsh-ph-input',
              value: root,
              spellCheck: false,
              placeholder: DEFAULT_GLOBAL_WORKSPACE_ROOT,
              onChange: (event) => setRoot(event.target.value),
            }),
            h(
              'p',
              { className: 'dsh-ph-hint' },
              '默认根目录为 C:\\work。必须填写一个已存在的绝对目录（例如 D:\\work\\project-hub）；保存后立即生效，作用于面板状态、新建项目/会话以及「其他 (杂务)」。',
            ),
            error
              ? h(
                  'div',
                  {
                    id: 'dsh-ph-settings-error',
                    className: 'dsh-ph-settings-error',
                    role: 'alert',
                  },
                  error,
                )
              : null,
          ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '2px' } },
            h('button', { type: 'button', className: 'dsh-ph-btn', onClick: onClose }, '取消'),
            h(
              'button',
              {
                type: 'button',
                id: 'dsh-ph-settings-save',
                className: 'dsh-ph-btn dsh-ph-settings-save',
                disabled: !canSave,
                onClick: submit,
              },
              '保存',
            ),
          ),
        ),
      )
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Cordis client exports
    // ═══════════════════════════════════════════════════════════════════════

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      const slots =
        ctx && ctx.slots !== undefined && ctx.slots !== null
          ? ctx.slots
          : ctx && typeof ctx.get === 'function'
          ? ctx.get('slots')
          : null

      // 1. Own the drawer: its React root lives in the portal host, so the
      //    drawer exists independently of any slot occupant.
      let disposeRoot = () => {}
      try {
        const host = ensurePortalHost()
        if (host) {
          const dispose = mountHubApp(host)
          if (typeof dispose === 'function') disposeRoot = dispose
        }
      } catch {
        /* the slot path below still renders a trigger */
      }

      // 2. Belt-and-braces DOM entry probe (structural, silent on failure):
      //    only the `+ 项目工坊` nav row. The old workspace-header `+` is gone
      //    (removed on user request, see ENTRY POINTS at the top).
      let disposeProbe = () => {}
      try {
        disposeProbe = installEntryProbe()
      } catch {
        disposeProbe = () => {}
      }

      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(
            () => () => {
              try {
                disposeProbe()
              } catch {
                /* ignore */
              }
              try {
                disposeRoot()
              } catch {
                /* ignore */
              }
            },
            'dsh-project-hub: entry point',
          )
        } catch {
          /* unload cleanup is best effort */
        }
      }

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      // 3. Official `sidebar.footer.action` seat (DECLARED list slot, rendered
      //    inside `footArea` > `footerActions`). Kept registered, but it hides
      //    itself while the DOM `+ 项目工坊` nav row paints.
      //    DO NOT register `sidebar.panellist`: that seat is main-panel
      //    navigation, its row click calls `layout.selectPanel(id)` and throws
      //    for a plugin that owns no panel.
      try {
        slots.inject('sidebar.footer.action', () => {
          try {
            return slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'project-hub-launcher',
                order: -100,
                label: () => '项目工坊',
              },
              ProjectHubEntry,
            )
          } catch {
            return undefined
          }
        })
      } catch {
        /* a rejected slot registration must not break the DOM entry */
      }

      // 4. `sidebar.panellist.actions` — DECLARED list slot, the content of the
      //    panel list's 「更多」 menu. A one-row `+` entry there keeps the drawer
      //    reachable from the shell menu; it renders nothing while the nav row
      //    paints, so the user never sees the same 「项目工坊」 entry twice.
      try {
        slots.inject('sidebar.panellist.actions', () => {
          try {
            return slots.register(
              {
                name: 'sidebar.panellist.actions',
                id: 'project-hub-panel-action',
                order: 10,
                label: () => '项目工坊',
              },
              PanelActionEntry,
            )
          } catch {
            return undefined
          }
        })
      } catch {
        /* optional shell-menu path */
      }
    }

    // Test seam (Node unit tests load this factory with a stub module table and
    // assert that the URL builder always yields an absolute http(s) base; the
    // entry-point tests drive the DOM probe with a stub document).
    exports.__test__ = {
      DEFAULT_HOST_BASE,
      resolveHostBase,
      buildApiUrl,
      primeHostBaseFromBridge,
      requestApi,
      syncNavEntry,
      findSidebarRoot,
      findNavList,
      findNativePanelRow,
      findNavRowSeat,
      isRailSidebar,
      isVisible,
      isSeatVisible,
      isDomEntryVisible: () => domEntryVisible,
      isNavRowVisible: () => navRowVisible,
      ENTRY_ATTR,
      DRAWER_ATTR,
      NAV_ROW_ID,
      NAV_ROW_CLASS,
      NAV_ROW_RAIL_CLASS,
      // 「归类历史」 ingest form: pure tag-option helpers + the component itself
      // (Node tests render it with the stub React to assert the control shape).
      listBigTagOptions,
      resolveBigTagSelection,
      listSmallTagSuggestions,
      IngestSessionsModal,
      // Custom themed dropdown (replaces the OS-drawn native popup) + the
      // nested 「新建小标签」 dialog, with their pure helpers and element ids.
      IngestDropdown,
      NewSmallTagDialog,
      normalizeDropdownOptions,
      computeDropdownPlacement,
      bindDropdownDismiss,
      stopEscapeEventCapture,
      dropdownMenuId,
      NEW_SMALL_TAG_INPUT_ID,
      NEW_SMALL_TAG_ERROR_ID,
      NEW_SMALL_TAG_CONFIRM_ID,
      NEW_SMALL_TAG_CANCEL_ID,
      // Deterministic primary-button contrast (no reliance on label tokens).
      PRIMARY_TEXT_DARK,
      PRIMARY_TEXT_LIGHT,
      PRIMARY_TEXT_FALLBACK,
      PRIMARY_BUTTON_CLASS,
      parseCssColor,
      relativeLuminance,
      contrastRatio,
      pickReadableTextColor,
      applyReadablePrimaryText,
      primaryButtonRef,
      primaryButtonProps,
      NewProjectModal,
      ProjectTaskModal,
      // 「启动会话」 agent modes: 「标准模式」 / 「Computer Use 模式」, both full access.
      DEFAULT_AGENT_MODES,
      normalizeTaskModes,
      // 总工作区设置: the drawer footer 「设置」 entry + its one-field modal.
      DEFAULT_GLOBAL_WORKSPACE_ROOT,
      SettingsModal,
      SettingsGearIcon,
      HubApp,
      ensureStyles,
    }

    return module.exports
}

try {
  bootstrapClientModule(projectHubClientFactory)
} catch {
  /* the client half is optional UI: never break the shell boot */
}
})()
