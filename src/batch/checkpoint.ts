/**
 * Batch checkpointing for resumable runs.
 *
 * A checkpoint is a JSON file mapping relative file paths to their processing
 * state. It is written atomically (temp file + rename) after every state
 * change, so a crashed batch can resume without redoing completed work.
 */

import { readTextFile, writeTextFile } from '../core/encoding.js'
import { existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type FileStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface FileRecord {
  relPath: string
  status: FileStatus
  attempt: number
  error?: string
  outputPaths: string[]
  translatedCount?: number
  costUsd?: number
  updatedAt: string
}

export interface CheckpointData {
  version: 1
  createdAt: string
  updatedAt: string
  files: Record<string, FileRecord>
}

export class Checkpoint {
  readonly path: string
  data: CheckpointData

  constructor(path: string, data?: CheckpointData) {
    this.path = path
    this.data = data ?? {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: {},
    }
  }

  static load(path: string): Checkpoint | null {
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readTextFile(path).text) as Partial<CheckpointData>
      if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null || Array.isArray(parsed.files)) {
        return null
      }
      const data: CheckpointData = {
        version: 1,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        files: parsed.files as Record<string, FileRecord>,
      }
      return new Checkpoint(path, data)
    } catch {
      return null
    }
  }

  touch(): void {
    this.data.updatedAt = new Date().toISOString()
  }

  /** Persist atomically: write the temp file, then rename over the target
   *  (fs.rename replaces existing files on Node/Windows). */
  save(): void {
    this.touch()
    const tmp = `${this.path}.tmp`
    writeTextFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`)
    renameSync(tmp, this.path)
  }

  ensure(relPath: string): FileRecord {
    const existing = this.data.files[relPath]
    if (existing) return existing
    const record: FileRecord = {
      relPath,
      status: 'pending',
      attempt: 0,
      outputPaths: [],
      updatedAt: new Date().toISOString(),
    }
    this.data.files[relPath] = record
    return record
  }

  get(relPath: string): FileRecord | undefined {
    return this.data.files[relPath]
  }

  set(relPath: string, patch: Partial<FileRecord>): FileRecord {
    const record = this.ensure(relPath)
    Object.assign(record, patch, { updatedAt: new Date().toISOString() })
    return record
  }

  markProcessing(relPath: string): void {
    const record = this.set(relPath, { status: 'processing', attempt: (this.ensure(relPath).attempt ?? 0) + 1 })
    void record
  }

  markDone(relPath: string, meta: { outputPaths: string[]; translatedCount: number; costUsd?: number }): void {
    this.set(relPath, {
      status: 'done',
      outputPaths: meta.outputPaths,
      translatedCount: meta.translatedCount,
      costUsd: meta.costUsd,
      error: undefined,
    })
  }

  markFailed(relPath: string, error: string): void {
    this.set(relPath, {
      status: 'failed',
      // Reset the attempt budget so a later resume (retryFailed) gives the
      // file a fresh chance instead of being excluded forever.
      attempt: 0,
      error,
      outputPaths: [],
    })
  }

  reset(relPath: string): void {
    this.data.files[relPath] = {
      relPath,
      status: 'pending',
      attempt: 0,
      outputPaths: [],
      updatedAt: new Date().toISOString(),
    }
  }

  /** Files that still need work (respecting resume semantics set by caller).
   *
   * `pending`, `processing` (a crashed run left it mid-flight) and — when
   * `includeFailed` — `failed` records are candidates; `done` files and failed
   * files that exhausted their budget are skipped. */
  todo(maxAttempts: number, includeFailed: boolean): { relPath: string; record: FileRecord }[] {
    return Object.values(this.data.files)
      .filter((r): r is FileRecord => {
        if (r.status === 'done') return false
        if (r.status === 'processing') return true
        if (r.status === 'failed') {
          return includeFailed && (r.attempt ?? 0) < maxAttempts
        }
        return true // pending
      })
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((r) => ({ relPath: r.relPath, record: r }))
  }

  /** Summary for reporting. */
  summarize(): { done: number; failed: number; pending: number; processing: number } {
    const summary = { done: 0, failed: 0, pending: 0, processing: 0 }
    for (const record of Object.values(this.data.files)) {
      summary[record.status]++
    }
    return summary
  }
}