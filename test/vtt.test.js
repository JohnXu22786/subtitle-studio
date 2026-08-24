import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVtt, writeVtt } from '../lib/core/vtt.js'
import { parseSubtitle, detectFormat } from '../lib/core/subtitle.js'

test('detects VTT by header', () => {
  assert.equal(detectFormat('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n'), 'vtt')
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), 'srt')
})

test('parses a cue with identifier, settings and multi-line text', () => {
  const src = [
    'WEBVTT',
    '',
    'cue1',
    '00:00:00.500 --> 00:00:03.000 align:start position:10%',
    'Hello',
    'world',
    '',
  ].join('\n')
  const { document, issues } = parseVtt(src)
  assert.equal(issues.filter((i) => i.kind === 'error').length, 0)
  assert.equal(document.cues.length, 1)
  const cue = document.cues[0]
  assert.equal(cue.index, 1)
  assert.equal(cue.start, 500)
  assert.equal(cue.end, 3000)
  assert.equal(cue.text, 'Hello\nworld')
  assert.equal(cue.identifier, 'cue1')
  assert.equal(cue.settings, 'align:start position:10%')
})

test('captures header metadata', () => {
  const { document } = parseVtt('WEBVTT - My File\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:01.000\nX\n')
  assert.equal(document.meta?.Kind, 'captions')
  assert.equal(document.meta?.Language, 'en')
  assert.equal(document.meta?.Title, 'My File')
})

test('skips NOTE, STYLE and REGION blocks', () => {
  const src = [
    'WEBVTT',
    '',
    'NOTE this is a comment',
    'with a second line',
    '',
    'STYLE',
    '::cue { color: yellow; }',
    '',
    '1',
    '00:00:00.000 --> 00:00:01.000',
    'Real cue',
    '',
  ].join('\n')
  const { document, issues } = parseVtt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].text, 'Real cue')
  assert.equal(issues.length, 0)
})

test('keeps a cue whose identifier starts with a reserved word', () => {
  const src = [
    'WEBVTT',
    '',
    'Region cue',
    '00:00:07.000 --> 00:00:09.000',
    'Nice text',
    '',
  ].join('\n')
  const { document } = parseVtt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].identifier, 'Region cue')
  assert.equal(document.cues[0].text, 'Nice text')
})

test('parses short MM:SS.mmm timestamps', () => {
  const { document } = parseVtt('WEBVTT\n\n01:30.000 --> 01:35.000\nShort\n')
  assert.equal(document.cues.length, 1)
  const cue = document.cues[0]
  assert.equal(cue.index, 1)
  assert.equal(cue.start, 90_000)
  assert.equal(cue.end, 95_000)
  assert.equal(cue.text, 'Short')
})

test('tolerates a missing WEBVTT header with a warning', () => {
  const { document, issues } = parseVtt('Kind: captions\n\n00:00:00.000 --> 00:00:01.000\nHi\n')
  assert.equal(document.cues.length, 1)
  assert.ok(issues.some((i) => i.kind === 'warning' && /WEBVTT header/i.test(i.message)))
})

test('writes VTT including identifiers and settings and round-trips', () => {
  const src = [
    'WEBVTT - Title',
    'Kind: captions',
    '',
    's1',
    '00:00:01.000 --> 00:00:02.000 align:end',
    'A',
    'B',
    '',
    '00:00:02.500 --> 00:00:03.000',
    'no id',
    '',
  ].join('\n')
  const { document } = parseVtt(src)
  const text = writeVtt(document)
  assert.ok(text.startsWith('WEBVTT - Title'))
  const re = parseVtt(text)
  assert.equal(re.document.cues.length, 2)
  assert.equal(re.document.cues[0].identifier, 's1')
  assert.equal(re.document.cues[0].settings, 'align:end')
  assert.equal(re.document.cues[0].text, 'A\nB')
  assert.equal(re.document.cues[0].start, 1000)
  assert.equal(re.document.cues[0].end, 2000)
})

test('preserves --> inside cue text', () => {
  const src = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\narrows: a --> b\n'
  const { document } = parseVtt(src)
  assert.equal(document.cues.length, 1)
  assert.equal(document.cues[0].text, 'arrows: a --> b')
})

export {}
