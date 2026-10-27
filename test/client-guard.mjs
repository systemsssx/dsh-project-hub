/**
 * dsh-project-hub — test/client-guard.mjs
 *
 * Self-test for the top-level module-loader guard in `lib/client.js`.
 *
 * The guard exists because the client bundle is evaluated by the DSH client
 * module system BEFORE the `window.__ModuleLoader__` bootstrap facade is
 * guaranteed to be published (observed on a desktop renderer reload). The
 * bundle must therefore never throw at the top level. This test evaluates
 * `lib/client.js` once in each of the three environments that matter:
 *
 *   (a) no `window` at all (plain Node module evaluation);
 *   (b) `window` exists but `__ModuleLoader__` does not yet;
 *   (c) `window.__ModuleLoader__` exists — `load()` must be called exactly once
 *       with `id === 'dsh-project-hub'`.
 *
 * None of the three evaluations may throw, and no DOM access may happen at the
 * top level (`document` is absent from every stub context).
 *
 * Run directly:  node test/client-guard.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** Minimal `setTimeout` stub so a missing facade schedules (but never throws). */
function makeTimerStub() {
  const scheduled = []
  const setTimeoutStub = (callback, delay) => {
    const handle = { callback, delay, unref() {} }
    scheduled.push(handle)
    return handle
  }
  return { scheduled, setTimeoutStub }
}

/** Evaluate `lib/client.js` once in a fresh vm context; returns the context. */
function evaluateClient(sandbox) {
  const context = vm.createContext(sandbox)
  assert.doesNotThrow(() => {
    new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInContext(context)
  }, 'evaluating lib/client.js must never throw')
  return context
}

// ── (a) no window ─────────────────────────────────────────────────────────
{
  const { scheduled, setTimeoutStub } = makeTimerStub()
  const sandbox = { setTimeout: setTimeoutStub }
  evaluateClient(sandbox)
  assert.equal(typeof sandbox.window, 'undefined')
  // Nothing to register against; the guard may arm a poll but must stay silent.
  assert.ok(Array.isArray(scheduled))
  console.log('(a) no window: evaluated without throwing — OK')
}

// ── (b) window present, loader facade missing ─────────────────────────────
{
  const { scheduled, setTimeoutStub } = makeTimerStub()
  const sandbox = { window: {}, setTimeout: setTimeoutStub }
  evaluateClient(sandbox)
  assert.equal(typeof sandbox.window.__ModuleLoader__, 'undefined')
  assert.ok(scheduled.length >= 1, 'a bounded retry must be armed while the facade is missing')
  // Run the queued retries: still absent => still no throw, still bounded.
  let guard = 0
  while (scheduled.length > 0 && guard < 5) {
    const next = scheduled.shift()
    assert.doesNotThrow(() => next.callback())
    guard += 1
  }
  assert.equal(sandbox.window.__ModuleLoader__, undefined)
  console.log('(b) window without __ModuleLoader__: evaluated without throwing — OK')

  // Late facade arrival: the next poll must register exactly once.
  const late = []
  sandbox.window.__ModuleLoader__ = { load: (registration) => late.push(registration) }
  const pending = scheduled.shift()
  if (pending) pending.callback()
  assert.equal(late.length, 1, 'late facade must be used by the next retry')
  assert.equal(late[0].id, 'dsh-project-hub')
  console.log('(b+) late facade: retry registered the bundle once — OK')
}

// ── (c) window + working loader facade ────────────────────────────────────
{
  const loads = []
  const { setTimeoutStub } = makeTimerStub()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          loads.push(registration)
        },
      },
    },
    setTimeout: setTimeoutStub,
  }
  evaluateClient(sandbox)
  assert.equal(loads.length, 1, '`__ModuleLoader__.load` must be called exactly once')
  assert.equal(loads[0].id, 'dsh-project-hub', 'factory id must match the boot graph entry id')
  assert.equal(typeof loads[0].factory, 'function', 'load() must hand over the CJS factory')
  console.log('(c) stub __ModuleLoader__: load({id:"dsh-project-hub"}) called once — OK')
}

// ── (d) a throwing loader must still not escape ───────────────────────────
{
  const { setTimeoutStub } = makeTimerStub()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load() {
          throw new Error('duplicate factory registration (simulated)')
        },
      },
    },
    setTimeout: setTimeoutStub,
  }
  evaluateClient(sandbox)
  console.log('(d) throwing loader: evaluation still silent — OK')
}

console.log('\nclient guard: 4/4 scenarios pass')
