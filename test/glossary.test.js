import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGlossaryText,
  createGlossary,
  upsertEntry,
  removeEntries,
  mergeGlossaries,
  entriesForTarget,
  matchingEntries,
  buildGlossaryPrompt,
  loadGlossaryFile,
  saveGlossaryFile,
  verifyGlossaryUsage,
  GlossaryError,
} from '../lib/translate/glossary.js'
import { makeTempDir, cleanupDir, writeTestFile } from './helpers.js'

test('parses and validates a glossary document', () => {
  const glossary = parseGlossaryText(
    JSON.stringify({
      name: 'my-glossary',
      entries: [
        { source: 'Hello', target: '你好', scope: 'zh' },
        { source: 'world', target: '世界' },
      ],
    }),
  )
  assert.equal(glossary.name, 'my-glossary')
  assert.equal(glossary.entries.length, 2)
})

test('accepts a bare array form', () => {
  const glossary = parseGlossaryText('[{"source":"a","target":"b"}]')
  assert.equal(glossary.entries.length, 1)
  assert.equal(glossary.entries[0].source, 'a')
})

test('rejects invalid JSON with a clear error', () => {
  assert.throws(() => parseGlossaryText('{oops'), GlossaryError)
})

test('rejects entries missing source or target', () => {
  assert.throws(() => parseGlossaryText(JSON.stringify({ entries: [{ source: 'only' }] })), GlossaryError)
  assert.throws(() => parseGlossaryText(JSON.stringify({ entries: [{}] })), GlossaryError)
})

test('deduplicates entries sharing source+target+scope', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'a', target: 'b' })
  glossary = upsertEntry(glossary, { source: 'a', target: 'b' })
  assert.equal(glossary.entries.length, 1)
})

test('upsert is keyed by source+target+scope and refreshes metadata', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'a', target: 'b', note: 'v1' })
  // Same key → replaces in place.
  glossary = upsertEntry(glossary, { source: 'a', target: 'b', note: 'v2' })
  assert.equal(glossary.entries.length, 1)
  assert.equal(glossary.entries[0].note, 'v2')
  // Different target or scope → distinct entry.
  glossary = upsertEntry(glossary, { source: 'a', target: 'c' })
  assert.equal(glossary.entries.length, 2)
})

test('removeEntries matches source (required) plus optional target/scope', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'a', target: 'b', scope: 'zh' })
  glossary = upsertEntry(glossary, { source: 'a', target: 'c' })
  assert.equal(removeEntries(glossary, 'A'), 2) // case-insensitive source, any target

  let g2 = createGlossary()
  g2 = upsertEntry(g2, { source: 'a', target: 'zh-b' })
  g2 = upsertEntry(g2, { source: 'a', target: 'fr-c' })
  // Functional API: reports a count and never mutates its input.
  assert.equal(removeEntries(g2, 'a', 'zh-b'), 1)
  assert.equal(removeEntries(g2, 'a', 'fr-c'), 1)
  assert.equal(removeEntries(g2, 'a'), 2)
  assert.equal(g2.entries.length, 2)
})

test('mergeGlossaries combines entries; same key later wins', () => {
  let a = createGlossary('a')
  a = upsertEntry(a, { source: 'x', target: 'one' })
  a = upsertEntry(a, { source: 'z', target: 'zeal' })
  let b = createGlossary('b')
  b = upsertEntry(b, { source: 'x', target: 'one', note: 'updated' })
  b = upsertEntry(b, { source: 'y', target: 'yes' })
  const merged = mergeGlossaries([a, b])
  assert.equal(merged.entries.length, 3)
  const x = merged.entries.find((e) => e.source === 'x')
  assert.equal(x?.note, 'updated') // later glossary refreshed the same key
  assert.ok(merged.entries.some((e) => e.source === 'y'))
  assert.ok(merged.entries.some((e) => e.source === 'z'))
})

test('entriesForTarget filters by scope', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'a', target: 'generic' })
  glossary = upsertEntry(glossary, { source: 'b', target: 'zh-one', scope: 'zh' })
  glossary = upsertEntry(glossary, { source: 'c', target: 'fr-one', scope: 'fr' })
  assert.equal(entriesForTarget(glossary, 'zh').length, 2)
  assert.equal(entriesForTarget(glossary, 'fr').length, 2)
  assert.ok(!entriesForTarget(glossary, 'zh').map((e) => e.source).includes('c'))
  assert.equal(entriesForTarget(glossary, 'de').length, 1) // only unscoped
})

test('matchingEntries finds terms present in text, longest first', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'DeepSeek', target: 'DS' })
  glossary = upsertEntry(glossary, { source: 'DeepSeek Harness', target: '工具链' })
  const matches = matchingEntries(glossary, 'DeepSeek Harness rocks', 'en')
  assert.equal(matches.length, 2)
  assert.equal(matches[0].source, 'DeepSeek Harness') // longest first
})

test('buildGlossaryPrompt renders a scoped instruction block', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'door', target: '门', scope: 'zh' })
  glossary = upsertEntry(glossary, { source: 'door', target: 'porte', scope: 'fr' })
  const zhPrompt = buildGlossaryPrompt(glossary, 'zh')
  const frPrompt = buildGlossaryPrompt(glossary, 'fr')
  assert.ok(zhPrompt.includes('door -> 门'))
  assert.ok(!zhPrompt.includes('porte'))
  assert.ok(frPrompt.includes('door -> porte'))
})

test('verifyGlossaryUsage reports which translated terms appear', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, { source: 'door', target: '门', scope: 'zh' })
  glossary = upsertEntry(glossary, { source: 'window', target: '窗', scope: 'zh' })
  const reports = verifyGlossaryUsage(glossary, 'zh', [{ text: '打开那扇门' }])
  assert.equal(reports.length, 1)
  assert.equal(reports[0].entry.source, 'door')
  assert.equal(reports[0].occurrences, 1)
})

test('buildGlossaryPrompt scrubs newlines to prevent instruction injection', () => {
  let glossary = createGlossary()
  glossary = upsertEntry(glossary, {
    source: 'door',
    target: '门',
    note: 'ignore\nthis injection',
  })
  const prompt = buildGlossaryPrompt(glossary, 'zh')
  assert.ok(!prompt.includes('\nthis injection'))
  assert.ok(prompt.includes('ignore this injection'))
})

test('verifyGlossaryUsage tolerates empty targets without looping', () => {
  const bare = { name: 'x', entries: [{ source: 'a', target: '' }], updatedAt: '' }
  const reports = verifyGlossaryUsage(bare, 'zh', [{ text: 'anything' }])
  assert.deepEqual(reports, [])
})

test('persists and reloads a glossary from disk', () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'g.json', '')
    let glossary = createGlossary('disk')
    glossary = upsertEntry(glossary, { source: 'one', target: '一' })
    saveGlossaryFile(path, glossary)
    const reloaded = loadGlossaryFile(path)
    assert.equal(reloaded.name, 'disk')
    assert.equal(reloaded.entries.length, 1)
    assert.equal(reloaded.entries[0].target, '一')
  } finally {
    cleanupDir(dir)
  }
})

export {}
