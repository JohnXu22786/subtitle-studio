/**
 * Shared test helpers (plain JavaScript — tests run directly under node:test).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a temporary scratch directory (cleaned up after the test). */
export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'subtitle-studio-test-'))
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}

export function writeTestFile(dir, name, content) {
  const path = join(dir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

/** Fake HTTP response object matching what OpenAiClient consumes. */
export function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'HTTP ' + status,
    text: async () => body,
  }
}

/**
 * Install a mock `globalThis.fetch` that returns the queued responses in
 * order. Each entry may be a string (HTTP 200 body) or an object
 * `{ status, body }`. Returns a recorder capturing every request.
 */
export function stubFetch(responses, perRequest) {
  const requests = []
  const original = globalThis.fetch
  let index = 0
  globalThis.fetch = async (url, init) => {
    const req = { url: String(url), init }
    requests.push(req)
    if (perRequest) perRequest(req)
    const response = responses[Math.min(index, responses.length - 1)] ?? ''
    index++
    const status = typeof response === 'object' ? response.status : 200
    const body = typeof response === 'object' ? response.body : response
    return fakeResponse(status, body)
  }
  return {
    requests,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** JSON string for an OpenAI-compatible chat completion. */
export function completionJson(content, usage) {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usage
      ? { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion }
      : undefined,
  })
}
