import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import {
  detectFormat,
  formatFromExtension,
  parseSubtitle,
  stringifySubtitle,
  convertSubtitle,
  readSubtitleFile,
  writeSubtitleFile,
} from '../lib/core/subtitle.js'
import { parseSrt } from '../lib/core/srt.js'
import { makeTempDir, cleanupDir } from './helpers.js'

const SRT = '1\n00:00:01,000 --> 00:00:04,000\nHello world.\n'
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello world.\n'

test('detectFormat distinguishes srt and vtt', () => {
  assert.equal(detectFormat(SRT), 'srt')
  assert.equal(detectFormat(VTT), 'vtt')
  assert.equal(detectFormat('\uFEFFWEBVTT\n...'), 'vtt')
})

test('formatFromExtension maps known extensions', () => {
  assert.equal(formatFromExtension('a.srt'), 'srt')
  assert.equal(formatFromExtension('a.SRT'), 'srt')
  assert.equal(formatFromExtension('a.vtt'), 'vtt')
  assert.equal(formatFromExtension('a.txt'), undefined)
})

test('readSubtitleFile applies BOM detection and format detection, and reports encoding', () => {
  const dir = makeTempDir()
  try {
    const srtPath = `${dir}\\a.srt`
    writeFileSync(srtPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SRT, 'utf8')]))
    const srt = readSubtitleFile(srtPath)
    assert.equal(srt.encoding, 'utf8')
    assert.equal(srt.result.document.format, 'srt')
    assert.equal(srt.result.document.cues.length, 1)
    assert.equal(srt.result.document.cues[0].text, 'Hello world.')

    const vttPath = `${dir}\\a.vtt`
    writeFileSync(vttPath, VTT, 'utf8')
    const vtt = readSubtitleFile(vttPath)
    assert.equal(vtt.result.document.format, 'vtt')
    assert.equal(vtt.result.document.cues[0].end, 4000)
  } finally {
    cleanupDir(dir)
  }
})

test('writeSubtitleFile writes UTF-8 text readable by stringifySubtitle', () => {
  const dir = makeTempDir()
  try {
    const path = `${dir}\\out.srt`
    const doc = parseSrt(SRT).document
    writeSubtitleFile(path, doc)
    assert.equal(readFileSync(path, 'utf8'), stringifySubtitle(doc))
  } finally {
    cleanupDir(dir)
  }
})

test('convertSubtitle switches container format without touching the timeline', () => {
  const doc = parseSrt(SRT).document
  const vtt = convertSubtitle(doc, 'vtt')
  assert.equal(vtt.format, 'vtt')
  assert.equal(vtt.cues[0].start, 1000)
  assert.ok(stringifySubtitle(vtt).startsWith('WEBVTT'))
})

test('parseSubtitle with an explicit hint overrides sniffing', () => {
  // SRT content (no WEBVTT) parsed with an explicit srt hint.
  const result = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nHi\n', { format: 'srt' })
  assert.equal(result.document.format, 'srt')
  assert.equal(result.document.cues.length, 1)
  assert.equal(result.document.cues[0].text, 'Hi')
})

export {}
