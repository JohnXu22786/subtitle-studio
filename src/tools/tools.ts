/**
 * dsh tool surface: sub_parse, sub_translate, sub_merge, sub_export,
 * sub_glossary.
 *
 * These definitions follow the DeepSeek Harness tool contract: a schema
 * (`parameters`), a canonical JSON `output` schema, and an `execute` returning
 * exactly that shape. The layer is deliberately cordis-agnostic — definitions
 * are plain data — so the same toolset can be registered by the plugin entry
 * (`ctx.tools.register`) or exercised directly by the CLI.
 */

import type { ResolvedConfig } from '../config.js'
import type { SubtitleDocument, SubtitleFormat, BilingualLayout } from '../core/types.js'
import {
  readSubtitleFile,
  writeSubtitleFile,
  convertSubtitle,
  formatFromExtension,
} from '../core/subtitle.js'
import { loadGlossaryFile, saveGlossaryFile, mergeGlossaries, upsertEntry, removeEntries } from '../translate/glossary.js'
import { createLlmClient, type LlmSeam, type LLMClient } from '../translate/llm.js'
import { translateCues } from '../translate/translate.js'
import { estimateCost, ratesForModel } from '../translate/cost.js'
import { mergeBilingual, mergePreview } from '../merge/merge.js'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/* ------------------------------------------------------------------ */
/* Structural types (mirror the harness tool contract loosely)        */
/* ------------------------------------------------------------------ */

export type JsonSchemaPrimitive = 'string' | 'integer' | 'number' | 'boolean' | 'null'
export type JsonSchemaType = JsonSchemaPrimitive | 'array' | 'object' | ReadonlyArray<string>

/**
 * A flexible JSON-schema-like node describing tool parameters/outputs.
 * `required` is accepted both at object level (`string[]`) and on individual
 * nodes (`boolean`), matching the conventions different harness consumers use.
 */
export interface JsonSchemaNode {
  type?: JsonSchemaType
  description?: string
  enum?: Array<string | number | boolean>
  required?: boolean | string[]
  minimum?: number
  maximum?: number
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: boolean
}

export interface ToolParameterSpec {
  type: string
  required?: boolean
  description?: string
  enum?: string[]
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: boolean
}

export interface ContentBlock {
  type: 'text'
  text: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, ToolParameterSpec>
  output: {
    schema: JsonSchemaNode
    render: (args: Record<string, unknown>, value: JsonValue) => ContentBlock[]
  }
  execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<JsonValue>
  isConcurrencySafe?: boolean | ((args: Record<string, unknown>) => boolean)
}

export type JsonValue = unknown

export class ToolError extends Error {
  override name = 'ToolError'
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

export interface ToolEnvironment {
  config: ResolvedConfig
  /** Optional host LLM seam for `provider: 'dsh'`. */
  seam?: LlmSeam
  cwd?: string
}

function cwdOf(env: ToolEnvironment): string {
  return env.cwd ?? process.cwd()
}

function resolvePath(path: string, env: ToolEnvironment): string {
  return isAbsolute(path) ? path : resolve(cwdOf(env), path)
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`missing or invalid string argument "${key}"`)
  }
  return value
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function grammarOfExt(filename: string): SubtitleFormat | undefined {
  return formatFromExtension(filename)
}

/** Normalize an arbitrary translation payload into a Map<index, text>. */
export function normalizeTranslations(
  payload: unknown,
): Map<number, string> {
  const result = new Map<number, string>()
  if (payload === undefined || payload === null) return result

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const index = numberValue(rec['index'] ?? rec['i'] ?? rec['id'])
      const text = stringValue(rec['text'] ?? rec['t'] ?? rec['translation'])
      if (index !== undefined && text !== undefined) result.set(index, text)
    }
    return result
  }

  if (typeof payload === 'object') {
    const rec = payload as Record<string, unknown>
    const entries = rec['entries']
    if (Array.isArray(entries)) {
      return normalizeTranslations(entries)
    }
    // object form: { "1": "text", "2": "text" }
    for (const [key, value] of Object.entries(rec)) {
      const index = Number(key)
      const text = stringValue(value)
      if (Number.isInteger(index) && text !== undefined) result.set(index, text)
    }
  }
  return result
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  return undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/* ------------------------------------------------------------------ */
/* Tool definitions                                                   */
/* ------------------------------------------------------------------ */

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

interface ParsedToolOutput {
  path: string
  format: SubtitleFormat
  cueCount: number
  cues: Array<{ index: number; start: number; end: number; text: string }>
  issues: Array<{ severity: string; message: string }>
}

/** sub_parse — parse a subtitle file into structured cues. */
export function subParseTool(env: ToolEnvironment): ToolDefinition {
  return {
    name: 'sub_parse',
    description:
      'Parse a subtitle file (SRT or VTT, auto-detected) into a structured list of cues with start/end timestamps in milliseconds. Tolerant of malformed lines, which are reported as issues. Use this before translating.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the .srt or .vtt file.' },
      format: {
        type: 'string',
        enum: ['srt', 'vtt'],
        description: 'Optional explicit format hint; auto-detected when omitted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: ['srt', 'vtt'] },
          cueCount: { type: 'integer', required: true },
          cues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                start: { type: 'integer', required: true },
                end: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true, enum: ['error', 'warning'] },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as ParsedToolOutput
        const issueCount = v.issues.length
        return textBlock(
          `Parsed ${v.cueCount} cues from ${v.path} (${v.format}, ${issueCount} issue(s)).`,
        )
      },
    },
    async execute(args) {
      const path = requireString(args, 'path')
      const absolute = resolvePath(path, env)
      if (!existsSync(absolute)) throw new ToolError(`file not found: ${absolute}`)
      const hint = args['format']
      const formatHint = hint === 'srt' || hint === 'vtt' ? hint : undefined
      const { result } = readSubtitleFile(absolute, { format: formatHint })
      return {
        path: absolute,
        format: result.document.format,
        cueCount: result.document.cues.length,
        cues: result.document.cues.map((c) => ({
          index: c.index,
          start: c.start,
          end: c.end,
          text: c.text,
        })),
        issues: result.issues.map((i) => ({ severity: i.kind, message: i.message })),
      }
    },
    isConcurrencySafe: () => true,
  }
}

/** sub_translate — translate the cues of a file into one or more languages. */
export function subTranslateTool(env: ToolEnvironment): ToolDefinition {
  return {
    name: 'sub_translate',
    description:
      'Translate the cues of a subtitle file into a target language (OpenAI-compatible endpoint, default DeepSeek, or the dsh ctx.llm seam). Supports a glossary and returns aligned translations keyed by original cue index. Expensive: costs LLM tokens.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the source subtitle file.' },
      target: { type: 'string', required: true, description: 'Target language code, e.g. zh, fr, ja.' },
      source: { type: 'string', description: 'Source language code, e.g. en. Defaults to auto detection by the model.' },
      glossaryPath: { type: 'string', description: 'Path to a JSON glossary file (optional).' },
      model: { type: 'string', description: 'Override the configured LLM model.' },
      baseUrl: { type: 'string', description: 'Override the OpenAI-compatible base URL.' },
      apiKey: { type: 'string', description: 'Override the API key.' },
      jsonMode: { type: 'boolean', description: 'Request a JSON object response when the endpoint supports it (default: config).' },
      chunkChars: { type: 'integer', description: 'Cue-character budget per request (default: config).' },
      outputPath: { type: 'string', description: 'Write the bilingual subtitle here (optional; requires layout).' },
      layout: { type: 'string', enum: ['stacked', 'interleaved'], description: 'Merge layout, used only with outputPath.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          source: { type: 'string', required: true },
          cueCount: { type: 'integer', required: true },
          translatedCount: { type: 'integer', required: true },
          missing: { type: 'array', required: true, items: { type: 'integer' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          costUsd: { type: 'number', required: true },
          translated: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          outputPath: { type: ['string', 'null'], required: true },
        },
      },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return textBlock(
          `Translated ${v.translatedCount}/${v.cueCount} cues into ${v.target} ($${String((v.costUsd as number).toFixed(4))}, ${(v.missing as unknown[]).length} missing).`,
        )
      },
    },
    async execute(args) {
      const path = resolvePath(requireString(args, 'path'), env)
      if (!existsSync(path)) throw new ToolError(`file not found: ${path}`)
      const target = requireString(args, 'target').toLowerCase()
      const source = optString(args, 'source') ?? (env.config.sourceLanguage || 'auto')
      const model = optString(args, 'model') ?? env.config.llm.model
      const baseUrl = optString(args, 'baseUrl') ?? env.config.llm.baseUrl
      const apiKey = optString(args, 'apiKey') ?? env.config.llm.apiKey
      const jsonMode = typeof args['jsonMode'] === 'boolean' ? args['jsonMode'] : env.config.llm.jsonMode
      const chunkChars = optNumber(args, 'chunkChars') ?? env.config.chunkChars

      const client: LLMClient = createLlmClient(
        {
          provider: env.config.llm.provider,
          model,
          baseUrl,
          apiKey,
          jsonMode,
          timeoutMs: env.config.llm.timeoutMs,
          maxRetries: env.config.llm.maxRetries,
        },
        { seam: env.seam },
      )

      const { result } = readSubtitleFile(path)
      const doc = result.document

      const glossaryPath = optString(args, 'glossaryPath')
      const glossary = glossaryPath
        ? loadGlossaryFile(resolvePath(glossaryPath, env))
        : env.config.glossaryPaths.length > 0
          ? mergeGlossaries(env.config.glossaryPaths.map((p) => loadGlossaryFile(resolvePath(p, env))))
          : undefined

      const outcome = await translateCues(doc.cues, {
        client,
        source,
        target,
        glossary,
        jsonMode,
        chunkChars,
      })

      const rates = ratesForModel(model)
      const cost = estimateCost(outcome.usage.inputTokens, outcome.usage.outputTokens, rates)

      let outputPath: string | undefined = optString(args, 'outputPath')
      let layout: BilingualLayout | undefined =
        args['layout'] === 'interleaved' ? 'interleaved' : args['layout'] === 'stacked' ? 'stacked' : undefined
      if (outputPath && !layout) layout = env.config.layout
      if (outputPath) {
        if (!layout) throw new ToolError('outputPath requires a layout (stacked | interleaved)')
        const absolute = resolvePath(outputPath, env)
        const merged = mergeBilingual(doc, [outcome], { layout, tagTarget: env.config.tagTarget, separator: env.config.separator })
        writeSubtitleFile(absolute, merged)
        outputPath = absolute
      }

      return {
        target,
        source,
        cueCount: doc.cues.length,
        translatedCount: outcome.entries.length,
        missing: outcome.missing,
        errors: outcome.errors,
        costUsd: cost.totalUsd,
        translated: outcome.entries.map((e) => ({ index: e.index, text: e.text })),
        outputPath: outputPath ?? null,
      }
    },
    isConcurrencySafe: () => false, // calls paid LLM APIs — never run in parallel
  }
}

/** sub_merge — merge a source document with translations into a bilingual subtitle. */
export function subMergeTool(env: ToolEnvironment): ToolDefinition {
  return {
    name: 'sub_merge',
    description:
      'Merge a source subtitle file with a translation payload (path to a translation JSON, an inline object, or an inline array) into a bilingual subtitle document. Layouts: stacked (translation below original) or interleaved (alternating cues). Optionally writes the result to outputPath.',
    parameters: {
      sourcePath: { type: 'string', required: true, description: 'Path to the original subtitle file.' },
      translation: {
        type: 'object',
        description:
          'Translation payload: path to translation JSON, or an object like {"9": "text"} / {"entries":[...]} / [{index,text}].',
        additionalProperties: true,
      },
      layout: { type: 'string', required: true, enum: ['stacked', 'interleaved'], description: 'Merge layout.' },
      separator: { type: 'string', description: 'Optional line placed between original and translated blocks (stacked).' },
      tagTarget: { type: 'string', description: 'Optional per-line tag prefix for translated lines, e.g. [zh].' },
      outputPath: { type: 'string', description: 'Optional output file path; when given the merged document is written.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cueCount: { type: 'integer', required: true },
          layout: { type: 'string', required: true, enum: ['stacked', 'interleaved'] },
          outputPath: { type: ['string', 'null'], required: true },
          preview: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                start: { type: 'integer', required: true },
                end: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return textBlock(
          `Merged ${v.cueCount} cue(s) (${v.layout}).${v.outputPath ? ` Written to ${v.outputPath}.` : ''}`,
        )
      },
    },
    async execute(args) {
      const sourcePath = resolvePath(requireString(args, 'sourcePath'), env)
      if (!existsSync(sourcePath)) throw new ToolError(`file not found: ${sourcePath}`)
      const layout = requireString(args, 'layout')
      if (layout !== 'stacked' && layout !== 'interleaved') {
        throw new ToolError('layout must be "stacked" or "interleaved"')
      }

      const { result } = readSubtitleFile(sourcePath)

      const translationArg = args['translation']
      if (translationArg === undefined || translationArg === null) {
        throw new ToolError('missing "translation" payload')
      }
      let map: Map<number, string>
      if (typeof translationArg === 'string') {
        const translationPath = resolvePath(translationArg, env)
        if (!existsSync(translationPath)) throw new ToolError(`translation file not found: ${translationPath}`)
        const parsed = JSON.parse(readFileSync(translationPath, 'utf8')) as unknown
        map = normalizeTranslations(parsed)
      } else {
        map = normalizeTranslations(translationArg)
      }

      const entries = [...map.entries()].map(([index, text]) => ({
        index,
        text,
        source: result.document.cues.find((c) => c.index === index)?.text ?? '',
      }))

      const merged = mergeBilingual(
        result.document,
        [
          {
            target: optString(args, 'tagTarget') ?? '',
            source: '',
            entries,
            missing: [],
            extra: [],
            errors: [],
            chunkCount: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        ],
        {
          layout: layout as BilingualLayout,
          separator: optString(args, 'separator') ?? env.config.separator,
          tagTarget: optString(args, 'tagTarget') ?? env.config.tagTarget,
        },
      )

      const outputPath = optString(args, 'outputPath')
      let written: string | null = null
      if (outputPath) {
        written = resolvePath(outputPath, env)
        writeSubtitleFile(written, merged)
      }

      return {
        cueCount: merged.cues.length,
        layout,
        outputPath: written,
        preview: mergePreview(merged, 5),
      }
    },
    isConcurrencySafe: () => true,
  }
}

/** sub_export — convert subtitles to a target format/encoding, optionally bilingual. */
export function subExportTool(env: ToolEnvironment): ToolDefinition {
  return {
    name: 'sub_export',
    description:
      'Export a subtitle file to SRT or VTT (UTF-8). Converts the container format while preserving exact timestamps; can first merge a translation payload for a bilingual output.',
    parameters: {
      inputPath: { type: 'string', required: true, description: 'Path to the input subtitle file.' },
      outputPath: { type: 'string', required: true, description: 'Where to write the result.' },
      format: { type: 'string', enum: ['srt', 'vtt'], description: 'Target format; defaults to the output extension.' },
      translation: { type: 'object', description: 'Optional translation payload (same shape as sub_merge); enables bilingual export.' },
      layout: { type: 'string', enum: ['stacked', 'interleaved'], description: 'Merge layout when translation is given.' },
      tagTarget: { type: 'string', description: 'Optional translated-line tag prefix.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: ['srt', 'vtt'] },
          cueCount: { type: 'integer', required: true },
          bilingual: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return textBlock(
          `Exported ${v.cueCount} cue(s) as ${v.format} to ${v.outputPath}${v.bilingual ? ' (bilingual)' : ''}.`,
        )
      },
    },
    async execute(args) {
      const inputPath = resolvePath(requireString(args, 'inputPath'), env)
      if (!existsSync(inputPath)) throw new ToolError(`file not found: ${inputPath}`)

      const { result } = readSubtitleFile(inputPath)
      let doc: SubtitleDocument = result.document

      const translationArg = args['translation']
      let bilingual = false
      if (translationArg !== undefined && translationArg !== null) {
        const map =
          typeof translationArg === 'string'
            ? normalizeTranslations(JSON.parse(readFileSync(resolvePath(translationArg, env), 'utf8')) as unknown)
            : normalizeTranslations(translationArg)
        const entries = [...map.entries()].map(([index, text]) => ({
          index,
          text,
          source: doc.cues.find((c) => c.index === index)?.text ?? '',
        }))
        const layout = args['layout'] === 'interleaved' ? 'interleaved' : 'stacked'
        doc = mergeBilingual(
          doc,
          [
            {
              target: optString(args, 'tagTarget') ?? '',
              source: '',
              entries,
              missing: [],
              extra: [],
              errors: [],
              chunkCount: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          ],
          { layout: layout as BilingualLayout, tagTarget: optString(args, 'tagTarget') ?? env.config.tagTarget, separator: env.config.separator },
        )
        bilingual = true
      }

      const formatArg = args['format']
      const explicitFormat: SubtitleFormat | undefined =
        formatArg === 'srt' || formatArg === 'vtt' ? (formatArg as SubtitleFormat) : undefined
      const targetFormat: SubtitleFormat =
        explicitFormat ?? grammarOfExt(requireString(args, 'outputPath')) ?? doc.format
      doc = convertSubtitle(doc, targetFormat)

      const outputPath = resolvePath(requireString(args, 'outputPath'), env)
      writeSubtitleFile(outputPath, doc)
      return {
        outputPath,
        format: targetFormat,
        cueCount: doc.cues.length,
        bilingual,
      }
    },
    isConcurrencySafe: () => true,
  }
}

/** sub_glossary — manage the JSON terminology glossary. */
export function subGlossaryTool(env: ToolEnvironment): ToolDefinition {
  return {
    name: 'sub_glossary',
    description:
      'Manage the translation glossary: list entries, add/update one, remove entries, or merge another glossary file. The glossary is JSON ({name, entries:[{source,target,note?,scope?}]}) and is injected into translation prompts.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'remove', 'merge'],
        description: 'Operation to perform.',
      },
      glossaryPath: { type: 'string', description: 'Path to the glossary JSON; defaults to the plugin-configured glossary.' },
      entry: {
        type: 'object',
        description: 'For "add": {source, target, note?, scope?}.',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          target: { type: 'string', required: true },
          note: { type: 'string' },
          scope: { type: 'string' },
        },
      },
      source: { type: 'string', description: 'For "remove": the source term to remove.' },
      target: { type: 'string', description: 'For "remove": restrict removal to this target.' },
      with: { type: 'string', description: 'For "merge": path to another glossary JSON to merge in.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          glossaryPath: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          removed: { type: 'integer', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                target: { type: 'string', required: true },
                note: { type: 'string' },
                scope: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as Record<string, unknown>
        return textBlock(
          `Glossary ${v.action} on ${v.glossaryPath}: ${v.count} entries total (${v.removed} removed).\n` +
            textPreview((v.entries as Array<Record<string, unknown>>).map((e) => `${e.source} -> ${e.target}`)),
        )
      },
    },
    async execute(args) {
      const action = requireString(args, 'action')
      if (!['list', 'add', 'remove', 'merge'].includes(action)) {
        throw new ToolError('action must be one of: list, add, remove, merge')
      }

      const givenPath = optString(args, 'glossaryPath')
      const paths =
        givenPath !== undefined
          ? [resolvePath(givenPath, env)]
          : env.config.glossaryPaths.length > 0
            ? env.config.glossaryPaths.map((p) => resolvePath(p, env))
            : [resolve(cwdOf(env), 'glossary.json')]

      let glossary = mergeGlossaries(paths.map((p) => loadGlossaryFile(p)))
      let removed = 0
      let save = false

      if (action === 'add') {
        const entry = args['entry']
        if (typeof entry !== 'object' || entry === null) throw new ToolError('"entry" object required for add')
        const rec = entry as Record<string, unknown>
        const source = stringValue(rec['source'])
        const target = stringValue(rec['target'])
        if (!source || !target) throw new ToolError('entry.source and entry.target are required for add')
        glossary = upsertEntry(glossary, {
          source,
          target,
          note: stringValue(rec['note']),
          scope: stringValue(rec['scope']),
        })
        save = true
      } else if (action === 'remove') {
        const source = optString(args, 'source')
        if (!source) throw new ToolError('"source" required for remove')
        const target = optString(args, 'target')
        removed = removeEntries(glossary, source, target)
        if (removed > 0) {
          glossary = {
            ...glossary,
            entries: glossary.entries.filter(
              (e) =>
                !(e.source.toLowerCase() === source.toLowerCase() && (target === undefined || e.target === target)),
            ),
            updatedAt: new Date().toISOString(),
          }
          save = true
        }
      } else if (action === 'merge') {
        const withPath = optString(args, 'with')
        if (!withPath) throw new ToolError('"with" path required for merge')
        const other = loadGlossaryFile(resolvePath(withPath, env))
        glossary = mergeGlossaries([glossary, other])
        save = true
      }

      if (save) {
        const primary = paths[0]!
        saveGlossaryFile(primary, glossary)
      }

      return {
        action,
        glossaryPath: paths[0]!,
        count: glossary.entries.length,
        removed,
        entries: glossary.entries.map((e) => ({
          source: e.source,
          target: e.target,
          note: e.note,
          scope: e.scope,
        })),
      }
    },
    isConcurrencySafe: () => true,
  }
}

// Local helpers, no imports needed past the top of the file.

function textPreview(lines: string[], max = 8): string {
  const shown = lines.slice(0, max)
  const rest = lines.length > max ? `\n… ${lines.length - max} more` : ''
  return shown.join('\n') + rest
}

/** Build the full tool set. */
export function buildToolSet(env: ToolEnvironment): ToolDefinition[] {
  return [subParseTool(env), subTranslateTool(env), subMergeTool(env), subExportTool(env), subGlossaryTool(env)]
}

/* ------------------------------------------------------------------ */
/* Cordis-style registration wrapper                                   */
/* ------------------------------------------------------------------ */

export interface CordisContextLike {
  tools?: { register(definition: unknown): () => void }
  provide?(name: string, value: unknown): unknown
  inject?(deps: string[], callback: (sub: CordisContextLike) => void): void
  on?(event: string, callback: () => void): unknown
}

/**
 * Register all tools on a cordis-like context. Returns an array of disposers.
 * Registration is deferred via `ctx.inject(['tools'])` when the tools service
 * is not yet present, and is wire-format agnostic (no @deepseek-ai/cordis
 * imports required).
 */
export function registerToolsOn(
  ctx: CordisContextLike,
  env: ToolEnvironment,
): Array<() => void> {
  const disposers: Array<() => void> = []
  const definitions = buildToolSet(env)

  const registerAll = (target: CordisContextLike): void => {
    if (!target.tools?.register) return
    for (const def of definitions) {
      const dispose = target.tools.register(def)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  }

  if (ctx.inject) {
    ctx.inject(['tools'], (sub) => registerAll(sub))
  } else {
    registerAll(ctx)
  }
  return disposers
}