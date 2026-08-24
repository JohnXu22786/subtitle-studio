/**
 * Alignment and consistency validation.
 *
 * Checks:
 * - document sanity: zero/negative duration, duplicate indexes, timeline
 *   overlaps between consecutive cues;
 * - translation alignment: count mismatch vs the source, missing cues,
 *   extra cues, empty translations, overlong cues that should be split.
 *
 * Every check is non-destructive — it produces diagnostics, never mutations.
 */

import type { SubtitleCue, SubtitleDocument, TranslationResult } from '../core/types.js'
import { countCjk } from '../core/types.js'

export type Severity = 'error' | 'warning'

export interface Issue {
  severity: Severity
  code:
    | 'invalid-timing'
    | 'zero-duration'
    | 'duplicate-index'
    | 'overlap'
    | 'count-mismatch'
    | 'missing-cue'
    | 'extra-cue'
    | 'empty-translation'
    | 'overlong'
  cueIndex?: number
  message: string
}

export interface SubtitleValidationOptions {
  /** Report overlaps between consecutive cues (default true). */
  checkOverlap?: boolean
}

export interface AlignmentValidationOptions {
  /** Max characters per cue before flagging it as too long. */
  maxChars?: number
  /** Max whitespace-separated words per Latin-script cue. */
  maxWords?: number
}

/** Sanity checks on a single subtitle document. */
export function validateSubtitle(
  document: SubtitleDocument,
  options: SubtitleValidationOptions = {},
): Issue[] {
  const issues: Issue[] = []
  const checkOverlap = options.checkOverlap ?? true

  const seen = new Set<number>()
  for (const cue of document.cues) {
    if (cue.end < cue.start) {
      issues.push({
        severity: 'error',
        code: 'invalid-timing',
        cueIndex: cue.index,
        message: `cue ${cue.index} ends before it starts (${cue.start}ms > ${cue.end}ms)`,
      })
    } else if (cue.end === cue.start) {
      issues.push({
        severity: 'warning',
        code: 'zero-duration',
        cueIndex: cue.index,
        message: `cue ${cue.index} has zero duration`,
      })
    }
    if (seen.has(cue.index)) {
      issues.push({
        severity: 'warning',
        code: 'duplicate-index',
        cueIndex: cue.index,
        message: `cue index ${cue.index} appears more than once`,
      })
    }
    seen.add(cue.index)

    if (!cue.text.trim()) {
      issues.push({
        severity: 'warning',
        code: 'empty-translation',
        cueIndex: cue.index,
        message: `cue ${cue.index} has empty text`,
      })
    }
  }

  if (checkOverlap) {
    const ordered = [...document.cues].sort((a, b) => a.start - b.start || a.index - b.index)
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!
      const curr = ordered[i]!
      if (curr.start < prev.end) {
        issues.push({
          severity: 'warning',
          code: 'overlap',
          cueIndex: curr.index,
          message: `cue ${curr.index} (${curr.start}ms) overlaps cue ${prev.index} (ends ${prev.end}ms)`,
        })
      }
    }
  }

  return issues
}

/** Alignment checks between a source document and its translations. */
export function validateTranslationAlignment(
  document: SubtitleDocument,
  results: TranslationResult[],
  options: AlignmentValidationOptions = {},
): Issue[] {
  const issues: Issue[] = []
  const maxChars = options.maxChars ?? 160
  const maxWords = options.maxWords ?? 40

  const sourceIndexes = new Set(document.cues.map((c) => c.index))

  for (const result of results) {
    const target = result.target
    const delivered = new Set(result.entries.map((e) => e.index))

    const expected = document.cues.length
    const actual = result.entries.length + result.missing.length
    if (actual !== expected) {
      issues.push({
        severity: 'error',
        code: 'count-mismatch',
        message: `[${target}] expected ${expected} translated cues but got ${actual} (${result.entries.length} delivered + ${result.missing.length} missing)`,
      })
    }

    for (const idx of result.missing) {
      issues.push({
        severity: 'error',
        code: 'missing-cue',
        cueIndex: idx,
        message: `[${target}] missing translation for cue ${idx}`,
      })
    }

    for (const entry of result.entries) {
      if (!sourceIndexes.has(entry.index)) {
        issues.push({
          severity: 'warning',
          code: 'extra-cue',
          cueIndex: entry.index,
          message: `[${target}] translation includes cue ${entry.index} which is not in the source`,
        })
      }
      if (!entry.text.trim()) {
        issues.push({
          severity: 'error',
          code: 'empty-translation',
          cueIndex: entry.index,
          message: `[${target}] translation for cue ${entry.index} is empty`,
        })
      }
    }
    void delivered
  }

  // Overlong cues apply to the source (readability on screen) — one pass.
  for (const cue of document.cues) {
    const cjk = countCjk(cue.text)
    const words = cue.text.trim() ? cue.text.trim().split(/\s+/).length : 0
    const isCjkHeavy = cjk > words
    const limit = isCjkHeavy ? maxChars : maxWords
    const measured = isCjkHeavy ? cjk : words
    if (measured > limit) {
      issues.push({
        severity: 'warning',
        code: 'overlong',
        cueIndex: cue.index,
        message: `cue ${cue.index} is ${measured} ${isCjkHeavy ? 'characters' : 'words'} long (limit ${limit}); consider splitting it into shorter cues`,
      })
    }
  }

  return issues
}

/** Convert issues to a compact human-readable report. */
export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'No issues found.'
  return issues
    .map((i) => `[${i.severity}] ${i.message}`)
    .join('\n')
}

/** Summarize issues by severity/code (used by CLI and tool output). */
export function summarizeIssues(issues: Issue[]): { errors: number; warnings: number; byCode: Record<string, number>; overlapIndices: number[] } {
  const byCode: Record<string, number> = {}
  let errors = 0
  let warnings = 0
  const overlapIndices: number[] = []
  for (const issue of issues) {
    byCode[issue.code] = (byCode[issue.code] ?? 0) + 1
    if (issue.severity === 'error') errors++
    else warnings++
    if (issue.code === 'overlap' && issue.cueIndex !== undefined) overlapIndices.push(issue.cueIndex)
  }
  return { errors, warnings, byCode, overlapIndices }
}