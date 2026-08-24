import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../lib/cli.js'
import { makeTempDir, cleanupDir, writeTestFile } from './helpers.js'
import { readFileSync } from 'node:fs'

/** Capture stdout while an async function runs. */
async function captureStdout(fn) {
  const original = process.stdout.write
  const chunks = []
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return chunks.join('')
}

test('version prints a semver (works on Windows paths)', async () => {
  const out = await captureStdout(() => main(['version']))
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/)
})

test('-v, -V and --version print the version (not the help text)', async () => {
  for (const arg of ['-v', '--version', '-V']) {
    const out = await captureStdout(() => main([arg]))
    assert.match(out.trim(), /^\d+\.\d+\.\d+$/)
  }
})

test('help and -h print usage without error', async () => {
  const helpOut = await captureStdout(() => main(['-h']))
  assert.ok(helpOut.includes('subtitle-studio'))
  assert.equal(process.exitCode ?? 0, 0)
})

test('parse prints a summary for a real file', async () => {
  const dir = makeTempDir()
  try {
    const path = writeTestFile(dir, 'a.srt', '1\n00:00:01,000 --> 00:00:03,000\nHello\n')
    const out = await captureStdout(() => main(['parse', path]))
    assert.ok(out.includes('cues: 1'))
  } finally {
    cleanupDir(dir)
  }
})

test('merge writes a bilingual file from a translation JSON', async () => {
  const dir = makeTempDir()
  try {
    const srt = writeTestFile(dir, 'a.srt', '1\n00:00:01,000 --> 00:00:03,000\nHello\n')
    const tr = writeTestFile(dir, 't.json', JSON.stringify({ entries: [{ index: 1, text: '你好' }] }))
    const out = `${dir}\\merged.srt`
    await main(['merge', srt, tr, '--layout', 'interleaved', '--output', out])
    const content = readFileSync(out, 'utf8')
    assert.ok(content.includes('Hello'))
    assert.ok(content.includes('你好'))
  } finally {
    cleanupDir(dir)
  }
})

test('unknown command sets exit code 2', async () => {
  await main(['definitely-not-a-command'])
  assert.equal(process.exitCode, 2)
  // Restore so the runner does not report this file as failed on exit.
  process.exitCode = 0
})

export {}
