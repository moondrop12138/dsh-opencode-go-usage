#!/usr/bin/env node
/**
 * Live probe for dsh-opencode-go-usage.
 *
 * Reads `OPENCODE_GO_API_KEY` from the DSH credentials file (only that one
 * line, quoted or not) or from the environment, then performs one real
 * `GET <origin>/zen/go/v1/usage` through the same internals the plugin uses.
 *
 * It never prints the key value — only the reference name and the last four
 * characters (`keyHint`). Every diagnostic line is redacted before printing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { __internals } from '../lib/host.js'

const { dshHome, fetchGoUsage, resolveSource } = __internals
const KEY_REF = 'OPENCODE_GO_API_KEY'
const TIMEOUT_MS = 15_000

/** Extract one credential line from a small YAML file. Quoted values are fine. */
function readCredential(file, name) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { value: '', error }
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp('^[ \\t]*' + escaped + '[ \\t]*:[ \\t]*(.*?)[ \\t]*$', 'm'))
  if (!match) return { value: '', error: null }

  let value = match[1]
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1)
      if (first === '"') value = value.replace(/\\"/g, '"')
    }
  }
  return { value: value.trim(), error: null }
}

function redact(text, secret) {
  let out = String(text)
  if (typeof secret === 'string' && secret !== '') out = out.split(secret).join('[redacted]')
  return out.replace(/\b(?:oc_sk_|sk-)[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
}

function printWindow(label, window) {
  const percent = typeof window.percent === 'number' ? window.percent : 0
  const resetAt = window.resetAt === '' ? '—' : window.resetAt
  console.log(
    label.padEnd(8) + ': ' + String(percent) + '%'
      + '  status=' + window.status
      + '  resetAt=' + resetAt
      + '  resetInSec=' + window.resetInSec,
  )
}

async function main() {
  const home = dshHome()
  const credentialsFile = join(home, '.credentials.yaml')
  const fileHit = readCredential(credentialsFile, KEY_REF)
  const envKey = (process.env[KEY_REF] || '').trim()

  // Match the host priority: DSH credentials first, environment as fallback.
  const apiKey = fileHit.value || envKey
  const keySource = fileHit.value !== ''
    ? credentialsFile
    : envKey !== ''
      ? 'process.env.' + KEY_REF
      : 'none'

  const ctx = {
    get(service) {
      if (service === 'settings') {
        return { get: () => undefined }
      }
      if (service === 'credentials') {
        return {
          async resolve(ref) {
            return ref === KEY_REF && apiKey !== '' ? { value: apiKey, source: 'probe' } : null
          },
        }
      }
      return undefined
    },
  }

  const source = await resolveSource(ctx, { apiKeyEnv: KEY_REF })
  console.log('OpenCode Go usage probe')
  console.log('baseUrl  : ' + source.baseUrl)
  console.log('usageUrl : ' + source.usageUrl)
  console.log('keyRef   : ' + source.keyRef)
  console.log('keyHint  : ' + source.keyHint)
  console.log('keySource: ' + keySource)
  console.log('home     : ' + home)
  console.log('')

  if (source.apiKey === '') {
    console.error(
      'no key: set ' + KEY_REF + ' in ' + credentialsFile
        + ' (or export it in the environment).',
    )
    process.exitCode = 1
    return
  }

  const startedAt = Date.now()
  try {
    const result = await fetchGoUsage({
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      timeoutMs: TIMEOUT_MS,
    })
    console.log('HTTP ' + result.status + ' in ' + (Date.now() - startedAt) + 'ms')
    printWindow('rolling', result.windows.rolling)
    printWindow('weekly', result.windows.weekly)
    printWindow('monthly', result.windows.monthly)
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'error'
    const message = redact(error && error.message ? error.message : error, source.apiKey)
    const details = error && error.details && typeof error.details === 'object' ? error.details : {}
    console.error('probe failed: code=' + code + ' message=' + message)
    if (Object.keys(details).length > 0) {
      console.error('details: ' + JSON.stringify(details))
    }
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('probe crashed: ' + redact(error && error.message ? error.message : error, process.env[KEY_REF]))
  process.exitCode = 1
})
