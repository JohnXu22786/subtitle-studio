#!/usr/bin/env node
/**
 * CLI launcher for subtitle-studio.
 * Delegates to the compiled ESM entry in lib/.
 */
import { main } from '../lib/cli.js'

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`subtitle-studio: ${message}\n`)
  process.exitCode = 1
})