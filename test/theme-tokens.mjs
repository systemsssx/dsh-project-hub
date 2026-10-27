/**
 * dsh-project-hub — test/theme-tokens.mjs
 *
 * Guards against the two "guessed token name" regressions this shell already hit
 * (`--dsw-alias-button-primary-label`, `--dsw-alias-label-primary-foreground`):
 * every `--dsw-*` token referenced by `lib/client.js` must exist in
 * `test/dsw-token-manifest.json`, which is a byte-scan of the shipped
 * `resources/app.asar` text for `--dsw-*` (the `dsh-client-ui-theme` package is
 * the definition source). If a shell build renames/removes a token, this test
 * fails instead of silently rendering a transparent/unstyled control.
 *
 * Run directly:  node test/theme-tokens.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./dsw-token-manifest.json', import.meta.url), 'utf8'))
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Tokens the 总工作区设置 form / native-looking select+input must use. */
const REQUIRED_FORM_TOKENS = [
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

test('DSH theme tokens used by dsh-project-hub exist in the app.asar scan', async (t) => {
  const known = new Set(Array.isArray(manifest.tokens) ? manifest.tokens : [])

  await t.test('the manifest is a real app.asar token scan (not a guessed list)', () => {
    assert.equal(typeof manifest.source, 'string')
    assert.match(manifest.source, /app\.asar/, 'manifest must record its app.asar provenance')
    assert.ok(known.size >= 400, `expected the full theme token surface, got ${known.size}`)
    assert.equal(manifest.count, manifest.tokens.length)
    for (const token of manifest.tokens) {
      assert.match(token, /^--dsw-[a-z0-9-]+$/, `manifest entry must be a token name: ${token}`)
    }
    // A few tokens the shell's own native form controls use, proving the scan
    // really reached dsh-client-ui-theme and not some arbitrary selector list.
    for (const token of ['--dsw-alias-bg-base', '--dsw-alias-border-l2', '--dsw-radius-lg']) {
      assert.ok(known.has(token), `manifest must contain ${token}`)
    }
  })

  await t.test('every --dsw-* token referenced by lib/client.js is in the scan', () => {
    const used = new Set(clientSource.match(/--dsw-[a-z0-9-]+/g) || [])
    assert.ok(used.size >= 15, `client must reference the themed surface (got ${used.size})`)
    const unknown = [...used].filter((token) => !known.has(token)).sort()
    assert.deepEqual(
      unknown,
      [],
      `client.js references tokens that do not exist in the shipped theme: ${unknown.join(', ')}`,
    )
  })

  await t.test('the settings form / native select+input use only verified tokens', () => {
    for (const token of REQUIRED_FORM_TOKENS) {
      assert.ok(known.has(token), `${token} must be a real app.asar token`)
      assert.ok(clientSource.includes(token), `${token} must be used by the project-hub stylesheet`)
    }
    // The four primary buttons keep the measured-background contrast approach;
    // these two names were the exact guesses that broke earlier and must never
    // come back (the ingest test also guards the second one).
    assert.equal(clientSource.includes('--dsw-alias-button-primary-label'), false)
    assert.equal(clientSource.includes('--dsw-alias-label-primary-foreground'), false)
  })
})
