import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSrt } from '../lib/core/srt.js'
import { mergeBilingual, mergeWithEntries } from '../lib/merge/merge.js'

function makeDoc() {
  return parseSrt(
    [
      '1',
      '00:00:01,000 --> 00:00:03,500',
      'Hello world.',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,000',
      'Second cue.',
      '',
    ].join('\n'),
  ).document
}

function entries() {
  return [
    { index: 1, text: '你好，世界。', source: 'Hello world.' },
    { index: 2, text: '第二条字幕。', source: 'Second cue.' },
  ]
}

test('stacked layout appends the translation below the original per cue', () => {
  const doc = makeDoc()
  const merged = mergeWithEntries(doc, 'en', 'zh', entries(), { layout: 'stacked' })
  assert.equal(merged.cues.length, 2)
  assert.equal(merged.cues[0].text, 'Hello world.\n你好，世界。')
  assert.equal(merged.cues[1].text, 'Second cue.\n第二条字幕。')
})

test('interleaved layout emits original and translation as sibling cues with identical timestamps', () => {
  const doc = makeDoc()
  const merged = mergeWithEntries(doc, 'en', 'zh', entries(), { layout: 'interleaved' })
  assert.equal(merged.cues.length, 4)
  assert.equal(merged.cues[0].text, 'Hello world.')
  assert.equal(merged.cues[1].text, '你好，世界。')
  // Exact timeline preservation.
  assert.equal(merged.cues[0].start, merged.cues[1].start)
  assert.equal(merged.cues[0].end, merged.cues[1].end)
  assert.equal(merged.cues[1].identifier, undefined)
})

test('timeline numbers are copied verbatim (millisecond fidelity)', () => {
  const doc = makeDoc()
  const merged = mergeWithEntries(doc, 'en', 'zh', entries(), { layout: 'stacked' })
  assert.deepEqual(
    [merged.cues[0].start, merged.cues[0].end, merged.cues[1].start, merged.cues[1].end],
    [1000, 3500, 4000, 6000],
  )
})

test('keeps untranslated cues by default; drops them when asked', () => {
  const doc = makeDoc()
  const partial = entries().slice(0, 1)
  const keep = mergeWithEntries(doc, 'en', 'zh', partial, { layout: 'stacked', keepUntranslated: true })
  assert.equal(keep.cues.length, 2)
  assert.equal(keep.cues[1].text, 'Second cue.') // original kept alone

  const drop = mergeWithEntries(doc, 'en', 'zh', partial, { layout: 'stacked', keepUntranslated: false })
  assert.equal(drop.cues.length, 1)
  assert.ok(drop.cues[0].text.includes('你好'))
})

test('supports empty-translation entries treated as untranslated', () => {
  const doc = makeDoc()
  const withEmpty = [
    { index: 1, text: '', source: 'Hello world.' },
    { index: 2, text: '第二条字幕。', source: 'Second cue.' },
  ]
  const merged = mergeWithEntries(doc, 'en', 'zh', withEmpty, { layout: 'stacked', keepUntranslated: true })
  assert.equal(merged.cues.length, 2)
  assert.equal(merged.cues[0].text, 'Hello world.')
  assert.equal(merged.cues[1].text, 'Second cue.\n第二条字幕。')
})

test('separator inserts a line between the source and translation blocks', () => {
  const doc = makeDoc()
  const merged = mergeWithEntries(doc, 'en', 'zh', entries(), { layout: 'stacked', separator: '---' })
  assert.equal(merged.cues[0].text, 'Hello world.\n---\n你好，世界。')
})

test('tagTarget prefixes every translated line', () => {
  const doc = makeDoc()
  const withMultiline = entries()
  withMultiline[0] = { index: 1, text: '你好\n世界', source: 'Hello world.' }
  const merged = mergeWithEntries(doc, 'en', 'zh', withMultiline, { layout: 'interleaved', tagTarget: '[zh] ' })
  assert.equal(merged.cues[1].text, '[zh] 你好\n[zh] 世界')
})

function resultFor(target, map) {
  return {
    target,
    source: 'en',
    entries: map,
    missing: [],
    extra: [],
    errors: [],
    chunkCount: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

test('mergeBilingual keeps every language (no silent drop)', () => {
  const doc = makeDoc()
  const zh = resultFor('zh', [
    { index: 1, text: '你好，世界。', source: 'Hello world.' },
    { index: 2, text: '第二条字幕。', source: 'Second cue.' },
  ])
  const fr = resultFor('fr', [
    { index: 1, text: 'bonjour le monde', source: 'Hello world.' },
    { index: 2, text: 'au revoir', source: 'Second cue.' },
  ])

  const stacked = mergeBilingual(doc, [zh, fr], { layout: 'stacked' })
  assert.equal(stacked.cues.length, 2)
  assert.ok(stacked.cues[0].text.includes('你好，世界。'))
  assert.ok(stacked.cues[0].text.includes('[fr] bonjour le monde'))

  const interleaved = mergeBilingual(doc, [zh, fr], { layout: 'interleaved' })
  // original + one cue per language, per source cue
  assert.equal(interleaved.cues.length, 6)
  assert.equal(interleaved.cues[1].text, '[zh] 你好，世界。')
  assert.equal(interleaved.cues[2].text, '[fr] bonjour le monde')
})

test('mergeBilingual with no results returns an unchanged copy', () => {
  const doc = makeDoc()
  const merged = mergeBilingual(doc, [], { layout: 'stacked' })
  assert.equal(merged.cues.length, 2)
})

export {}
