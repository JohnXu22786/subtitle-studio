/**
 * Command-line interface (CLI) entry.
 *
 * A complete, dependency-free alternative to the dsh tools:
 *
 *   subtitle-studio parse <file>
 *   subtitle-studio translate <file> --target zh [options]
 *   subtitle-studio merge <srt/vtt> <translation.json> --layout stacked|interleaved
 *   subtitle-studio export <file> --output out.vtt
 *   subtitle-studio validate <file> [--compare <translation.json>]
 *   subtitle-studio glossary <add|list|remove|merge> [options]
 *   subtitle-studio batch <dir> --output-dir out [options]
 *   subtitle-studio cost <file|dir> [options]
 *
 * Configuration follows the plugin configuration (see README.md). API keys
 * may be supplied with `--api-key` or referenced as ${VAR} in config, e.g.
 * `--api-key ${DEEPSEEK_API_KEY}`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, type ResolvedConfig } from './config.js'
import {
  readSubtitleFile,
  writeSubtitleFile,
  convertSubtitle,
  formatFromExtension,
} from './core/subtitle.js'
import type { SubtitleFormat } from './core/types.js'
import {
  validateSubtitle,
  validateTranslationAlignment,
  formatIssues,
} from './validate/validate.js'
import {
  loadGlossaryFile,
  saveGlossaryFile,
  mergeGlossaries,
  formatGlossary,
  parseGlossaryText,
} from './translate/glossary.js'
import { createLlmClient, type LlmSettings } from './translate/llm.js'
import { translateDocument } from './translate/translate.js'
import { estimateCost, estimateTokens, ratesForModel, formatCost } from './translate/cost.js'
import { mergeBilingual, mergeWithEntries } from './merge/merge.js'
import { runBatch, estimateBatchCost, listSubtitleFiles, ensureOutputDir, type BatchRunOptions } from './batch/batch.js'
import { normalizeTranslations } from './tools/tools.js'

/* ------------------------------------------------------------------ */
/* Argument parsing                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | boolean>
  errors: string[]
}

export function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()
  const errors: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const raw = arg.slice(2)
      const eq = raw.indexOf('=')
      const name = eq === -1 ? raw : raw.slice(0, eq)
      if (eq === -1) {
        const next = argv[i + 1]
        const hasValue = next !== undefined && !next.startsWith('--')
        if (hasValue) {
          flags.set(name, next)
          i++
        } else {
          flags.set(name, true)
        }
      } else {
        flags.set(name, raw.slice(eq + 1))
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // Recognized short flags are passed through; unknown ones are rejected.
      if (['-h', '-v', '-V'].includes(arg)) {
        flags.set(arg.slice(1).toLowerCase() === 'v' || arg.slice(1) === 'V' ? 'version' : 'help', true)
        continue
      }
      errors.push(`unsupported short flag: ${arg}`)
      continue
    }
    positionals.push(arg)
  }

  return { positionals, flags, errors }
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

function flagBool(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.flags.get(name)
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return ['true', '1', 'on', 'yes'].includes(value.toLowerCase())
}

function flagNumber(parsed: ParsedArgs, name: string): number | undefined {
  const value = flagString(parsed, name)
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/* ------------------------------------------------------------------ */
/* Output helpers                                                     */
/* ------------------------------------------------------------------ */

function out(message: string): void {
  process.stdout.write(`${message}\n`)
}

function err(message: string): void {
  process.stderr.write(`subtitle-studio: ${message}\n`)
}

function die(message: string, code = 1): never {
  err(message)
  process.exitCode = code
  throw new Error(message)
}

function printJson(value: unknown, pretty = true): void {
  out(JSON.stringify(value, null, pretty ? 2 : undefined))
}

/* ------------------------------------------------------------------ */
/* Config plumbing                                                    */
/* ------------------------------------------------------------------ */

function configFromArgs(parsed: ParsedArgs): ResolvedConfig {
  const configFile = flagString(parsed, 'config')
  const user: Record<string, unknown> = {}
  if (configFile) {
    const path = isAbsolute(configFile) ? configFile : resolve(process.cwd(), configFile)
    Object.assign(user, JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
  }
  for (const [key, value] of parsed.flags) {
    user[key] = value
  }
  return resolveConfig(user as never)
}

function targetList(parsed: ParsedArgs): string[] {
  const explicit = flagString(parsed, 'target')
  if (explicit) return explicit.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return []
}

function llmFlags(parsed: ParsedArgs): LlmSettings {
  const cfg = configFromArgs(parsed)
  return {
    model: flagString(parsed, 'model') ?? cfg.llm.model,
    baseUrl: flagString(parsed, 'base-url') ?? cfg.llm.baseUrl,
    apiKey: flagString(parsed, 'api-key') ?? cfg.llm.apiKey,
    timeoutMs: flagNumber(parsed, 'timeout-ms') ?? cfg.llm.timeoutMs,
    maxRetries: flagNumber(parsed, 'max-retries') ?? cfg.llm.maxRetries,
    jsonMode: parsed.flags.has('json-mode') ? flagBool(parsed, 'json-mode') : cfg.llm.jsonMode,
  }
}

function loadGlossaryFromArgs(parsed: ParsedArgs, cfg: ResolvedConfig) {
  const path = flagString(parsed, 'glossary')
  if (path) return loadGlossaryFile(isAbsolute(path) ? path : resolve(process.cwd(), path))
  if (cfg.glossaryPaths.length > 0) {
    return mergeGlossaries(cfg.glossaryPaths.map((p) => loadGlossaryFile(isAbsolute(p) ? p : resolve(process.cwd(), p))))
  }
  return undefined
}

function cwdResolve(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function readJsonStrict(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseInlineOrFile(payload: string): unknown {
  return payload.startsWith('{') || payload.startsWith('[')
    ? JSON.parse(payload)
    : readJsonStrict(cwdResolve(payload))
}

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

function cmdHelp(): void {
  out(`subtitle-studio — multilingual subtitle translation workflow

Usage:
  subtitle-studio <command> [options]

Commands:
  parse       Parse an SRT/VTT file into structured cues (JSON).
  translate   Translate a subtitle file into one or more languages.
  merge       Merge a source subtitle with a translation payload.
  export      Convert a subtitle to SRT/VTT (optionally bilingual).
  validate    Check timeline sanity and translation alignment.
  glossary    Manage the terminology glossary JSON.
  batch       Translate a whole directory of subtitle files.
  cost        Estimate token usage and cost for files or a directory.
  help        Show this help.
  version     Show version.

Global options:
  --config <path>  Read plugin-style JSON config (see README).
  --api-key <key>  API key (or e.g. \${DEEPSEEK_API_KEY}).
  --base-url <url> OpenAI-compatible endpoint (default https://api.deepseek.com/v1).
  --model <name>   Model name (default deepseek-chat).
  --target <lang>  Target language code (repeatable or comma-separated).
  --source <lang>  Source language code.
  --json-mode      Request a JSON object response (default on for DeepSeek).
  --layout <l>     stacked | interleaved.

See README.md for per-command options and worked examples.`)
}

function cmdVersion(): void {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  out(pkg.version)
}

function cmdParse(parsed: ParsedArgs): void {
  const file = parsed.positionals[0] ?? flagString(parsed, 'file') ?? flagString(parsed, 'input')
  if (!file) die('parse requires a subtitle file path')
  const absolute = cwdResolve(file)
  const format = flagString(parsed, 'format')
  const hint: SubtitleFormat | undefined = format === 'srt' || format === 'vtt' ? format : undefined
  const { result, encoding } = readSubtitleFile(absolute, { format: hint })
  const summary = {
    path: absolute,
    format: result.document.format,
    encoding,
    cueCount: result.document.cues.length,
    issues: result.issues.length,
    cues: result.document.cues.map((c) => ({
      index: c.index,
      start: c.start,
      end: c.end,
      text: c.text,
    })),
  }
  if (flagBool(parsed, 'pretty')) {
    printJson(summary)
  } else {
    out(`format: ${summary.format} (${encoding})`)
    out(`cues: ${summary.cueCount}`)
    out(`issues: ${summary.issues}`)
    for (const issue of result.issues) {
      out(`  [${issue.kind}] line ${issue.line}: ${issue.message}`)
    }
  }
}

async function cmdTranslate(parsed: ParsedArgs): Promise<void> {
  const file = parsed.positionals[0] ?? flagString(parsed, 'input') ?? flagString(parsed, 'file')
  if (!file) die('translate requires an input subtitle file')
  const input = cwdResolve(file)

  const targets = targetList(parsed)
  if (targets.length === 0) die('translate requires at least one --target language')
  const source = flagString(parsed, 'source') ?? 'auto'

  const cfg = configFromArgs(parsed)
  const llm = llmFlags(parsed)
  const client = createLlmClient({ provider: cfg.llm.provider, ...llm })

  const glossary = loadGlossaryFromArgs(parsed, cfg)
  const { result } = readSubtitleFile(input)

  // Cost estimate before spending tokens.
  const rawTokens = result.document.cues.reduce((sum, c) => sum + estimateTokens(c.text), 0)
  const preEstimate = estimateCost(
    Math.round(rawTokens * 1.35 * targets.length),
    Math.round(rawTokens * 0.35 * targets.length),
    ratesForModel(llm.model ?? cfg.llm.model),
  )
  out(`Estimated ${targets.length} target(s): ${formatCost(preEstimate)}`)

  const outcomes = await translateDocument(
    result.document.cues,
    {
      client,
      source,
      targets,
      glossary,
      jsonMode: llm.jsonMode ?? cfg.llm.jsonMode,
      chunkChars: flagNumber(parsed, 'chunk-chars') ?? cfg.chunkChars,
    },
    {
      onPartial: flagString(parsed, 'save-partial') !== undefined
        ? (partial) => {
            const partialPath = cwdResolve(flagString(parsed, 'save-partial') as string)
            writeFileSync(partialPath, `${JSON.stringify(partial, null, 2)}\n`, 'utf8')
          }
        : undefined,
    },
  )

  const layout = flagString(parsed, 'layout') === 'interleaved' ? 'interleaved' : 'stacked'
  const separator = flagString(parsed, 'separator')
  const tag = flagString(parsed, 'tag')

  const written: string[] = []
  const output = flagString(parsed, 'output')
  if (output) {
    const outPath = cwdResolve(output)
    const targetFormat: SubtitleFormat = formatFromExtension(outPath) ?? result.document.format
    for (const outcome of outcomes) {
      // Split stem and extension so targets get distinct names even when the
      // requested output has no extension (e.g. `--output movie`).
      const extMatch = /(\.[^.\\/]+)$/.exec(outPath)
      const extPart = extMatch ? extMatch[1]! : ''
      const stemOut = extMatch ? outPath.slice(0, -extPart.length) : outPath
      const extOut = extPart
      const name = outcomes.length > 1 ? `${stemOut}.${outcome.target}${extOut}` : outPath
      writeSubtitleFile(name, convertSubtitle(mergeBilingual(result.document, [outcome], { layout, separator, tagTarget: tag }), targetFormat))
      written.push(name)
      const jsonPath = `${stemOut}.${outcome.target}.translation.json`
      const payload = {
        target: outcome.target,
        source: outcome.source,
        translatedCount: outcome.entries.length,
        missing: outcome.missing,
        errors: outcome.errors,
        entries: outcome.entries.map((e) => ({ index: e.index, text: e.text })),
      }
      writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      written.push(jsonPath)
    }
  }

  for (const outcome of outcomes) {
    const cost = estimateCost(
      outcome.usage.inputTokens,
      outcome.usage.outputTokens,
      ratesForModel(llm.model ?? cfg.llm.model),
    )
    out(`[${outcome.target}] ${formatCost(cost)}`)
    out(`[${outcome.target}] translated ${outcome.entries.length}/${result.document.cues.length} cues`)

    const alignment = validateTranslationAlignment(result.document, [outcome], {
      maxChars: cfg.maxChars,
      maxWords: cfg.maxWords,
    })
    if (alignment.length > 0) out(formatIssues(alignment))
    if (outcome.missing.length > 0) {
      out(`[${outcome.target}] MISSING cues: ${outcome.missing.join(', ')}`)
    }
    for (const e of outcome.entries) {
      out(`  ${e.index}: ${e.text.split('\n').join(' ⏎ ')}`)
    }
  }
  if (written.length > 0) out(`written: ${written.join(', ')}`)
}

function cmdMerge(parsed: ParsedArgs): void {
  const source = parsed.positionals[0] ?? flagString(parsed, 'source') ?? flagString(parsed, 'input')
  const payload = parsed.positionals[1] ?? flagString(parsed, 'translation')
  if (!source || !payload) {
    die('merge requires <source-subtitle> <translation.json|inline-json>')
  }
  const sourcePath = cwdResolve(source)
  const layout = flagString(parsed, 'layout') ?? 'stacked'
  if (layout !== 'stacked' && layout !== 'interleaved') die('--layout must be stacked or interleaved')

  const { result } = readSubtitleFile(sourcePath)
  const map = normalizeTranslations(parseInlineOrFile(payload))
  const entries = [...map.entries()].map(([index, text]) => ({
    index,
    text,
    source: result.document.cues.find((c) => c.index === index)?.text ?? '',
  }))

  const merged = mergeWithEntries(
    result.document,
    'auto',
    flagString(parsed, 'target') ?? '',
    entries,
    {
      layout: layout as 'stacked' | 'interleaved',
      separator: flagString(parsed, 'separator'),
      tagTarget: flagString(parsed, 'tag'),
    },
  )

  const output = flagString(parsed, 'output')
  if (output) {
    const targetFormat = formatFromExtension(output) ?? result.document.format
    writeSubtitleFile(cwdResolve(output), convertSubtitle(merged, targetFormat))
    out(`merged ${merged.cues.length} cue(s) -> ${output}`)
  } else {
    for (const cue of merged.cues.slice(0, 10)) {
      out(`${cue.start} -> ${cue.end}  ${JSON.stringify(cue.text)}`)
    }
    out(`... ${merged.cues.length} cues total`)
  }
}

function cmdExport(parsed: ParsedArgs): void {
  const input = parsed.positionals[0] ?? flagString(parsed, 'input')
  const output = flagString(parsed, 'output') ?? parsed.positionals[1]
  if (!input || !output) die('export requires <input> and --output <path>')
  const inputPath = cwdResolve(input)
  const outputPath = cwdResolve(output)

  const { result } = readSubtitleFile(inputPath)

  let document = result.document
  const translationArg = flagString(parsed, 'translation')
  if (translationArg) {
    const map = normalizeTranslations(parseInlineOrFile(translationArg))
    const entries = [...map.entries()].map(([index, text]) => ({
      index,
      text,
      source: document.cues.find((c) => c.index === index)?.text ?? '',
    }))
    document = mergeWithEntries(document, 'auto', '', entries, {
      layout: flagString(parsed, 'layout') === 'interleaved' ? 'interleaved' : 'stacked',
      tagTarget: flagString(parsed, 'tag'),
    })
  }

  const targetFormat = formatFromExtension(outputPath) ?? document.format
  document = convertSubtitle(document, targetFormat)
  writeSubtitleFile(outputPath, document)
  out(`exported ${document.cues.length} cue(s) as ${targetFormat} -> ${outputPath}`)
}

function cmdValidate(parsed: ParsedArgs): void {
  const file = parsed.positionals[0] ?? flagString(parsed, 'file') ?? flagString(parsed, 'input')
  if (!file) die('validate requires a subtitle file')
  const input = cwdResolve(file)

  const { result } = readSubtitleFile(input)
  const cfg = configFromArgs(parsed)

  let issues = validateSubtitle(result.document, { checkOverlap: !flagBool(parsed, 'no-overlap') })

  const compare = flagString(parsed, 'compare') ?? flagString(parsed, 'trans') ?? flagString(parsed, 'translation')
  if (compare) {
    const map = normalizeTranslations(parseInlineOrFile(compare))
    const entries = [...map.entries()].map(([index, text]) => ({
      index,
      text,
      source: result.document.cues.find((c) => c.index === index)?.text ?? '',
    }))
    const synthesized = {
      target: flagString(parsed, 'target') ?? 'translation',
      source: 'auto',
      entries,
      missing: result.document.cues.map((c) => c.index).filter((i) => !map.has(i)),
      extra: [...map.keys()].filter((i) => !result.document.cues.some((c) => c.index === i)),
      errors: [],
      chunkCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    }
    issues = issues.concat(
      validateTranslationAlignment(result.document, [synthesized], {
        maxChars: cfg.maxChars,
        maxWords: cfg.maxWords,
      }),
    )
  } else if (flagBool(parsed, 'overlong')) {
    issues = issues.concat(
      validateTranslationAlignment(result.document, [], {
        maxChars: cfg.maxChars,
        maxWords: cfg.maxWords,
      }),
    )
  }

  if (issues.length === 0) {
    out('No issues found.')
    return
  }
  for (const issue of issues) {
    out(`[${issue.severity}] ${issue.message}`)
  }
}

function cmdGlossary(parsed: ParsedArgs): void {
  const action = parsed.positionals[0] ?? flagString(parsed, 'action')
  if (!action) die('glossary requires an action: list | add | remove | merge')

  const cfg = configFromArgs(parsed)
  const path = flagString(parsed, 'path') ?? flagString(parsed, 'glossary')
  const primary =
    path !== undefined
      ? cwdResolve(path)
      : cfg.glossaryPaths.length > 0
        ? cwdResolve(cfg.glossaryPaths[0]!)
        : cwdResolve('glossary.json')

  let glossary = loadGlossaryFile(primary)

  switch (action) {
    case 'list':
    case 'show':
    case 'ls': {
      out(formatGlossary(glossary))
      return
    }
    case 'add': {
      const entryJson = flagString(parsed, 'entry')
      const entry = entryJson ? (JSON.parse(entryJson) as Record<string, unknown>) : null
      const source = flagString(parsed, 'source') ?? (entry && typeof entry['source'] === 'string' ? entry['source'] : undefined)
      const target = flagString(parsed, 'target') ?? (entry && typeof entry['target'] === 'string' ? entry['target'] : undefined)
      if (!source || !target) die('add requires --source and --target (or --entry JSON)')
      glossary = mergeGlossaries([
        glossary,
        {
          name: basename(primary),
          entries: [
            {
              source,
              target,
              note: flagString(parsed, 'note') ?? (entry && typeof entry['note'] === 'string' ? entry['note'] : undefined),
              scope: flagString(parsed, 'scope') ?? (entry && typeof entry['scope'] === 'string' ? entry['scope'] : undefined),
            },
          ],
          updatedAt: new Date().toISOString(),
        },
      ])
      saveGlossaryFile(primary, glossary)
      out(`added ${source} -> ${target} (${glossary.entries.length} total)`)
      return
    }
    case 'remove': {
      const source = flagString(parsed, 'source')
      if (!source) die('remove requires --source')
      const before = glossary.entries.length
      glossary = {
        ...glossary,
        entries: glossary.entries.filter((e) => e.source.toLowerCase() !== source.toLowerCase()),
      }
      saveGlossaryFile(primary, glossary)
      out(`removed ${before - glossary.entries.length} entrie(s) (${glossary.entries.length} remain)`)
      return
    }
    case 'merge': {
      const withPath = flagString(parsed, 'with')
      if (!withPath) die('merge requires --with <other-glossary.json>')
      const other = loadGlossaryFile(cwdResolve(withPath))
      glossary = mergeGlossaries([glossary, other])
      saveGlossaryFile(primary, glossary)
      out(`merged; ${glossary.entries.length} entries total`)
      return
    }
    case 'parse': {
      const parsed2 = parseGlossaryText(readFileSync(primary, 'utf8'))
      printJson(parsed2)
      return
    }
    default:
      die(`unknown glossary action: ${action}`)
  }
}

async function cmdBatch(parsed: ParsedArgs): Promise<void> {
  const dir = parsed.positionals[0] ?? flagString(parsed, 'input-dir') ?? flagString(parsed, 'dir')
  if (!dir) die('batch requires an input directory')
  const inputDir = cwdResolve(dir)

  const targets = targetList(parsed)
  if (targets.length === 0) die('batch requires at least one --target language')

  const cfg = configFromArgs(parsed)
  const llm = llmFlags(parsed)

  const extensions = (
    flagString(parsed, 'extensions')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => (s.startsWith('.') ? s : `.${s}`)) ?? ['.srt', '.vtt']
  ) as string[]

  if (flagBool(parsed, 'estimate')) {
    // Cost estimation is offline — no credentials or glossary required.
    const estimate = await estimateBatchCost({
      inputDir,
      extensions,
      recursive: !flagBool(parsed, 'no-recursive'),
      targets,
      source: flagString(parsed, 'source') ?? 'auto',
      model: llm.model ?? cfg.llm.model,
    })
    out(`Estimated total: ${formatCost(estimate.totals)}`)
    for (const row of estimate.files) out(`  ${row.file}: ${row.inputTokens} input tokens`)
    return
  }

  const client = createLlmClient({ provider: cfg.llm.provider, ...llm })
  const glossary = loadGlossaryFromArgs(parsed, cfg)
  const outputDir = cwdResolve(flagString(parsed, 'output-dir') ?? 'out')

  ensureOutputDir(outputDir)

  const options: BatchRunOptions = {
    client,
    targets,
    source: flagString(parsed, 'source') ?? 'auto',
    model: llm.model ?? cfg.llm.model,
    glossary,
    jsonMode: llm.jsonMode ?? cfg.llm.jsonMode,
    chunkChars: flagNumber(parsed, 'chunk-chars') ?? cfg.chunkChars,
    layout: flagString(parsed, 'layout') === 'interleaved' ? 'interleaved' : cfg.layout,
    separator: flagString(parsed, 'separator') ?? cfg.separator,
    tagTarget: flagString(parsed, 'tag') ?? cfg.tagTarget,
    outputFormat:
      flagString(parsed, 'format') === 'srt' || flagString(parsed, 'format') === 'vtt' ? (flagString(parsed, 'format') as SubtitleFormat) : cfg.outputFormat,
    writeTranslationJson: flagBool(parsed, 'write-translation-json'),
    persistPartial: flagBool(parsed, 'persist-partial'),
    inputDir,
    outputDir,
    extensions,
    recursive: !flagBool(parsed, 'no-recursive'),
    concurrency: flagNumber(parsed, 'concurrency') ?? cfg.concurrency,
    maxRetries: flagNumber(parsed, 'max-retries') ?? cfg.maxRetries,
    retryDelayMs: flagNumber(parsed, 'retry-delay') ?? cfg.retryDelayMs,
    checkpointPath: flagString(parsed, 'checkpoint') ?? cfg.checkpointPath,
    resume: flagBool(parsed, 'resume'),
    retryFailed: !flagBool(parsed, 'no-retry-failed') && cfg.retryFailed,
  }

  const summary = await runBatch(options, { info: out })
  out(
    `Summary: scanned=${summary.scanned} ok=${summary.ok} failed=${summary.failed} skipped(done)=${summary.skippedDone} outputs=${summary.outputs.length}`,
  )
  for (const e of summary.errors) err(e)
  if (summary.errors.length > 0) process.exitCode = 1
}

async function cmdCost(parsed: ParsedArgs): Promise<void> {
  const target = parsed.positionals[0] ?? flagString(parsed, 'input') ?? flagString(parsed, 'file') ?? flagString(parsed, 'dir')
  if (!target) die('cost requires a file or directory')

  const cfg = configFromArgs(parsed)
  const model = flagString(parsed, 'model') ?? cfg.llm.model
  const rateIn = flagNumber(parsed, 'rate-in')
  const rateOut = flagNumber(parsed, 'rate-out')
  const rates = rateIn !== undefined && rateOut !== undefined
    ? { inputPerMillion: rateIn, outputPerMillion: rateOut }
    : ratesForModel(model)

  const targets = targetList(parsed)
  if (targets.length === 0) targets.push('translation')

  const targetAbs = cwdResolve(target)
  let paths: Array<{ abs: string; rel: string }>
  const stats = await stat(targetAbs)
  if (stats.isDirectory()) {
    paths = await listSubtitleFiles(targetAbs, ['.srt', '.vtt'], true)
  } else {
    paths = [{ abs: targetAbs, rel: basename(targetAbs) }]
  }

  let raw = 0
  for (const p of paths) {
    const { result } = readSubtitleFile(p.abs)
    const tokens = result.document.cues.reduce((sum, c) => sum + estimateTokens(c.text), 0)
    raw += tokens
    out(`  ${p.rel}: ${tokens} input tokens`)
  }
  const input = Math.round(raw * 1.35 * targets.length)
  const output = Math.round(raw * 0.35 * targets.length)
  out(`Total: ${formatCost(estimateCost(input, output, rates))} (model ${model})`)
}

/* ------------------------------------------------------------------ */
/* Entry point                                                       */
/* ------------------------------------------------------------------ */

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgv(argv)
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) err(e)
    process.exitCode = 2
    return
  }

  const command = parsed.positionals.shift()

  // `-v`, `-V` and `--version` are parsed as flags, not positionals.
  if (parsed.flags.has('version')) {
    cmdVersion()
    return
  }
  if (parsed.flags.has('help')) {
    cmdHelp()
    return
  }

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      cmdHelp()
      return
    case 'version':
    case '--version':
      cmdVersion()
      return
    case 'parse':
      cmdParse(parsed)
      return
    case 'translate':
      await cmdTranslate(parsed)
      return
    case 'merge':
      cmdMerge(parsed)
      return
    case 'export':
      cmdExport(parsed)
      return
    case 'validate':
      cmdValidate(parsed)
      return
    case 'glossary':
      cmdGlossary(parsed)
      return
    case 'batch':
      await cmdBatch(parsed)
      return
    case 'cost':
      await cmdCost(parsed)
      return
    case undefined:
      cmdHelp()
      return
    default:
      err(`unknown command: ${command}`)
      process.exitCode = 2
  }
}