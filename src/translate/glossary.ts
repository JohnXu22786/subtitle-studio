/**
 * Terminology glossary management.
 *
 * A glossary is a JSON document (`{ name, entries: [...], updatedAt }`),
 * persisted on disk. Entries optionally carry a `scope` — a target-language
 * tag — so one glossary can serve multiple target languages ("多目标语言术语表
 * 控制"): an entry whose `scope` does not match the target language is ignored.
 */

import { readTextFile, writeTextFile } from '../core/encoding.js'
import { existsSync } from 'node:fs'

export interface GlossaryEntry {
  source: string
  target: string
  note?: string
  /** Restrict the entry to one target language (e.g. `zh`, `fr`). */
  scope?: string
}

export interface Glossary {
  name: string
  entries: GlossaryEntry[]
  updatedAt: string
}

export class GlossaryError extends Error {
  override name = 'GlossaryError'
}

export function createGlossary(name = 'default'): Glossary {
  return { name, entries: [], updatedAt: new Date().toISOString() }
}

/** Parse glossary JSON text, validating each entry. Throws GlossaryError. */
export function parseGlossaryText(text: string): Glossary {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new GlossaryError(`glossary is not valid JSON: ${(cause as Error).message}`)
  }

  let entriesRaw: unknown
  let name = 'default'
  if (isRecord(raw)) {
    if (typeof raw.name === 'string' && raw.name.trim()) name = raw.name.trim()
    entriesRaw = raw.entries
  } else if (Array.isArray(raw)) {
    entriesRaw = raw
  } else {
    throw new GlossaryError('glossary must be an array of entries or an object with an "entries" array')
  }

  if (!Array.isArray(entriesRaw)) {
    throw new GlossaryError('glossary "entries" must be an array')
  }

  const entries: GlossaryEntry[] = []
  const seen = new Set<string>()

  for (const [i, item] of entriesRaw.entries()) {
    if (!isRecord(item)) {
      throw new GlossaryError(`entry #${i + 1} is not an object`)
    }
    const source = typeof item.source === 'string' ? item.source.trim() : ''
    const target = typeof item.target === 'string' ? item.target.trim() : ''
    if (!source || !target) {
      throw new GlossaryError(`entry #${i + 1} requires non-empty "source" and "target"`)
    }
    const note = typeof item.note === 'string' ? item.note : undefined
    const scope = typeof item.scope === 'string' && item.scope.trim() ? item.scope.trim() : undefined
    const key = entryKey({ source, target, scope })
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ source, target, note, scope })
  }

  return { name, entries, updatedAt: new Date().toISOString() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stable identity of an entry for deduplication. */
export function entryKey(entry: Pick<GlossaryEntry, 'source' | 'target' | 'scope'>): string {
  return `${entry.source.toLowerCase()}\u0000${entry.target}\u0000${entry.scope ?? ''}`
}

/** Load a glossary file. Returns an empty glossary when the path is absent. */
export function loadGlossaryFile(filename: string): Glossary {
  if (!existsSync(filename)) return createGlossary('default')
  return parseGlossaryText(readTextFile(filename).text)
}

export function saveGlossaryFile(filename: string, glossary: Glossary): void {
  const payload: Glossary = { ...glossary, updatedAt: new Date().toISOString() }
  writeTextFile(filename, `${JSON.stringify(payload, null, 2)}\n`)
}

/** Add or replace an entry (identity = source+target+scope). */
export function upsertEntry(glossary: Glossary, entry: GlossaryEntry): Glossary {
  const clean = {
    source: entry.source.trim(),
    target: entry.target.trim(),
    note: entry.note?.trim() || undefined,
    scope: entry.scope?.trim() || undefined,
  }
  if (!clean.source || !clean.target) {
    throw new GlossaryError('entry requires non-empty "source" and "target"')
  }
  const key = entryKey(clean)
  const next = glossary.entries.filter((e) => entryKey(e) !== key)
  next.push(clean)
  return { ...glossary, entries: next, updatedAt: new Date().toISOString() }
}

/**
 * Remove entries matching source (required) and, when given, target and scope.
 * Returns the number of removed entries.
 */
export function removeEntries(glossary: Glossary, source: string, target?: string, scope?: string): number {
  const sourceKey = source.toLowerCase()
  const before = glossary.entries.length
  const entries = glossary.entries.filter((e) => {
    if (e.source.toLowerCase() !== sourceKey) return true
    if (target !== undefined && e.target !== target) return true
    if (scope !== undefined && e.scope !== scope) return true
    return false
  })
  return before - entries.length
}

/** Merge multiple glossaries into one; later glossaries override earlier ones. */
export function mergeGlossaries(inputs: Glossary[]): Glossary {
  let merged = createGlossary(inputs.find((g) => g.name !== 'default')?.name ?? 'merged')
  for (const input of inputs) {
    for (const entry of input.entries) {
      merged = upsertEntry(merged, entry)
    }
  }
  return merged
}

/** Entries applicable to a target language (unscoped + matching scope). */
export function entriesForTarget(glossary: Glossary, target?: string): GlossaryEntry[] {
  return glossary.entries.filter((e) => e.scope === undefined || (target !== undefined && e.scope === target))
}

/** Entries whose source text appears in a given source text, longest first. */
export function matchingEntries(glossary: Glossary, text: string, target?: string): GlossaryEntry[] {
  const lower = text.toLowerCase()
  return entriesForTarget(glossary, target)
    .filter((e) => lower.includes(e.source.toLowerCase()))
    .sort((a, b) => b.source.length - a.source.length)
}

/** Render glossary entries as prompt text (newlines scrubbed to avoid
 *  instruction injection from untrusted glossary JSON). */
export function buildGlossaryPrompt(glossary: Glossary, target: string): string {
  const entries = entriesForTarget(glossary, target)
  if (entries.length === 0) return ''
  const lines = entries.map((e) => {
    const source = e.source.replace(/[\r\n]+/g, ' ')
    const targetText = e.target.replace(/[\r\n]+/g, ' ')
    const base = `- ${source} -> ${targetText}`
    const note = e.note?.replace(/[\r\n]+/g, ' ')
    return note ? `${base}  (${note})` : base
  })
  return [
    'Mandatory terminology for this translation (must always be used where the source term occurs):',
    ...lines,
  ].join('\n')
}

/** Pretty one-line-per-entry summary. */
export function formatGlossary(glossary: Glossary): string {
  const header = `Glossary "${glossary.name}" — ${glossary.entries.length} entries, updated ${glossary.updatedAt}`
  const rows = glossary.entries.map((e) => {
    const scope = e.scope ? ` [${e.scope}]` : ''
    const note = e.note ? ` — ${e.note}` : ''
    return `${e.source} -> ${e.target}${scope}${note}`
  })
  return [header, ...rows].join('\n')
}

/**
 * Post-translation spot check: report which glossary targets actually appear in
 * the translated text, and how many times each. Callers can use the inverse to
 * find terms the model ignored. Soft diagnostics — the caller decides severity.
 */
export function verifyGlossaryUsage(
  glossary: Glossary,
  target: string,
  translatedCues: Array<{ text: string }>,
): Array<{ entry: GlossaryEntry; occurrences: number }> {
  const reports: Array<{ entry: GlossaryEntry; occurrences: number }> = []
  const combined = translatedCues.map((c) => c.text).join('\n').toLowerCase()
  for (const entry of entriesForTarget(glossary, target)) {
    const needle = entry.target.toLowerCase()
    if (!needle) continue // guard against empty-target entries
    let occurrences = 0
    let from = 0
    while (from < combined.length) {
      const hit = combined.indexOf(needle, from)
      if (hit === -1) break
      occurrences++
      from = hit + needle.length
    }
    if (occurrences > 0) reports.push({ entry, occurrences })
  }
  return reports
}