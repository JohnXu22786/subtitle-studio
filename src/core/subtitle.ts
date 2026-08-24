/**
 * Format detection, parse/stringify dispatch, and file-level helpers.
 */

import type { ParseResult, SubtitleDocument, SubtitleFormat } from './types.js'
import { parseSrt, writeSrt, srtFormat } from './srt.js'
import { parseVtt, writeVtt, vttFormat } from './vtt.js'
import { readTextFile, writeTextFile, stripBom } from './encoding.js'
import { extname } from 'node:path'

export interface ParseOptions {
  /** Explicit format hint. When omitted the format is sniffed from content. */
  format?: SubtitleFormat
}

/** Sniff the subtitle format from the first meaningful line. */
export function detectFormat(content: string): SubtitleFormat {
  const cleaned = stripBom(content).replace(/\r\n?/g, '\n')
  const first = (cleaned.split('\n').find((l) => l.trim() !== '') ?? '')
    .trim()
    .toLowerCase()
  if (first.startsWith('webvtt')) return vttFormat
  return srtFormat
}

/** Map a file extension to a format hint, if known. */
export function formatFromExtension(filename: string): SubtitleFormat | undefined {
  const ext = extname(filename).toLowerCase()
  if (ext === '.srt') return 'srt'
  if (ext === '.vtt') return 'vtt'
  return undefined
}

/** Parse subtitle text with optional format hint. Never throws. */
export function parseSubtitle(content: string, options: ParseOptions = {}): ParseResult {
  const format = options.format ?? detectFormat(content)
  return format === 'vtt' ? parseVtt(content) : parseSrt(content)
}

/** Serialize a document as text (format comes from the document). */
export function stringifySubtitle(document: SubtitleDocument): string {
  return document.format === 'vtt' ? writeVtt(document) : writeSrt(document)
}

/** Convert a document to a different format (timestamps/round-trip safe). */
export function convertSubtitle(document: SubtitleDocument, targetFormat: SubtitleFormat): SubtitleDocument {
  return { format: targetFormat, cues: document.cues, meta: document.meta }
}

export interface ReadSubtitleResult {
  result: ParseResult
  encoding: string
}

/** Read and parse a subtitle file. */
export function readSubtitleFile(filename: string, options: ParseOptions = {}): ReadSubtitleResult {
  const { text, encoding } = readTextFile(filename)
  const result = parseSubtitle(text, {
    format: options.format ?? formatFromExtension(filename),
  })
  return { result, encoding }
}

/** Write a document to a file as UTF-8. Parent directories are created. */
export function writeSubtitleFile(filename: string, document: SubtitleDocument, options: { bom?: boolean } = {}): void {
  writeTextFile(filename, stringifySubtitle(document), options)
}

export { srtFormat, vttFormat }