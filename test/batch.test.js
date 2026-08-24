import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBatch, ensureOutputDir, listSubtitleFiles, estimateBatchCost } from '../lib/batch/batch.js'
import { Checkpoint } from '../lib/batch/checkpoint.js'
import { createLlmClient } from '../lib/translate/llm.js'
import { parseSrt } from '../lib/core/srt.js'
import { stubFetch, completionJson, makeTempDir, cleanupDir, writeTestFile } from './helpers.js'

const SRT_ONE = '1\n00:00:01,000 --> 00:00:03,000\nFile one\n'
const SRT_TWO = '1\n00:00:00,000 --> 00:00:02,000\nFile two\n'

function translationResponse(cueText) {
  return completionJson(`[{"i":1,"t":"${cueText}"}]`)
}

test('listSubtitleFiles respects extensions and recursion', async () => {
  const dir = makeTempDir()
  try {
    writeTestFile(dir, 'a.srt', SRT_ONE)
    writeTestFile(join(dir, 'sub'), 'b.vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n')
    writeTestFile(dir, 'c.ass', 'ignore me')
    const flat = await listSubtitleFiles(dir, ['.srt', '.vtt'], false)
    assert.deepEqual(flat.map((f) => f.rel).sort(), ['a.srt'])
    const recursive = await listSubtitleFiles(dir, ['.srt', '.vtt'], true)
    assert.deepEqual(recursive.map((f) => f.rel).sort(), ['a.srt', 'sub/b.vtt'])
  } finally {
    cleanupDir(dir)
  }
})

test('runBatch translates files, writes outputs, and records a checkpoint', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'out')
  try {
    writeTestFile(dir, 'a.srt', SRT_ONE)
    writeTestFile(dir, 'b.srt', SRT_TWO)
    ensureOutputDir(outDir)

    const stub = stubFetch([
      translationResponse('文件一'),
      translationResponse('文件二'),
    ])
    try {
      const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x', apiKey: 'k', jsonMode: false })
      const summary = await runBatch(
        {
          client,
          targets: ['zh'],
          source: 'en',
          model: 'deepseek-chat',
          outputDir: outDir,
          inputDir: dir,
          extensions: ['.srt'],
          recursive: true,
          concurrency: 2,
          maxRetries: 1,
          retryDelayMs: 1,
          checkpointPath: join(dir, 'cp.json'),
          resume: false,
          retryFailed: true,
          jsonMode: false,
          chunkChars: 4000,
          layout: 'stacked',
          writeTranslationJson: true,
          persistPartial: false,
        },
        { info: () => undefined },
      )
      assert.equal(summary.scanned, 2)
      assert.equal(summary.ok, 2)
      assert.equal(summary.failed, 0)
      assert.ok(summary.outputs.some((p) => p.endsWith('a.bilingual.srt')))
      assert.ok(summary.outputs.some((p) => p.endsWith('a.zh.translation.json')))

      const mergedA = readFileSync(join(outDir, 'a.bilingual.srt'), 'utf8')
      assert.ok(mergedA.includes('File one'))
      assert.ok(mergedA.includes('文件一'))

      const cp = Checkpoint.load(join(dir, 'cp.json'))
      assert.ok(cp)
      assert.equal(cp.get('a.srt')?.status, 'done')
      assert.equal(cp.get('b.srt')?.status, 'done')
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('resume skips files already marked done', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'out')
  try {
    writeTestFile(dir, 'a.srt', SRT_ONE)
    ensureOutputDir(outDir)

    const cpPath = join(dir, 'cp.json')
    const cp = new Checkpoint(cpPath)
    cp.markDone('a.srt', { outputPaths: ['x'], translatedCount: 1, costUsd: 0 })
    cp.save()

    // With resume, the done file is skipped so no LLM request happens.
    let fetches = 0
    const stub = stubFetch([])
    try {
      const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x', apiKey: 'k', jsonMode: false })
      const options = {
        client,
        targets: ['zh'],
        source: 'en',
        model: 'deepseek-chat',
        outputDir: outDir,
        inputDir: dir,
        extensions: ['.srt'],
        recursive: true,
        concurrency: 2,
        maxRetries: 1,
        retryDelayMs: 1,
        jsonMode: false,
        chunkChars: 4000,
        layout: 'stacked',
        writeTranslationJson: false,
        persistPartial: false,
        resume: true,
        retryFailed: true,
      }
      const summary = await runBatch({ ...options, checkpointPath: cpPath, resume: true })
      fetches = stub.requests.length
      assert.equal(fetches, 0)
      assert.equal(summary.skippedDone, 1)
      assert.equal(summary.ok, 0)
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('files that never succeed are marked failed after bounded retries', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'out')
  try {
    writeTestFile(dir, 'bad.srt', 'not even a subtitle file\n')
    ensureOutputDir(outDir)

    const stub = stubFetch([{ status: 400, body: '{"error":{"message":"nope"}}' }])
    try {
      const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x', apiKey: 'k', jsonMode: false })
      const summary = await runBatch(
        {
          client,
          targets: ['zh'],
          source: 'en',
          model: 'deepseek-chat',
          outputDir: outDir,
          inputDir: dir,
          extensions: ['.srt'],
          recursive: true,
          concurrency: 1,
          maxRetries: 2,
          retryDelayMs: 1,
          jsonMode: false,
          chunkChars: 4000,
          layout: 'stacked',
          writeTranslationJson: false,
          persistPartial: false,
          checkpointPath: join(dir, 'cp.json'),
          resume: false,
          retryFailed: true,
        },
        { info: () => undefined },
      )
      assert.equal(summary.failed, 1)
      assert.equal(summary.ok, 0)
      const cp = Checkpoint.load(join(dir, 'cp.json'))
      assert.equal(cp?.get('bad.srt')?.status, 'failed')
      // markFailed resets the attempt budget so a later resume can retry it.
      assert.equal(cp?.get('bad.srt')?.attempt, 0)
      assert.ok((cp?.get('bad.srt')?.error ?? '').length > 0)
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('estimateBatchCost sums estimated tokens without calling the LLM', async () => {
  const dir = makeTempDir()
  try {
    writeTestFile(dir, 'a.srt', SRT_ONE)
    const stub = stubFetch([])
    try {
      const est = await estimateBatchCost({
        inputDir: dir,
        extensions: ['.srt'],
        recursive: false,
        targets: ['zh', 'fr'],
        source: 'en',
        model: 'deepseek-chat',
      })
      assert.equal(est.files.length, 1)
      assert.ok(est.totals.inputTokens > 0)
      assert.ok(est.totals.totalUsd >= 0)
      assert.equal(stub.requests.length, 0)
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('Checkpoint atomic save/reload round-trips state', () => {
  const dir = makeTempDir()
  try {
    const path = join(dir, 'cp.json')
    const cp = new Checkpoint(path)
    cp.markProcessing('a.srt')
    cp.markDone('a.srt', { outputPaths: ['o/a.srt'], translatedCount: 3, costUsd: 0.01 })
    cp.markFailed('b.srt', 'boom')
    cp.save()
    const loaded = Checkpoint.load(path)
    assert.equal(loaded?.get('a.srt')?.status, 'done')
    assert.equal(loaded?.get('b.srt')?.status, 'failed')
    assert.deepEqual(loaded?.get('a.srt')?.outputPaths, ['o/a.srt'])
    assert.equal(loaded?.summarize().done, 1)
    assert.equal(loaded?.summarize().failed, 1)
  } finally {
    cleanupDir(dir)
  }
})

test('Checkpoint.todo() re-queues processing records and respects retryFailed', () => {
  const dir = makeTempDir()
  try {
    const cp = new Checkpoint(join(dir, 'cp.json'))
    cp.markProcessing('crash.srt') // left mid-flight by a previous run
    cp.markDone('done.srt', { outputPaths: [], translatedCount: 1 })
    cp.markFailed('bad.srt', 'boom') // attempt budget was reset by markFailed
    const withFailed = cp.todo(2, true).map((t) => t.relPath).sort()
    assert.deepEqual(withFailed, ['bad.srt', 'crash.srt'])
    const withoutFailed = cp.todo(2, false).map((t) => t.relPath).sort()
    assert.deepEqual(withoutFailed, ['crash.srt'])
  } finally {
    cleanupDir(dir)
  }
})

test('runBatch reports ok even without a checkpoint', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'out')
  try {
    writeTestFile(dir, 'a.srt', SRT_ONE)
    ensureOutputDir(outDir)
    const stub = stubFetch([translationResponse('文件一')])
    try {
      const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x', apiKey: 'k', jsonMode: false })
      const summary = await runBatch(
        {
          client,
          targets: ['zh'],
          source: 'en',
          model: 'deepseek-chat',
          outputDir: outDir,
          inputDir: dir,
          extensions: ['.srt'],
          recursive: true,
          concurrency: 1,
          maxRetries: 1,
          retryDelayMs: 1,
          jsonMode: false,
          chunkChars: 4000,
          layout: 'stacked',
          writeTranslationJson: false,
          persistPartial: false,
          checkpointPath: undefined,
          resume: false,
          retryFailed: false,
        },
        { info: () => undefined },
      )
      assert.equal(summary.ok, 1)
      assert.equal(summary.failed, 0)
      assert.equal(summary.skippedDone, 0)
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('batch never re-ingests its own output directory', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'out')
  try {
    writeTestFile(dir, 'real.srt', SRT_ONE)
    writeTestFile(outDir, 'stale.bilingual.srt', SRT_ONE) // a previous run's artifact
    ensureOutputDir(outDir)

    const stub = stubFetch([translationResponse('真文件')])
    try {
      const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x', apiKey: 'k', jsonMode: false })
      const summary = await runBatch(
        {
          client,
          targets: ['zh'],
          source: 'en',
          model: 'deepseek-chat',
          outputDir: outDir,
          inputDir: dir,
          extensions: ['.srt'],
          recursive: true,
          concurrency: 1,
          maxRetries: 1,
          retryDelayMs: 1,
          jsonMode: false,
          chunkChars: 4000,
          layout: 'stacked',
          writeTranslationJson: false,
          persistPartial: false,
          checkpointPath: undefined,
          resume: false,
          retryFailed: false,
        },
        { info: () => undefined },
      )
      // Only the real input is scanned; the stale output is not fed back.
      assert.equal(summary.scanned, 1)
      assert.equal(stub.requests.length, 1)
      assert.ok(!summary.outputs.some((p) => p.includes('stale.bilingual.bilingual')))
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('batch mirrors subdirectories so same-named files never collide', async () => {
  const dir = makeTempDir()
  const outDir = join(dir, 'out')
  try {
    writeTestFile(join(dir, 'a'), 'clip.srt', '1\n00:00:01,000 --> 00:00:02,000\nClip A\n')
    writeTestFile(join(dir, 'b'), 'clip.srt', '1\n00:00:01,000 --> 00:00:02,000\nClip B\n')
    ensureOutputDir(outDir)

    const stub = stubFetch([translationResponse('剪辑甲'), translationResponse('剪辑乙')])
    try {
      const client = createLlmClient({ provider: 'openai', baseUrl: 'http://x', apiKey: 'k', jsonMode: false })
      const summary = await runBatch(
        {
          client,
          targets: ['zh'],
          source: 'en',
          model: 'deepseek-chat',
          outputDir: outDir,
          inputDir: dir,
          extensions: ['.srt'],
          recursive: true,
          concurrency: 2,
          maxRetries: 1,
          retryDelayMs: 1,
          jsonMode: false,
          chunkChars: 4000,
          layout: 'stacked',
          writeTranslationJson: true,
          persistPartial: false,
          checkpointPath: undefined,
          resume: false,
          retryFailed: false,
        },
        { info: () => undefined },
      )
      assert.equal(summary.ok, 2)
      const aOut = readFileSync(join(outDir, 'a', 'clip.bilingual.srt'), 'utf8')
      const bOut = readFileSync(join(outDir, 'b', 'clip.bilingual.srt'), 'utf8')
      assert.ok(aOut.includes('Clip A') && aOut.includes('剪辑甲'))
      assert.ok(bOut.includes('Clip B') && bOut.includes('剪辑乙'))
      assert.equal(readdirSync(outDir).filter((n) => n.endsWith('.bilingual.srt')).length, 0) // not flattened into out/
    } finally {
      stub.restore()
    }
  } finally {
    cleanupDir(dir)
  }
})

test('Checkpoint atomic save overwrites cleanly with no temp leftover', () => {
  const dir = makeTempDir()
  try {
    const path = join(dir, 'cp.json')
    const cp = new Checkpoint(path)
    cp.markDone('a.srt', { outputPaths: [], translatedCount: 1 })
    cp.save()
    const cp2 = new Checkpoint(path)
    cp2.markDone('b.srt', { outputPaths: [], translatedCount: 1 })
    cp2.save()
    const entries = readdirSync(dir)
    assert.ok(entries.includes('cp.json'))
    assert.ok(!entries.includes('cp.json.tmp'))
    const loaded = Checkpoint.load(path)
    assert.equal(loaded?.get('b.srt')?.status, 'done')
  } finally {
    cleanupDir(dir)
  }
})

test('Checkpoint summary counts every status bucket', () => {
  const dir = makeTempDir()
  try {
    const cp = new Checkpoint(join(dir, 'cp.json'))
    cp.markProcessing('a.srt')
    cp.markDone('b.srt', { outputPaths: [], translatedCount: 1 })
    cp.markFailed('c.srt', 'x')
    cp.ensure('d.srt')
    const s = cp.summarize()
    assert.equal(s.processing, 1)
    assert.equal(s.done, 1)
    assert.equal(s.failed, 1)
    assert.equal(s.pending, 1)
  } finally {
    cleanupDir(dir)
  }
})

export {}
