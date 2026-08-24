/**
 * Text file reading/writing with BOM detection and UTF-8 output.
 *
 * Reading: detects UTF-8 / UTF-16LE / UTF-16BE byte-order marks and decodes
 * accordingly; BOM-less input is decoded as UTF-8. Writing always produces
 * UTF-8 (optionally with a BOM).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

export type BomKind = 'utf8' | 'utf16le' | 'utf16be' | null

/** Detect the byte-order mark of a buffer. */
export function detectBom(buffer: Buffer): BomKind {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) return 'utf8'
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16LE_BOM)) return 'utf16le'
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16BE_BOM)) return 'utf16be'
  return null
}

/**
 * Decode a buffer using its BOM. When a declared BOM encoding turns out to be
 * invalid (e.g. a truncated UTF-16 file), falls back to UTF-8 decoding.
 */
export function decodeBuffer(buffer: Buffer): { text: string; encoding: string } {
  const bom = detectBom(buffer)
  const label = bom === 'utf16le' ? 'utf-16le' : bom === 'utf16be' ? 'utf-16be' : 'utf-8'
  const offset = bom === 'utf8' ? 3 : bom ? 2 : 0
  try {
    // fatal: true makes a malformed stream throw, so the fallback is real.
    return { text: new TextDecoder(label, { fatal: true }).decode(buffer.subarray(offset)), encoding: bom ?? 'utf8' }
  } catch {
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf8' }
  }
}

/** Read a text file applying BOM detection. */
export function readTextFile(path: string): { text: string; encoding: string } {
  const buffer = readFileSync(path)
  return decodeBuffer(buffer)
}

export interface WriteTextOptions {
  bom?: boolean
}

/** Write text as UTF-8 (optionally with a BOM). Creates parent directories. */
export function writeTextFile(path: string, text: string, options: WriteTextOptions = {}): void {
  const parent = dirname(path)
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true })
  const buffer = Buffer.from(text, 'utf8')
  writeFileSync(path, options.bom ? Buffer.concat([UTF8_BOM, buffer]) : buffer)
}

/** Strip a leading U+FEFF character, if any. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}