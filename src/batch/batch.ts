/**
 * Directory batch processing.
 *
 * Pipeline per file: parse → (validate) → translate for every target language
 * → merge into a bilingual subtitle → write outputs. Runs with a bounded
 * concurrency pool, per-file retry with backoff, and an optional on-disk
 * checkpoint that enables resuming interrupted runs.
 */

import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, basename, extname, resolve, sep } from 'node:path'

import {
  readSubtitleFile,
  writeSubtitleFile,
} from '../core/subtitle.js'
import type { SubtitleFormat, TranslationResult, BilingualLayout } from '../core/types.js'
import { validateSubtitle, validateTranslationAlignment, formatIssues } from '../validate/validate.js'
import { translateDocument } from '../translate/translate.js'
import { estimateTokens, estimateCost, formatCost, ratesForModel, type CostBreakdown } from '../translate/cost.js'
import type { LLMClient } from '../translate/llm.js'
import type { Glossary } from '../translate/glossary.js'
import { mergeBilingual } from '../merge/merge.js'
import { Checkpoint, type FileRecord } from './checkpoint.js'
import { writeTextFile } from '../core/encoding.js'

export interface BatchFileOptions {
  client: LLMClient
  targets: string[]
  source: string
  model: string
  outputDir: string
  glossary?: Glossary
  jsonMode: boolean
  chunkChars: number
  layout: BilingualLayout
  separator?: string
  tagTarget?: string
  outputFormat?: SubtitleFormat | 'keep'
  /** Also write a `.<target>.translation.json` file next to the subtitles. */
  writeTranslationJson: boolean
  /** Persist partial translation progress to `.<target>.translation.partial.json`. */
  persistPartial: boolean
}

export interface BatchRunOptions extends BatchFileOptions {
  inputDir: string
  outputDir: string
  extensions: string[]
  recursive: boolean
  concurrency: number
  maxRetries: number
  retryDelayMs: number
  checkpointPath?: string
  resume: boolean
  retryFailed: boolean
}

export interface BatchSummary {
  scanned: number
  skippedDone: number
  ok: number
  failed: number
  errors: string[]
  outputs: string[]
  costs: CostBreakdown
  checkpointPath?: string
}

export interface BatchLogger {
  info(message: string): void
}

export const nullLogger: BatchLogger = { info: () => undefined }

/** Recursively collect files with matching extensions. */
export async function listSubtitleFiles(
  inputDir: string,
  extensions: string[],
  recursive: boolean,
): Promise<Array<{ abs: string; rel: string }>> {
  const out: Array<{ abs: string; rel: string }> = []
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive) walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (extensions.length > 0 && !extensions.includes(ext)) continue
      out.push({ abs, rel: relative(inputDir, abs).replace(/\\/g, '/') })
    }
  }
  walk(inputDir)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Run a bounded concurrency pool over items. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const concurrency = Math.max(1, Math.min(limit, items.length))
  const runners: Promise<void>[] = []
  for (let r = 0; r < concurrency; r++) {
    runners.push(
      (async () => {
        while (next < items.length) {
          const index = next++
          const item = items[index]
          if (item === undefined) continue
          await worker(item)
        }
      })(),
    )
  }
  await Promise.all(runners)
}

export interface FileOutcome {
  outputPaths: string[]
  translatedCount: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  issues: string[]
}

/** Full per-file pipeline; throws on failure (caller applies retry policy).
 *
 * @param relStem the file's path relative to the input directory without its
 *   extension (e.g. `sub/film`), used to mirror the input tree under the
 *   output directory so two files sharing a basename never collide.
 */
export async function processSubtitleFile(
  absPath: string,
  relStem: string,
  options: BatchFileOptions,
  savePartial: (target: string, payload: unknown) => void,
): Promise<FileOutcome> {
  const { result } = readSubtitleFile(absPath)
  const doc = result.document
  if (doc.cues.length === 0) {
    throw new Error(`no cues parsed from ${basename(absPath)}`)
  }

  const issues = validateSubtitle(doc)
  const outcomes: TranslationResult[] = await translateDocument(
    doc.cues,
    {
      client: options.client,
      source: options.source,
      targets: options.targets,
      glossary: options.glossary,
      jsonMode: options.jsonMode,
      chunkChars: options.chunkChars,
    },
    {
      onPartial: options.persistPartial
        ? (partial, chunkIndex, chunkCount) => {
            if (chunkIndex + 1 < chunkCount) return
            savePartial(partial.target, partial)
          }
        : undefined,
    },
  )

  const outputPaths: string[] = []
  const ext = extname(absPath).toLowerCase()
  const outputFormat: SubtitleFormat =
    options.outputFormat === undefined || options.outputFormat === 'keep'
      ? ext === '.vtt'
        ? 'vtt'
        : 'srt'
      : options.outputFormat

  const rates = ratesForModel(options.model)
  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const outcome of outcomes) {
    const merged = mergeBilingual(doc, [outcome], {
      layout: options.layout,
      separator: options.separator,
      tagTarget: options.tagTarget,
    })
    const outName =
      options.targets.length > 1
        ? `${relStem}.${outcome.target}.bilingual.${outputFormat}`
        : `${relStem}.bilingual.${outputFormat}`
    const outPath = join(options.outputDir, outName)
    writeSubtitleFile(outPath, merged)
    outputPaths.push(outPath)

    if (options.writeTranslationJson) {
      const jsonPath = join(options.outputDir, `${relStem}.${outcome.target}.translation.json`)
      writeTextFile(jsonPath, translationJson(outcome))
      outputPaths.push(jsonPath)
    }

    const alignment = validateTranslationAlignment(doc, [outcome])
    const severeAlignment = alignment.filter((a) => a.severity === 'error')
    if (severeAlignment.length > 0) {
      throw new Error(
        `alignment issues for ${basename(absPath)} [${outcome.target}]: ${formatIssues(severeAlignment)}`,
      )
    }

    const breakdown = estimateCost(outcome.usage.inputTokens, outcome.usage.outputTokens, rates)
    costUsd += breakdown.totalUsd
    inputTokens += outcome.usage.inputTokens
    outputTokens += outcome.usage.outputTokens
  }

  return {
    outputPaths,
    translatedCount: doc.cues.length * outcomes.length,
    inputTokens,
    outputTokens,
    costUsd,
    issues: issues.map((i) => i.message),
  }
}

function translationJson(outcome: TranslationResult): string {
  const payload = {
    target: outcome.target,
    source: outcome.source,
    translatedCount: outcome.entries.length,
    missing: outcome.missing,
    errors: outcome.errors,
    entries: outcome.entries.map((e) => ({ index: e.index, text: e.text })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Make sure the output directory exists. */
export function ensureOutputDir(outputDir: string): void {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
}

/** Run the batch with concurrency, retry, and optional resume via checkpoint. */
export async function runBatch(
  options: BatchRunOptions,
  logger: BatchLogger = nullLogger,
): Promise<BatchSummary> {
  const allFiles = await listSubtitleFiles(options.inputDir, options.extensions, options.recursive)
  if (allFiles.length === 0) {
    throw new Error(
      `no subtitle files found in ${options.inputDir} (extensions: ${options.extensions.join(', ') || 'none'})`,
    )
  }

  // Never re-ingest our own output directory or checkpoint/partial artifacts.
  const outAbs = resolve(options.outputDir)
  const files = allFiles.filter((f) => !(f.abs === outAbs || f.abs.startsWith(outAbs + sep)))

  let checkpoint: Checkpoint | null = null
  if (options.checkpointPath) {
    const loaded = options.resume ? Checkpoint.load(options.checkpointPath) : null
    checkpoint = loaded ?? new Checkpoint(options.checkpointPath)
  }

  for (const f of files) checkpoint?.ensure(f.rel)

  let queue = files.map((f) => f.rel)
  if (checkpoint && options.resume) {
    queue = checkpoint.todo(options.maxRetries, options.retryFailed).map((t) => t.relPath)
  }
  // Files skipped because they were already done (not because they failed and
  // are excluded from retry — failed-but-not-retried must not be labelled done).
  const skippedDone = checkpoint
    ? Object.values(checkpoint.data.files).filter((r) => r.status === 'done').length
    : 0

  const byRel = new Map(files.map((f) => [f.rel, f]))

  const outputs: string[] = []
  const errors: string[] = []
  const done: string[] = []
  const rates = ratesForModel(options.model)
  const totalCost = { inputTokens: 0, outputTokens: 0, inputUsd: 0, outputUsd: 0, totalUsd: 0 }

  const processOne = async (rel: string): Promise<void> => {
    const file = byRel.get(rel)
    if (!file) throw new Error(`file disappeared from index: ${rel}`)
    const relStem = rel.slice(0, rel.length - extname(rel).length)

    let attempt = 0
    while (true) {
      attempt++
      checkpoint?.markProcessing(rel)
      try {
        const outcome = await processSubtitleFile(file.abs, relStem, options, (target, payload) => {
          if (!checkpoint || !options.persistPartial) return
          const partialPath = join(options.outputDir, `${relStem}.${target}.translation.partial.json`)
          writeTextFile(partialPath, JSON.stringify(payload, null, 2))
        })
        checkpoint?.markDone(rel, {
          outputPaths: outcome.outputPaths,
          translatedCount: outcome.translatedCount,
          costUsd: outcome.costUsd,
        })
        outputs.push(...outcome.outputPaths)
        done.push(rel)
        totalCost.inputTokens += outcome.inputTokens
        totalCost.outputTokens += outcome.outputTokens
        totalCost.inputUsd += (outcome.inputTokens / 1_000_000) * rates.inputPerMillion
        totalCost.outputUsd += (outcome.outputTokens / 1_000_000) * rates.outputPerMillion
        totalCost.totalUsd += outcome.costUsd
        logger.info(`ok   ${rel} (${outcome.outputPaths.length} output(s))`)
        for (const issue of outcome.issues) logger.info(`note ${rel}: ${issue}`)
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt > options.maxRetries) {
          checkpoint?.markFailed(rel, message)
          errors.push(`${rel}: ${message}`)
          logger.info(`fail ${rel}: ${message}`)
          break
        }
        logger.info(`retry ${rel} (attempt ${attempt}/${options.maxRetries + 1})`)
        await sleep(attempt * options.retryDelayMs)
      }
    }
    checkpoint?.save()
  }

  await runPool(queue, options.concurrency, processOne)

  return {
    scanned: files.length,
    skippedDone,
    ok: done.length,
    failed: errors.length,
    errors,
    outputs,
    costs: {
      ...totalCost,
      modelRates: rates,
    },
    checkpointPath: options.checkpointPath,
  }
}

/** Token/cost estimation across all queued files without calling the LLM. */
export async function estimateBatchCost(
  options: Pick<
    BatchRunOptions,
    'inputDir' | 'extensions' | 'recursive' | 'targets' | 'source' | 'model'
  >,
): Promise<{ files: Array<{ file: string; inputTokens: number }>; totals: CostBreakdown }> {
  const files = await listSubtitleFiles(options.inputDir, options.extensions, options.recursive)
  const rates = ratesForModel(options.model)
  const rows: Array<{ file: string; inputTokens: number }> = []
  let rawTokens = 0
  for (const f of files) {
    const { result } = readSubtitleFile(f.abs)
    const tokens = result.document.cues.reduce((sum, cue) => sum + estimateTokens(cue.text), 0)
    rawTokens += tokens
    rows.push({ file: f.rel, inputTokens: tokens })
  }
  // Prompt + JSON wrappers overhead approximation: ~35% over raw source text.
  const inputTokens = Math.round(rawTokens * 1.35 * options.targets.length)
  const outputTokens = Math.round(rawTokens * 0.35 * options.targets.length)
  return {
    files: rows,
    totals: estimateCost(inputTokens, outputTokens, rates),
  }
}

export { Checkpoint, formatCost }