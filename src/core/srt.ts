/**
 * SubRip (SRT) parser and writer.
 *
 * The parser is a small state machine (index → timecode → text). It is
 * deliberately tolerant so that hand-edited or export-mangled files still
 * yield a useful document:
 * - accepts missing sequence numbers and keeps counting by itself;
 * - accepts missing blank separators between cues;
 * - skips (and reports) junk lines and malformed timecode lines;
 * - keeps multi-line cue text as-is.
 *
 * All failures degrade into ParseIssue diagnostics; the parser never throws.
 */

import type { ParseIssue, ParseResult, SubtitleCue, SubtitleDocument, SubtitleFormat } from './types.js'
import { parseTimeRangeLine, formatTimestampMs } from './time.js'
import { stripBom } from './encoding.js'

interface PendingCue {
  index?: number
  start?: number
  end?: number
  settings?: string
  text: string[]
}

function isNumeric(line: string): boolean {
  return /^\d+$/.test(line)
}

function hasArrow(line: string): boolean {
  return line.includes('-->')
}

/**
 * Parse SRT text content.
 *
 * @param content raw text of a `.srt` file
 * @returns parsed document plus all diagnostics
 */
export function parseSrt(content: string): ParseResult {
  const issues: ParseIssue[] = []
  const cues: SubtitleCue[] = []
  const normalized = stripBom(content).replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  let pending: PendingCue | null = null

  const atLine = (i: number): number => i + 1

  const finalize = (line: number): void => {
    if (!pending) return
    if (pending.start === undefined || pending.end === undefined) {
      issues.push({ kind: 'error', line, message: 'cue is missing a valid timecode line; dropped' })
    } else {
      const text = pending.text.join('\n')
      if (text.length === 0) {
        issues.push({ kind: 'warning', line, message: `cue ${pending.index ?? cues.length + 1} has empty text` })
      }
      cues.push({
        index: pending.index ?? cues.length + 1,
        start: pending.start,
        end: pending.end,
        text,
        settings: pending.settings,
      })
    }
    pending = null
  }

  const startNewCue = (index: number | undefined, line: number): void => {
    pending = { index, text: [] }
    void line
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const trimmed = line.trim()

    if (trimmed === '') {
      if (pending) finalize(atLine(i))
      continue
    }

    if (!pending) {
      if (isNumeric(trimmed)) {
        startNewCue(Number(trimmed), atLine(i))
        continue
      }
      if (hasArrow(trimmed)) {
        issues.push({ kind: 'warning', line: atLine(i), message: 'timecode line without a sequence number; numbering is implicit' })
        const range = parseTimeRangeLine(trimmed)
        if (!range) {
          issues.push({ kind: 'error', line: atLine(i), message: 'cannot parse timecode line, skipping' })
          continue
        }
        pending = { index: cues.length + 1, start: range.start, end: range.end, settings: range.settings, text: [] }
        continue
      }
      issues.push({ kind: 'warning', line: atLine(i), message: 'unexpected line while expecting a sequence number; skipped' })
      continue
    }

    // We have a pending cue; it still needs its timecode line.
    if (pending.start === undefined) {
      if (hasArrow(trimmed)) {
        const range = parseTimeRangeLine(trimmed)
        if (!range) {
          issues.push({ kind: 'error', line: atLine(i), message: 'cannot parse timecode line, dropping cue' })
          pending = null
          continue
        }
        pending.start = range.start
        pending.end = range.end
        pending.settings = range.settings
        continue
      }
      // The block never produced a timecode line — drop it and reprocess.
      issues.push({ kind: 'error', line: atLine(i), message: 'missing timecode line, dropping cue' })
      pending = null
      i--
      continue
    }

    // Text accumulation phase.
    const nextLine = (lines[i + 1] ?? '').trim()
    // A bare number only starts a new cue when it is actually a sequence
    // number (i.e. followed by a timecode line) — otherwise it is ordinary
    // text (e.g. a cue that reads "5").
    if (isNumeric(trimmed) && hasArrow(nextLine)) {
      if (pending.text.length > 0) {
        issues.push({ kind: 'warning', line: atLine(i), message: 'cue is not followed by a blank line' })
      }
      finalize(atLine(i))
      startNewCue(Number(trimmed), atLine(i))
      continue
    }
    // A "-->" line starts a new cue only when the interval actually parses;
    // otherwise it is text (e.g. "see --> that").
    if (hasArrow(trimmed)) {
      const range = parseTimeRangeLine(trimmed)
      if (range) {
        if (pending.text.length > 0) {
          issues.push({ kind: 'warning', line: atLine(i), message: 'cue is not followed by a blank line' })
        }
        finalize(atLine(i))
        pending = { index: cues.length + 1, start: range.start, end: range.end, settings: range.settings, text: [] }
        continue
      }
    }

    pending.text.push(line)
  }

  if (pending) finalize(lines.length)

  const document: SubtitleDocument = { format: 'srt', cues }
  return { document, issues }
}

/**
 * Serialize a document as SRT text. Timestamps are exact millisecond values —
 * the same numbers that were parsed — so round-trips preserve the timeline.
 */
export function writeSrt(document: SubtitleDocument): string {
  const blocks: string[] = []
  for (const cue of document.cues) {
    const index = cue.index >= 0 ? cue.index : document.cues.indexOf(cue) + 1
    const time = `${formatTimestampMs(cue.start, 'srt')} --> ${formatTimestampMs(cue.end, 'srt')}`
    const settings = cue.settings ? ` ${cue.settings}` : ''
    blocks.push(`${index}\n${time}${settings}\n${cue.text}`)
  }
  return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '')
}

export const srtFormat: SubtitleFormat = 'srt'