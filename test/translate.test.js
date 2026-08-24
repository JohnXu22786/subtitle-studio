import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmClient, LlmError } from '../lib/translate/llm.js'
import {
  chunkCues,
  buildSystemPrompt,
  parseTranslationPayload,
  translateCues,
  translateDocument,
} from '../lib/translate/translate.js'
import { estimateTokens, ratesForModel } from '../lib/translate/cost.js'
import { parseSrt } from '../lib/core/srt.js'
import { createGlossary, upsertEntry } from '../lib/translate/glossary.js'
import { stubFetch, completionJson } from './helpers.js'

const DOC = parseSrt([
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Hello world.',
  '',
  '2',
  '00:00:04,500 --> 00:00:08,000',
  'How are you?',
  '',
].join('\n')).document

function oilClient(overrides = {}) {
  return createLlmClient({
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    ...overrides,
  })
}

test('OpenAiClient posts a well-formed chat completion request', async () => {
  const stub = stubFetch([completionJson('{"i":1,"t":"你好"}', { prompt: 12, completion: 5 })])
  try {
    const client = oilClient()
    const result = await client.complete([{ role: 'user', content: 'hi' }], {}, undefined)
    assert.equal(stub.requests.length, 1)
    const req = stub.requests[0]
    assert.equal(req.url, 'https://api.example.com/v1/chat/completions')
    assert.equal(req.init.method, 'POST')
    assert.equal(req.init.headers['authorization'], 'Bearer sk-test')
    assert.equal(req.init.headers['content-type'], 'application/json')
    const body = JSON.parse(req.init.body)
    assert.equal(body.model, 'deepseek-chat')
    assert.equal(body.messages[0].content, 'hi')
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 })
  } finally {
    stub.restore()
  }
})

test('jsonMode adds response_format, and falls back on HTTP 400', async () => {
  const stub = stubFetch([
    { status: 400, body: '{"error":{"message":"response_format unsupported"}}' },
    completionJson('{"translations":[{"i":1,"t":"ok"}]}'),
  ])
  try {
    const client = oilClient({ jsonMode: true })
    const result = await client.complete([{ role: 'user', content: 'x' }], {}, undefined)
    assert.equal(stub.requests.length, 2)
    const first = JSON.parse(stub.requests[0].init.body)
    assert.ok(first.response_format)
    const second = JSON.parse(stub.requests[1].init.body)
    assert.ok(!second.response_format)
    assert.equal(result.text.includes('ok'), true)
  } finally {
    stub.restore()
  }
})

test('retries transient 429/5xx with backoff, then succeeds', async () => {
  const stub = stubFetch([
    { status: 429, body: '{"error":{"message":"rate limit"}}' },
    completionJson('[{"i":1,"t":"retried"}]'),
  ])
  try {
    const client = oilClient({ maxRetries: 2, jsonMode: false })
    const result = await client.complete([{ role: 'user', content: 'x' }], {}, undefined)
    assert.equal(stub.requests.length, 2)
    assert.equal(result.text, '[{"i":1,"t":"retried"}]')
  } finally {
    stub.restore()
  }
})

test('throws a terminal auth error without retrying', async () => {
  const stub = stubFetch([
    { status: 401, body: '{"error":{"message":"bad key"}}' },
    { status: 401, body: '{"error":{"message":"bad key"}}' },
  ])
  try {
    const client = oilClient({ jsonMode: false })
    await assert.rejects(
      () => client.complete([{ role: 'user', content: 'x' }], {}, undefined),
      (e) => e instanceof LlmError && e.code === 'auth' && stub.requests.length === 1,
    )
  } finally {
    stub.restore()
  }
})

test('requires an API key for the openai provider', () => {
  assert.throws(
    () => createLlmClient({ provider: 'openai', baseUrl: 'http://x', model: 'm' }),
    (e) => e instanceof LlmError && e.code === 'auth',
  )
})

test('DshClient consumes the ctx.llm seam stream', async () => {
  async function* stream() {
    yield { type: 'text-delta', text: '[{"i":1,"t":"你好' }
    yield { type: 'text-delta', text: '"}]' }
    yield { type: 'usage', usage: { promptTokens: 9, completionTokens: 4 } }
    yield { type: 'finish', kind: 'success' }
  }
  const client = createLlmClient(
    { provider: 'dsh', model: 'm' },
    { seam: { stream } },
  )
  const result = await client.complete([{ role: 'user', content: 'x' }], {}, undefined)
  assert.equal(result.text, '[{"i":1,"t":"你好"}]')
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4 })
})

test('chunkCues respects the character budget', () => {
  const cues = [
    { index: 1, start: 0, end: 1, text: 'a'.repeat(600) },
    { index: 2, start: 1, end: 2, text: 'b'.repeat(600) },
    { index: 3, start: 2, end: 3, text: 'c' },
    { index: 4, start: 3, end: 4, text: 'd' },
  ]
  const chunks = chunkCues(cues, 1000)
  // cue 1 (604 chars) opens a chunk; cue 2 (604) cannot join it (1208 > 1000),
  // so a new chunk starts; cues 3–4 then pack into that same chunk.
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[0].map((c) => c.index), [1])
  assert.deepEqual(chunks[1].map((c) => c.index), [2, 3, 4])
})

test('buildSystemPrompt differs between jsonMode on/off and injects glossary', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'DeepSeek', target: '深度求索', scope: 'zh' })
  const on = buildSystemPrompt('en', 'zh', glossary, true)
  assert.ok(on.includes('"translations"'))
  assert.ok(on.includes('DeepSeek -> 深度求索'))
  const off = buildSystemPrompt('en', 'zh', undefined, false)
  assert.ok(off.includes('[{"i":1,"t":'))
  assert.ok(!off.includes('translations'))
})

test('parseTranslationPayload handles arrays, objects, fences and variants', () => {
  assert.deepEqual(parseTranslationPayload('[{"i":1,"t":"a"}]', [1], false), [{ index: 1, text: 'a' }])
  assert.deepEqual(parseTranslationPayload('```json\n[{"i":2,"t":"b"}]\n```', [2], false), [{ index: 2, text: 'b' }])
  // Object form for jsonMode, tolerant of prose wrappers.
  assert.deepEqual(parseTranslationPayload('Sure! Here is: {"translations":[{"i":3,"t":"c"}]}', [3], true), [
    { index: 3, text: 'c' },
  ])
  // Variant keys.
  assert.deepEqual(parseTranslationPayload('[{"index":4,"text":"d"}]', [4], false), [{ index: 4, text: 'd' }])
})

test('parseTranslationPayload falls back to positional indexes when keys are absent', () => {
  assert.deepEqual(parseTranslationPayload('[{"t":"x"},{"t":"y"}]', [10, 20], false), [
    { index: 10, text: 'x' },
    { index: 20, text: 'y' },
  ])
})

test('parseTranslationPayload throws when there is no payload at all', () => {
  assert.throws(() => parseTranslationPayload('no json here', [1], false), /did not contain a JSON payload/)
})

test('translateCues produces aligned translations and reports missing cues', async () => {
  const stub = stubFetch([
    completionJson('[{"i":1,"t":"你好，世界。"}]'), // cue 2 deliberately omitted
  ])
  try {
    const client = oilClient({ jsonMode: false })
    const outcome = await translateCues(DOC.cues, {
      client,
      source: 'en',
      target: 'zh',
      jsonMode: false,
    })
    assert.equal(outcome.entries.length, 1)
    assert.equal(outcome.entries[0].index, 1)
    assert.equal(outcome.entries[0].text, '你好，世界。')
    assert.deepEqual(outcome.missing, [2])
    assert.equal(outcome.chunkCount, 1)
    // one request, body carries the cue payload
    const body = JSON.parse(stub.requests[0].init.body)
    assert.equal(body.messages[1].content, '[{"i":1,"t":"Hello world."},{"i":2,"t":"How are you?"}]')
  } finally {
    stub.restore()
  }
})

test('translateCues retries a malformed JSON payload with a corrective prompt', async () => {
  const stub = stubFetch([
    completionJson('This model rambled instead of emitting JSON.'),
    completionJson('[{"i":1,"t":"ok"},{"i":2,"t":"fine"}]'),
  ])
  try {
    const client = oilClient({ jsonMode: false })
    const outcome = await translateCues(DOC.cues, { client, source: 'en', target: 'zh', jsonMode: false })
    assert.equal(stub.requests.length, 2)
    assert.equal(outcome.entries.length, 2)
    assert.equal(outcome.missing.length, 0)
  } finally {
    stub.restore()
  }
})

test('translateDocument translates multiple target languages in sequence', async () => {
  const stub = stubFetch([
    completionJson('[{"i":1,"t":"bonjour"},{"i":2,"t":"ça va ?"}]'),
    completionJson('{"translations":[{"i":1,"t":"你好"},{"i":2,"t":"你好吗？"}]}'),
  ])
  try {
    const client = oilClient({ jsonMode: false })
    const outcomes = await translateDocument(DOC.cues, {
      client,
      source: 'en',
      targets: ['fr', 'zh'],
      jsonMode: false,
    })
    assert.equal(outcomes.length, 2)
    assert.equal(outcomes[0].target, 'fr')
    assert.equal(outcomes[0].entries.length, 2)
    assert.equal(outcomes[1].target, 'zh')
  } finally {
    stub.restore()
  }
})

test('onPartial hook receives progress after each chunk', async () => {
  const stub = stubFetch([
    completionJson('{"translations":[{"i":1,"t":"一"}]}'),
    completionJson('{"translations":[{"i":2,"t":"二"}]}'),
  ])
  try {
    // Force two chunks with a tiny character budget.
    const client = oilClient({ jsonMode: true })
    const partials = []
    await translateCues(DOC.cues, { client, source: 'en', target: 'zh', jsonMode: true, chunkChars: 12 }, {
      onPartial: (p) => partials.push(p),
    })
    assert.equal(partials.length, 2)
    assert.equal(partials[0].entries['2'], undefined)
    assert.equal(partials[1].entries['2'], '二')
  } finally {
    stub.restore()
  }
})

test('caller abort is terminal and never retried', async () => {
  const ac = new AbortController()
  ac.abort() // already aborted before the call
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  try {
    const client = oilClient({ jsonMode: false, maxRetries: 3 })
    await assert.rejects(
      () => client.complete([{ role: 'user', content: 'x' }], {}, ac.signal),
      (e) => e instanceof LlmError && e.code === 'aborted' && e.retryable === false,
    )
    // An already-aborted signal never reaches the network at all.
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('internal timeout is reported as timeout and bounded-retried', async () => {
  let calls = 0
  const original = globalThis.fetch
  // The mock honors the abort signal and throws right when the timer fires.
  globalThis.fetch = async (_url, init) => {
    calls++
    const signal = init && typeof init === 'object' ? init.signal : undefined
    if (signal) {
      await new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
    }
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  try {
    const client = oilClient({ jsonMode: false, timeoutMs: 40, maxRetries: 1 })
    await assert.rejects(
      () => client.complete([{ role: 'user', content: 'x' }], {}, undefined),
      (e) => e instanceof LlmError && e.code === 'timeout',
    )
    assert.ok(calls >= 2, 'the internal timeout should retry once (maxRetries=1)')
  } finally {
    globalThis.fetch = original
  }
})

test('translateCues stops immediately when the caller aborts', async () => {
  const ac = new AbortController()
  ac.abort()
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"translations":[]}',
    }
  }
  try {
    const client = oilClient({ jsonMode: false })
    const outcome = await translateCues(DOC.cues, { client, source: 'en', target: 'zh', jsonMode: false }, {}, ac.signal)
    assert.equal(calls, 0) // never attempted a request
    assert.deepEqual([...outcome.missing].sort(), [1, 2])
  } finally {
    globalThis.fetch = original
  }
})

test('items without a usable index are skipped, not misaligned', () => {
  // A trailing item with no index falls past the expected slice and must not
  // be coerced to cue 1.
  const items = parseTranslationPayload('[{"i":1,"t":"a"},{"t":"ghost"}]', [1], false)
  assert.deepEqual(items, [{ index: 1, text: 'a' }])
})

test('estimateTokens and ratesForModel behave sanely', () => {
  assert.ok(estimateTokens('hello world') > 0)
  // CJK text is denser per token than latin text.
  assert.ok(estimateTokens('你好世界') >= estimateTokens('abcd'))
  assert.ok(ratesForModel('deepseek-chat').inputPerMillion > 0)
  assert.deepEqual(ratesForModel('unknown-model'), ratesForModel('deepseek-chat'))
})

export {}
