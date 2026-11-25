/** publishFile: a complete temporary file is renamed over the target, even when a real process is killed mid-write. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { publishFile } from '../../src/core/files.ts'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const temporaryDirectory = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'memory-files-'))
  directories.push(path)
  return path
}

const oldContent = '旧内容：完整旧文件\n'
const newContent = '新内容：完整新文件\n第二行\n'

it('replaces a file through a same-directory temporary file and leaves no temporary behind', () => {
  const root = temporaryDirectory()
  const target = join(root, 'task.md')
  writeFileSync(target, oldContent, 'utf8')
  publishFile(target, newContent)
  expect(readFileSync(target, 'utf8')).toBe(newContent)
  expect(readdirSync(root)).toEqual(['task.md'])

  const fresh = join(root, 'new.md')
  publishFile(fresh, '完整内容')
  expect(readFileSync(fresh, 'utf8')).toBe('完整内容')
  expect(readdirSync(root).sort()).toEqual(['new.md', 'task.md'])
})

it('cleans the temporary file when the rename fails', () => {
  const root = temporaryDirectory()
  const directoryTarget = join(root, 'target')
  mkdirSync(directoryTarget)
  expect(() => publishFile(directoryTarget, newContent)).toThrow()
  expect(readdirSync(root)).toEqual(['target'])
})

interface Interrupted {
  targetContent: string
  temporaryContent: string | undefined
}

const waitForFile = async (path: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  return false
}

const preload = `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const target = process.env.PUBLISH_TARGET
const mode = process.env.PUBLISH_MODE
const ready = process.env.PUBLISH_READY
const writeFileSync = fs.writeFileSync.bind(fs)
const renameSync = fs.renameSync.bind(fs)
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)

if (mode === 'write') {
  fs.writeFileSync = (file, data, options) => {
    if (file !== target && typeof file === 'string' && file.endsWith('.tmp')) {
      writeFileSync(file, String(data).slice(0, 4))
      writeFileSync(ready, 'ready')
      pause()
    }
    return writeFileSync(file, data, options)
  }
} else if (mode === 'before-rename') {
  fs.renameSync = (from, to) => {
    if (to === target) {
      writeFileSync(ready, 'ready')
      pause()
    }
    return renameSync(from, to)
  }
} else if (mode === 'after-rename') {
  fs.renameSync = (from, to) => {
    const result = renameSync(from, to)
    if (to === target) {
      writeFileSync(ready, 'ready')
      pause()
    }
    return result
  }
}
syncBuiltinESMExports()
`

const child = `const { publishFile } = await import(process.env.PUBLISH_MODULE)
publishFile(process.env.PUBLISH_TARGET, process.env.PUBLISH_CONTENT)
`

const interrupt = async (mode: 'write' | 'before-rename' | 'after-rename'): Promise<Interrupted> => {
  const root = temporaryDirectory()
  const target = join(root, 'task.md')
  writeFileSync(target, oldContent, 'utf8')
  const ready = join(root, 'ready')
  const preloadPath = join(root, 'preload.mjs')
  const childPath = join(root, 'child.mjs')
  writeFileSync(preloadPath, preload, 'utf8')
  writeFileSync(childPath, child, 'utf8')
  const running = spawn(process.execPath,
    ['--experimental-transform-types', '--import', pathToFileURL(preloadPath).href, childPath], {
      env: {
        ...process.env,
        PUBLISH_TARGET: target,
        PUBLISH_CONTENT: newContent,
        PUBLISH_MODE: mode,
        PUBLISH_READY: ready,
        PUBLISH_MODULE: new URL('../../src/core/files.ts', import.meta.url).href,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  let stderr = ''
  running.stderr?.setEncoding('utf8')
  running.stderr?.on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>((resolve, reject) => {
    running.once('error', reject)
    running.once('exit', code => resolve(code))
  })
  const reached = await waitForFile(ready, 15000)
  if (!reached) {
    running.kill('SIGKILL')
    await exited.catch(() => undefined)
    throw new Error(`child did not reach the ${mode} breakpoint: ${stderr}`)
  }
  running.kill('SIGKILL')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit after SIGKILL')), 5000)
    exited.then(() => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(error) })
  })
  const temporaryName = readdirSync(root).find(name => name.endsWith('.tmp'))
  return {
    targetContent: readFileSync(target, 'utf8'),
    temporaryContent: temporaryName ? readFileSync(join(root, temporaryName), 'utf8') : undefined,
  }
}

it('keeps the published file complete when a real process is killed during write, before rename and after rename',
  async () => {
    const duringWrite = await interrupt('write')
    expect(duringWrite.targetContent).toBe(oldContent)
    expect(duringWrite.temporaryContent).toBeDefined()
    expect(newContent.startsWith(duringWrite.temporaryContent ?? '')).toBe(true)
    expect(duringWrite.temporaryContent).not.toBe(newContent)

    const beforeRename = await interrupt('before-rename')
    expect(beforeRename.targetContent).toBe(oldContent)
    expect(beforeRename.temporaryContent).toBe(newContent)

    const afterRename = await interrupt('after-rename')
    expect(afterRename.targetContent).toBe(newContent)
    expect(afterRename.temporaryContent).toBeUndefined()
  }, 60000)
