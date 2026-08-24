import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSubtitle,
  validateTranslationAlignment,
  summarizeIssues,
  formatIssues,
} from '../lib/validate/validate.js'
import { parseSrt } from '../lib/core/srt.js'

function doc(cuesText) {
  return parseSrt(cuesText).document
}

const SRT = (blocks) => blocks.join('\n\n') + '\n'

test('flags cues that end before they start', () => {
  const d = doc(SRT(['1\n00:00:02,000 --> 00:00:01,000\nBad']))
  const issues = validateSubtitle(d)
  assert.ok(issues.some((i) => i.code === 'invalid-timing' && i.severity === 'error'))
})

test('flags zero-duration cues as warnings', () => {
  const d = doc(SRT(['1\n00:00:01,000 --> 00:00:01,000\nZero']))
  assert.ok(validateSubtitle(d).some((i) => i.code === 'zero-duration'))
})

test('flags overlapping consecutive cues', () => {
  const d = doc(
    SRT([
      '1\n00:00:00,000 --> 00:00:02,000\nA',
      '2\n00:00:01,500 --> 00:00:03,000\nB',
    ]),
  )
  const issues = validateSubtitle(d)
  assert.ok(issues.some((i) => i.code === 'overlap' && i.cueIndex === 2))
  // Back-to-back cues are not an overlap.
  const backToBack = doc(SRT(['1\n00:00:00,000 --> 00:00:02,000\nA', '2\n00:00:02,000 --> 00:00:03,000\nB']))
  assert.ok(!validateSubtitle(backToBack).some((i) => i.code === 'overlap'))
})

test('duplicate indexes are warned about', () => {
  const d = doc(SRT(['1\n00:00:00,000 --> 00:00:01,000\nA', '1\n00:00:02,000 --> 00:00:03,000\nB']))
  assert.ok(validateSubtitle(d).some((i) => i.code === 'duplicate-index'))
})

test('detects translation count mismatch', () => {
  const d = doc(SRT(['1\n00:00:00,000 --> 00:00:01,000\nA', '2\n00:00:02,000 --> 00:00:03,000\nB']))
  const result = {
    target: 'zh',
    source: 'en',
    entries: [{ index: 1, text: '一', source: 'A' }],
    missing: [],
    extra: [],
    errors: [],
    chunkCount: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  const issues = validateTranslationAlignment(d, [result])
  assert.ok(issues.some((i) => i.code === 'count-mismatch' && i.severity === 'error'))
})

test('detects missing cues', () => {
  const d = doc(SRT(['1\n00:00:00,000 --> 00:00:01,000\nA', '2\n00:00:02,000 --> 00:00:03,000\nB']))
  const result = {
    target: 'zh',
    source: 'en',
    entries: [{ index: 1, text: '一', source: 'A' }],
    missing: [2],
    extra: [],
    errors: [],
    chunkCount: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  const issues = validateTranslationAlignment(d, [result])
  assert.ok(issues.some((i) => i.code === 'missing-cue' && i.cueIndex === 2))
})

test('detects extra cues that are not in the source', () => {
  const d = doc(SRT(['1\n00:00:00,000 --> 00:00:01,000\nA']))
  const result = {
    target: 'zh',
    source: 'en',
    entries: [
      { index: 1, text: '一', source: 'A' },
      { index: 99, text: 'ghost', source: '' },
    ],
    missing: [],
    extra: [99],
    errors: [],
    chunkCount: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  const issues = validateTranslationAlignment(d, [result])
  assert.ok(issues.some((i) => i.code === 'extra-cue' && i.cueIndex === 99))
})

test('flags overlong Latin cues by word count', () => {
  const words = Array.from({ length: 55 }, (_, i) => `word${i}`).join(' ')
  const d = doc(SRT(['1\n00:00:00,000 --> 00:00:04,000\n' + words]))
  const issues = validateTranslationAlignment(d, [], { maxWords: 40 })
  assert.ok(issues.some((i) => i.code === 'overlong' && /split/i.test(i.message)))
})

test('flags overlong CJK cues by character count', () => {
  const cjk = '字'.repeat(200)
  const d = doc(SRT(['1\n00:00:00,000 --> 00:00:08,000\n' + cjk]))
  const issues = validateTranslationAlignment(d, [], { maxChars: 160 })
  assert.ok(issues.some((i) => i.code === 'overlong'))
})

test('summarizeIssues counts and groups by code', () => {
  const d = doc(SRT(['1\n00:00:02,000 --> 00:00:01,000\nBad']))
  const issues = validateSubtitle(d)
  const summary = summarizeIssues(issues)
  assert.equal(summary.errors, 1)
  assert.ok(summary.byCode['invalid-timing'] === 1)
})

test('formatIssues renders readable lines', () => {
  const lines = formatIssues([{ severity: 'error', code: 'overlap', cueIndex: 2, message: 'boom' }])
  assert.ok(lines.includes('[error] boom'))
})

export {}
