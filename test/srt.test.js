import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSrt, writeSrt } from '../lib/core/srt.js'
import { parseSubtitle } from '../lib/core/subtitle.js'

test('parses a clean SRT with multi-line text', () => {
  const src = [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    'Hello world.',
    'Second line.',
    '',
    '2',
    '00:00:04,500 --> 00:00:08,000',
    'Next cue.',
    '',
  ].join('\n')
  const { document, issues } = parseSrt(src)
  assert.equal(document.format, 'srt')
  assert.equal(issues.filter((i) => i.kind === 'error').length, 0)
  assert.equal(document.cues.length, 2)
  const [c1, c2] = document.cues
  assert.equal(c1.index, 1)
  assert.equal(c1.start, 1000)
  assert.equal(c1.end, 4000)
  assert.equal(c1.text, 'Hello world.\nSecond line.')
  assert.equal(c1.settings, undefined)
  assert.equal(c2.index, 2)
  assert.equal(c2.start, 4500)
  assert.equal(c2.end, 8000)
  assert.equal(c2.text, 'Next cue.')
})

test('tolerates a missing sequence number on a timecode-only cue', () => {
  const src = ['00:00:01,000 --> 00:00:04,000', 'Auto numbered.'].join('\n')
  const { document, issues } = parseSrt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].index, 1)
  assert.ok(issues.some((i) => i.kind === 'warning' && /sequence number/i.test(i.message)))
})

test('tolerates missing blank separators between cues', () => {
  const src = [
    '1',
    '00:00:01,000 --> 00:00:02,000',
    'One',
    '2',
    '00:00:02,000 --> 00:00:03,000',
    'Two',
  ].join('\n')
  const { document } = parseSrt(src)
  assert.equal(document.cues.length, 2)
  assert.equal(document.cues[0].text, 'One')
  assert.equal(document.cues[1].text, 'Two')
})

test('drops a cue with an invalid timecode line and reports an error', () => {
  const src = ['1', 'not a timecode', 'Broken', '', '2', '00:00:01,000 --> 00:00:02,000', 'Fine'].join('\n')
  const { document, issues } = parseSrt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].text, 'Fine')
  assert.ok(issues.some((i) => i.kind === 'error' && /timecode/i.test(i.message)))
})

test('skips junk lines outside any cue with a warning', () => {
  const src = ['garbage line', '1', '00:00:01,000 --> 00:00:02,000', 'Ok'].join('\n')
  const { document, issues } = parseSrt(src)
  assert.equal(document.cues.length, 1)
  assert.ok(issues.some((i) => i.kind === 'warning' && /unexpected line/i.test(i.message)))
})

test('handles CRLF and a BOM prefix', () => {
  const src = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nBye\r\n'
  const { document, issues } = parseSrt(src)
  assert.equal(document.cues.length, 2)
  assert.equal(document.cues[0].text, 'Hi')
  assert.equal(issues.length, 0)
})

test('normalizes consecutive blank lines without dropping cues', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\nA\n\n\n2\n00:00:02,000 --> 00:00:03,000\nB\n'
  const { document } = parseSrt(src)
  assert.equal(document.cues.length, 2)
})

test('writes SRT and round-trips through the parser', () => {
  // Cues in the document keep their original file order (3 first, then 1).
  const doc = parseSrt('3\n00:00:02,000 --> 00:00:05,250\nHello\nWorld\n\n1\n00:00:00,000 --> 00:00:01,000\nIntro\n').document
  const text = writeSrt(doc)
  const re = parseSrt(text)
  assert.equal(re.document.cues.length, 2)
  assert.equal(re.document.cues[0].index, 3)
  assert.equal(re.document.cues[0].text, 'Hello\nWorld')
  assert.equal(re.document.cues[1].index, 1)
  assert.equal(re.document.cues[1].text, 'Intro')
  // Timeline preserved to the millisecond.
  assert.equal(re.document.cues[0].end, 5250)
  assert.equal(re.document.cues[1].start, 0)
})

test('reports empty-text cues as warnings', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n\n' + '2\n00:00:02,000 --> 00:00:03,000\nX\n'
  const { document, issues } = parseSrt(src)
  assert.equal(document.cues.length, 2)
  assert.ok(issues.some((i) => i.kind === 'warning' && /empty text/.test(i.message)))
})

test('preserves numeric text lines inside a cue', () => {
  const src = '1\n00:00:01,000 --> 00:00:04,000\nHello\n5\nworld\n'
  const { document } = parseSrt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].text, 'Hello\n5\nworld')
})

test('preserves --> text inside a cue', () => {
  const src = '1\n00:00:01,000 --> 00:00:04,000\nGo from A --> B now\n'
  const { document } = parseSrt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].text, 'Go from A --> B now')
})

export {}
