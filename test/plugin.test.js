import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolSet, registerToolsOn, normalizeTranslations } from '../lib/tools/tools.js'
import { apply, name as pluginName } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'
import { stubFetch, completionJson, makeTempDir, cleanupDir, writeTestFile } from './helpers.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSrt } from '../lib/core/srt.js'

const SRT = '1\n00:00:01,000 --> 00:00:04,000\nHello world.\n\n2\n00:00:05,000 --> 00:00:08,000\nBye now.\n'

function env(cwd) {
  return {
    config: resolveConfig({
      llm: { baseUrl: 'http://x', apiKey: 'k', jsonMode: false },
      targetLanguages: ['zh'],
    }),
    seam: undefined,
    cwd,
  }
}

test('buildToolSet exposes exactly the five subtitle tools', () => {
  const defs = buildToolSet(env(process.cwd()))
  const names = defs.map((d) => d.name).sort()
  assert.deepEqual(names, [
    'sub_export',
    'sub_glossary',
    'sub_merge',
    'sub_parse',
    'sub_translate',
  ])
  for (const def of defs) {
    assert.equal(typeof def.execute, 'function')
    assert.ok(def.output && def.output.schema)
    assert.equal(typeof def.output.render, 'function')
  }
})

test('sub_parse tool parses a file into structured cues', async () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'a.srt', SRT)
    const tool = buildToolSet(env(dir)).find((t) => t.name === 'sub_parse')
    const result = await tool.execute({ path }, {})
    assert.equal(result.cueCount, 2)
    assert.equal(result.format, 'srt')
    assert.equal(result.cues[0].text, 'Hello world.')
    assert.equal(result.cues[1].start, 5000)
    assert.deepEqual(result.issues, [])
  } finally {
    cleanupDir(dir)
  }
})

test('sub_merge tool merges and writes an output file', async () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'a.srt', SRT)
    const transPath = writeTestFile(
      dir,
      'tr.json',
      JSON.stringify({ entries: [{ index: 1, text: '你好', source: '' }, { index: 2, text: '再见', source: '' }] }),
    )
    const outPath = join(dir, 'bilingual.srt')
    const tool = buildToolSet(env(dir)).find((t) => t.name === 'sub_merge')
    const result = await tool.execute(
      { sourcePath: path, translation: transPath, layout: 'stacked', outputPath: outPath },
      {},
    )
    assert.equal(result.cueCount, 2)
    assert.equal(result.outputPath, outPath)
    const content = readFileSync(outPath, 'utf8')
    assert.ok(content.includes('Hello world.\n你好'))
  } finally {
    cleanupDir(dir)
  }
})

test('sub_export tool converts an SRT file to VTT', async () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'a.srt', SRT)
    const outPath = join(dir, 'out.vtt')
    const tool = buildToolSet(env(dir)).find((t) => t.name === 'sub_export')
    const result = await tool.execute({ inputPath: path, outputPath: outPath, format: 'vtt' }, {})
    assert.equal(result.format, 'vtt')
    assert.ok(readFileSync(outPath, 'utf8').startsWith('WEBVTT'))
  } finally {
    cleanupDir(dir)
  }
})

test('sub_glossary tool adds, lists, and removes entries', async () => {
  const dir = makeTempDir()
  try {
    const gPath = writeTestFile(dir, 'g.json', '{"name":"g","entries":[]}')
    const tool = buildToolSet(env(dir)).find((t) => t.name === 'sub_glossary')

    const added = await tool.execute(
      { action: 'add', glossaryPath: gPath, entry: { source: 'door', target: '门', scope: 'zh' } },
      {},
    )
    assert.equal(added.count, 1)
    assert.equal(added.removed, 0)

    const listed = await tool.execute({ action: 'list', glossaryPath: gPath }, {})
    assert.equal(listed.count, 1)
    assert.equal(listed.entries[0].target, '门')

    const removed = await tool.execute({ action: 'remove', glossaryPath: gPath, source: 'door' }, {})
    assert.equal(removed.count, 0)
    assert.equal(removed.removed, 1)
  } finally {
    cleanupDir(dir)
  }
})

test('sub_translate tool translates through a mocked endpoint', async () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'a.srt', SRT)
    const stub = stubFetch([completionJson('[{"i":1,"t":"你好"},{"i":2,"t":"再见"}]')])
    try {
      const tool = buildToolSet(env(dir)).find((t) => t.name === 'sub_translate')
      const result = await tool.execute({ path, target: 'zh' }, {})
      assert.equal(result.cueCount, 2)
      assert.equal(result.translatedCount, 2)
      assert.deepEqual(result.missing, [])
      assert.equal(result.translated[0].text, '你好')
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('normalizeTranslations accepts array, entries, and index→text forms', () => {
  assert.deepEqual([...normalizeTranslations([{ index: 1, text: 'a' }, { i: 2, t: 'b' }])], [
    [1, 'a'],
    [2, 'b'],
  ])
  assert.deepEqual([...normalizeTranslations({ entries: [{ index: 5, text: 'e' }] })], [[5, 'e']])
  assert.deepEqual([...normalizeTranslations({ '3': 'c', '4': 'd' })], [
    [3, 'c'],
    [4, 'd'],
  ])
})

test('apply registers tools on a cordis-like context and provides a service', () => {
  const registered = []
  let provided = null
  let disposeCleanup = false
  const ctx = {
    inject: (deps, cb) => {
      assert.deepEqual(deps, ['tools'])
      cb(ctx)
    },
    tools: {
      register: (def) => {
        registered.push(def)
        return () => undefined
      },
    },
    provide: (name, value) => {
      provided = { name, value }
      return () => undefined
    },
    on: (event, cb) => {
      if (event === 'dispose') disposeCleanup = true
      return undefined
    },
    llm: undefined,
  }
  apply(ctx, {})
  assert.equal(registered.length, 5)
  assert.equal(provided?.name, 'subtitleStudio')
  assert.equal(typeof provided?.value?.translate, 'function')
  assert.equal(disposeCleanup, true)
})

test('service translate works end-to-end through the provided API', async () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'a.srt', SRT)
    const stub = stubFetch([completionJson('{"translations":[{"i":1,"t":"你好"},{"i":2,"t":"再见"}]}')])
    try {
      let service
      const ctx = {
        inject: (_deps, cb) => cb(ctx),
        tools: { register: () => () => undefined },
        provide: (name, value) => {
          service = value
        },
      }
      apply(ctx, { llm: { baseUrl: 'http://x', apiKey: 'k', jsonMode: false } })
      const doc = service.parse(path).document
      const outcomes = await service.translate(doc, ['zh'], { source: 'en' })
      assert.equal(outcomes[0].entries.length, 2)
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('plugin exposes a stable name and works when tools are already present', () => {
  assert.equal(pluginName, 'subtitle-studio')
  const registered = []
  apply(
    {
      // no inject method: register against existing tools directly
      tools: { register: (def) => { registered.push(def); return () => undefined } },
      on: () => undefined,
    },
    {},
  )
  assert.equal(registered.length, 5)
})

export {}
