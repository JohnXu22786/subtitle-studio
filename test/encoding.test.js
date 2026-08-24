import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { detectBom, decodeBuffer, writeTextFile, readTextFile } from '../lib/core/encoding.js'
import { makeTempDir, cleanupDir, writeTestFile } from './helpers.js'

test('detects UTF-8 BOM', () => {
  assert.equal(detectBom(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf8')
})

test('detects UTF-16LE and UTF-16BE BOMs', () => {
  assert.equal(detectBom(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'utf16le')
  assert.equal(detectBom(Buffer.from([0xfe, 0xff, 0x00, 0x41])), 'utf16be')
})

test('returns null when no BOM is present', () => {
  assert.equal(detectBom(Buffer.from([0x41, 0x42])), null)
})

test('decodes UTF-16LE content, stripping the BOM', () => {
  const text = 'héllo 日本語'
  const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const { text: decoded, encoding } = decodeBuffer(encoded)
  assert.equal(decoded, text)
  assert.equal(encoding, 'utf16le')
})

test('decodes plain UTF-8', () => {
  const { text, encoding } = decodeBuffer(Buffer.from('plain utf8', 'utf8'))
  assert.equal(text, 'plain utf8')
  assert.equal(encoding, 'utf8')
})

test('truncated UTF-16 falls back to UTF-8 decoding', () => {
  // UTF-16LE BOM followed by a lone byte: fatal decode must fail and the
  // function must fall back to UTF-8 with replacement chars.
  const buffer = Buffer.from([0xff, 0xfe, 0x41])
  const { text, encoding } = decodeBuffer(buffer)
  assert.equal(encoding, 'utf8')
  assert.equal(text.endsWith('A'), true)
})

test('writes UTF-8 optionally with a BOM and reads it back', () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'unused.txt', '')
    writeTextFile(path, 'bommed \u4f60\u597d', { bom: true })
    const buffer = readFileSync(path)
    assert.equal(buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true)
    const { text } = readTextFile(path)
    assert.equal(text, 'bommed \u4f60\u597d')

    writeTextFile(path, 'no bom', { bom: false })
    assert.equal(Buffer.from('no bom', 'utf8').equals(readFileSync(path)), true)
  } finally {
    cleanupDir(dir)
  }
})

export {}
