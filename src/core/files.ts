/** Whole-file publication: a same-directory temporary file is written completely, then renamed over the target. */
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Replace `path` with `content` through one unique temporary file in the same directory, so another reader
 * sees either the complete old file or the complete new one and never a partial write. This is one file at a
 * time: there is no transaction across files, no fsync or power-loss guarantee, and no retry loop.
 */
export function publishFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
