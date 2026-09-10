/**
 * Copies the minimal Pyodide runtime out of node_modules into public/pyodide.
 *
 * Pyodide is served from our own origin rather than a CDN so that the application
 * works offline, loads deterministically for a pinned version, and is not exposed to
 * a third-party outage. Only the files needed to boot the interpreter are copied;
 * the full distribution (which includes hundreds of optional packages) is not.
 */
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const REQUIRED_FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

const require = createRequire(import.meta.url)
const pyodideDir = dirname(require.resolve('pyodide/package.json'))
const { version } = JSON.parse(await readFile(join(pyodideDir, 'package.json'), 'utf8'))

const target = join(process.cwd(), 'public', 'pyodide')
const stampPath = join(target, '.version')

const existingStamp = await readFile(stampPath, 'utf8').catch(() => null)
if (existingStamp === version) {
  console.log(`pyodide ${version} already present in public/pyodide`)
  process.exit(0)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

for (const file of REQUIRED_FILES) {
  await cp(join(pyodideDir, file), join(target, file))
}
await writeFile(stampPath, version, 'utf8')

console.log(`copied pyodide ${version} (${REQUIRED_FILES.length} files) to public/pyodide`)
