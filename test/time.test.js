import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTimestampMs,
  formatTimestampMs,
  parseTimeRangeLine,
} from '../lib/core/time.js'

test('parses full timestamps with comma fractions', () => {
  assert.equal(parseTimestampMs('00:00:01,000'), 1000)
  assert.equal(parseTimestampMs('01:02:03,456'), 3600_000 + 2 * 60_000 + 3456)
})

test('parses dot fractions (VTT)', () => {
  assert.equal(parseTimestampMs('00:00:01.500'), 1500)
  assert.equal(parseTimestampMs('00:01:00.000'), 60_000)
})

test('parses abbreviated fractions (tolerant)', () => {
  // .5 -> 500ms, ,12 -> 120ms
  assert.equal(parseTimestampMs('00:00:00.5'), 500)
  assert.equal(parseTimestampMs('00:00:00,12'), 120)
})

test('parses short MM:SS form (VTT)', () => {
  assert.equal(parseTimestampMs('01:30.000'), 90_000)
  assert.equal(parseTimestampMs('02:05'), 125_000)
})

test('parses seconds without fraction', () => {
  assert.equal(parseTimestampMs('00:00:05'), 5000)
})

test('supports large hour values', () => {
  assert.equal(parseTimestampMs('101:59:59,999'), 101 * 3600_000 + 59 * 60_000 + 59_999)
})

test('returns null for invalid timestamps', () => {
  assert.equal(parseTimestampMs(''), null)
  assert.equal(parseTimestampMs('00:00:00,000 garbage'), null)
  assert.equal(parseTimestampMs('nope'), null)
  assert.equal(parseTimestampMs('0:00:0'), null) // two digit seconds required
  assert.equal(parseTimestampMs('00:00:0'), null) // two digit seconds required
})

test('formats SRT and VTT correctly and round-trips', () => {
  for (const ms of [0, 1, 999, 1000, 61_234, 3600_000, 3723_004]) {
    assert.equal(parseTimestampMs(formatTimestampMs(ms, 'srt')), ms)
    assert.equal(parseTimestampMs(formatTimestampMs(ms, 'vtt')), ms)
  }
  assert.equal(formatTimestampMs(1234, 'srt'), '00:00:01,234')
  assert.equal(formatTimestampMs(1234, 'vtt'), '00:00:01.234')
})

test('formats negative input as zero', () => {
  assert.equal(formatTimestampMs(-5, 'srt'), '00:00:00,000')
})

test('parses a timeline line with settings', () => {
  const range = parseTimeRangeLine('00:00:01.000 --> 00:00:04.000 align:start position:10%')
  assert.deepEqual(range, { start: 1000, end: 4000, settings: 'align:start position:10%' })
})

test('parses a timeline line without spaces around the arrow', () => {
  const range = parseTimeRangeLine('00:00:01,000-->00:00:04,000')
  assert.deepEqual(range, { start: 1000, end: 4000, settings: undefined })
})

test('returns null for non-timeline lines', () => {
  assert.equal(parseTimeRangeLine('no arrow here'), null)
  assert.equal(parseTimeRangeLine('00:00:01,000x00:00:04,000'), null)
})

export {}
