/**
 * WebVTT parser and writer.
 *
 * Tolerant in the same spirit as the SRT parser: a missing `WEBVTT` header is
 * not fatal, `NOTE`/`STYLE`/`REGION` blocks are skipped, optional cue
 * identifiers are captured, and cue settings are kept verbatim so that a
 * round-trip does not lose information.
 */

import type { ParseIssue, ParseResult, SubtitleCue, SubtitleDocument, SubtitleFormat } from './types.js'
import { parseTimeRangeLine, formatTimestampMs } from './time.js'
import { stripBom } from './encoding.js'

interface PendingCue {
  identifier?: string
  start?: number
  end?: number
  settings?: string
  text: string[]
}

function hasArrow(line: string): boolean {
  return line.includes('-->')
}

function isCueIdentifier(line: string): boolean {
  // Valid identifiers: any line that is not a timecode line, does not contain
  // "-->" and is not settings-like (`x:y`).
  return !hasArrow(line) && !/^\s*[a-z]+:/i.test(line)
}

/** Skip the current block of lines until the next blank line. */
function skipBlock(lines: string[], i: number): number {
  while (i < lines.length && (lines[i] ?? '').trim() !== '') i++
  return i
}

/** True when a line starts a reserved non-cue block.
 * NOTE comments may carry trailing text; STYLE/REGION starts must be the bare
 * keyword (or, for REGION, the keyword followed by `key=value` settings). This
 * keeps valid cue identifiers such as "Region cue" from being swallowed. */
function isReservedBlock(line: string): boolean {
  const trimmed = line.trim()
  if (/^NOTE(?:\s+|$)/i.test(trimmed)) return true
  if (/^STYLE(?:\s*$)/i.test(trimmed)) return true
  return trimmed === 'REGION' || /^REGION\s+\S+=/i.test(trimmed)
}

/**
 * Parse WebVTT text content.
 *
 * @param content raw text of a `.vtt` file
 */
export function parseVtt(content: string): ParseResult {
  const issues: ParseIssue[] = []
  const cues: SubtitleCue[] = []
  const normalized = stripBom(content).replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  if (lines.length === 0 || (lines[0] ?? '').trim() === '') {
    return { document: { format: 'vtt', cues }, issues: [{ kind: 'error', line: 1, message: 'file is empty' }] }
  }

  const header = (lines[0] ?? '').trim()
  if (!/^WEBVTT\b/i.test(header)) {
    issues.push({ kind: 'warning', line: 1, message: 'missing WEBVTT header; parsing as WebVTT anyway' })
  }

  const meta: Record<string, string> = {}
  // Text following "WEBVTT" on the header line is the file title; the common
  // "WEBVTT - Title" convention writes it after a dash separator, which we
  // strip so the writer can reproduce the canonical form.
  const headerTitle = header.replace(/^WEBVTT\b/, '').trim().replace(/^-\s*/, '')
  if (headerTitle) meta['Title'] = headerTitle

  let i = 1
  // Header metadata block runs until the first blank line.
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line === '') {
      i++
      break
    }
    const col = line.indexOf(':')
    if (col > 0) {
      const key = line.slice(0, col).trim()
      const value = line.slice(col + 1).trim()
      meta[key] = value
    }
  }

  const finalize = (line: number): void => {
    const p = pending
    if (!p) return
    if (p.start === undefined || p.end === undefined) {
      issues.push({ kind: 'error', line, message: 'cue is missing a valid timecode line; dropped' })
      pending = undefined
      return
    }
    const text = p.text.join('\n')
    if (text.length === 0 && p.identifier === undefined) {
      issues.push({ kind: 'warning', line, message: 'cue has empty text' })
    }
    cues.push({
      index: cues.length + 1,
      start: p.start,
      end: p.end,
      text,
      identifier: p.identifier,
      settings: p.settings,
    })
    pending = undefined
  }

  let pending: PendingCue | undefined

  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const trimmed = line.trim()

    if (trimmed === '') {
      if (pending) finalize(i + 1)
      i++
      continue
    }

    // Comment / style / region blocks are skipped whole.
    if (isReservedBlock(trimmed)) {
      i = skipBlock(lines, i)
      continue
    }

    if (!pending) {
      if (hasArrow(trimmed)) {
        const range = parseTimeRangeLine(trimmed)
        if (!range) {
          issues.push({ kind: 'error', line: i + 1, message: 'cannot parse timecode line, skipping' })
          i = skipBlock(lines, i)
          continue
        }
        pending = { start: range.start, end: range.end, settings: range.settings, text: [] }
        i++
        continue
      }
      // Could be a cue identifier or unknown block.
      const next = (lines[i + 1] ?? '').trim()
      if (isCueIdentifier(trimmed) && hasArrow(next)) {
        pending = { identifier: trimmed, text: [] }
        i++
        continue
      }
      issues.push({ kind: 'warning', line: i + 1, message: 'unknown block, skipping' })
      i = skipBlock(lines, i)
      continue
    }

    // Pending cue: expect its timecode line next.
    if (pending.start === undefined) {
      if (hasArrow(trimmed)) {
        const range = parseTimeRangeLine(trimmed)
        if (!range) {
          issues.push({ kind: 'error', line: i + 1, message: 'cannot parse timecode line, dropping cue' })
          pending = undefined
          i = skipBlock(lines, i)
          continue
        }
        pending.start = range.start
        pending.end = range.end
        pending.settings = range.settings
        i++
        continue
      }
      issues.push({ kind: 'error', line: i + 1, message: 'missing timecode line, dropping cue' })
      pending = undefined
      i = skipBlock(lines, i)
      continue
    }

    // Accumulating text.
    if (hasArrow(trimmed)) {
      // A new cue starts here only if the interval actually parses; a
      // "see --> that" text line must survive as ordinary text.
      const range = parseTimeRangeLine(trimmed)
      if (range) {
        finalize(i + 1)
        pending = { start: range.start, end: range.end, settings: range.settings, text: [] }
        i++
        continue
      }
    }
    pending.text.push(line)
    i++
  }

  if (pending) finalize(lines.length)

  const document: SubtitleDocument = { format: 'vtt', cues, meta }
  return { document, issues }
}

/**
 * Serialize a document as WebVTT text.
 * The standard `WEBVTT` header is always emitted; cue identifiers and settings
 * are re-emitted when the source carried them.
 */
export function writeVtt(document: SubtitleDocument): string {
  const blocks: string[] = []
  const metaEntries = document.meta
    ? Object.entries(document.meta).filter(([key]) => !/^Title$/i.test(key))
    : []
  const title = document.meta?.['Title']?.trim()
  const header = title ? `WEBVTT - ${title}` : 'WEBVTT'
  const headerLines = [header]
  for (const [key, value] of metaEntries) {
    headerLines.push(`${key}: ${value}`)
  }
  blocks.push(headerLines.join('\n'))

  for (const cue of document.cues) {
    const time = `${formatTimestampMs(cue.start, 'vtt')} --> ${formatTimestampMs(cue.end, 'vtt')}`
    const settings = cue.settings ? ` ${cue.settings}` : ''
    const lines: string[] = []
    if (cue.identifier) lines.push(cue.identifier)
    lines.push(`${time}${settings}`)
    lines.push(cue.text)
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n') + '\n'
}

export const vttFormat: SubtitleFormat = 'vtt'