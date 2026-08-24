/**
 * Timestamp parsing and formatting.
 *
 * Timeline representation: integer milliseconds from the start of media.
 * Parsing is deliberately tolerant — it accepts every seconds-fraction
 * separator variant seen in the wild (`,` or `.`, 0–3 fraction digits,
 * optional hours, and both `HH:MM:SS` and `MM:SS` forms).
 */

import type { SubtitleFormat } from './types.js'

const TIME_LINE_RE = /^(\d{1,3}):(\d{1,2}):(\d{2})(?:([.,])(\d{1,3}))?$/
const TIME_SHORT_RE = /^(\d{1,3}):(\d{2})(?:([.,])(\d{1,3}))?$/

/**
 * Parse a timestamp into milliseconds.
 *
 * Accepts:
 * - `HH:MM:SS,mmm` / `HH:MM:SS.mmm` (3-digit fraction — SRT/VTT standard)
 * - `H:MM:SS,m` and any 1–3 digit fraction (tolerated)
 * - `MM:SS(.mmm)` (WebVTT short form, no hours)
 *
 * @returns milliseconds, or `null` when the string is not a timestamp.
 */
export function parseTimestampMs(value: string): number | null {
  const trimmed = value.trim()
  const longMatch = TIME_LINE_RE.exec(trimmed)
  const shortMatch = longMatch ? null : TIME_SHORT_RE.exec(trimmed)
  let hours: number
  let minutes: number
  let seconds: number
  let fracSep: string | undefined
  let fracGroup: string | undefined

  if (longMatch) {
    hours = Number(longMatch[1])
    minutes = Number(longMatch[2])
    seconds = Number(longMatch[3])
    fracSep = longMatch[4]
    fracGroup = longMatch[5]
  } else if (shortMatch) {
    hours = 0
    minutes = Number(shortMatch[1])
    seconds = Number(shortMatch[2])
    fracSep = shortMatch[3]
    fracGroup = shortMatch[4]
  } else {
    return null
  }

  let millis = 0
  if (fracSep !== undefined && fracGroup !== undefined) {
    // Treat the fraction as decimal-expanded to 3 digits: `.5` → 500ms.
    const digits = fracGroup.length
    const scale = digits === 1 ? 100 : digits === 2 ? 10 : 1
    millis = Number(fracGroup) * scale
  }

  if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return null
  return hours * 3600_000 + minutes * 60_000 + seconds * 1000 + millis
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** Format a millisecond offset as `HH:MM:SS,mmm` (SRT) or `...` `.mmm` (VTT). */
export function formatTimestampMs(ms: number, format: SubtitleFormat): string {
  let rest = Math.max(0, Math.floor(ms))
  const hours = Math.floor(rest / 3600_000)
  rest %= 3600_000
  const minutes = Math.floor(rest / 60_000)
  rest %= 60_000
  const seconds = Math.floor(rest / 1000)
  const millis = rest % 1000
  const sep = format === 'srt' ? ',' : '.'
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${sep}${pad(millis, 3)}`
}

export interface TimeRange {
  start: number
  end: number
  /** Raw trailing cue settings (VTT position/align or SRT coordinates). */
  settings?: string
}

const ARROW = '-->'

/**
 * Parse a timeline line: `<start> --> <end> [settings...]`.
 * Lenient about whitespace around the arrow so that even `a-->b`-style
 * malformed lines are accepted.
 */
export function parseTimeRangeLine(line: string): TimeRange | null {
  const idx = line.indexOf(ARROW)
  if (idx === -1) return null

  const before = line.slice(0, idx)
  const after = line.slice(idx + ARROW.length)

  const start = parseTimestampMs(before)
  if (start === null) return null

  const endParts = after.trim().split(/\s+/)
  const endToken = endParts[0]
  if (!endToken) return null
  const end = parseTimestampMs(endToken)
  if (end === null) return null

  const settings = endParts.slice(1).join(' ') || undefined
  return { start, end, settings }
}