import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, posix } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertIsolated } from './host-fixture.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const digest = data => createHash('sha256').update(data).digest('hex')

test('offline npm archive contains only declared product files with matching source bytes', async t => {
  assertIsolated()
  const scratch = await mkdtemp(join(tmpdir(), 'bridge-package-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@local/dsh-session-bridge')
  assert(Array.isArray(pkg.files) && pkg.files.length > 0)
  const npm = join(dirname(process.execPath), 'npm')
  const npmVersion = execFileSync(process.execPath, [npm, '--version'], { cwd: root, encoding: 'utf8' }).trim()
  const [packed] = JSON.parse(execFileSync(process.execPath, [
    npm, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', scratch,
  ], { cwd: root, encoding: 'utf8' }))
  assert.equal(packed.name, pkg.name)
  assert.equal(packed.version, pkg.version)
  assert.equal(packed.filename, posix.basename(packed.filename))
  const archive = join(scratch, packed.filename)
  const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trimEnd().split('\n').sort()
  const declared = packed.files.map(({ path }) => 'package/' + path).sort()
  assert.deepEqual(paths, declared)
  assert.equal(new Set(paths).size, paths.length)
  for (const path of ['package.json', 'README.md', 'index.js', 'client.js', 'cordis.patch.yml']) {
    assert(paths.includes('package/' + path), 'Missing required bundle file ' + path)
  }
  const hashes = {}
  for (const entry of paths) {
    assert(/^package\/[A-Za-z0-9_./-]+$/.test(entry), 'Unexpected package entry ' + entry)
    const path = entry.slice('package/'.length)
    assert(!path.split('/').some(part => part.startsWith('.') || part === 'test' || part === 'tests'),
      'Unexpected CI or hidden path in bundle ' + path)
    assert(path === 'package.json' || /^(README|LICEN[CS]E|COPYING)(\.[^/]+)?$/i.test(path) ||
      pkg.files.some(pattern => path === pattern || path.startsWith(pattern + '/') || matchesGlob(path, pattern)),
    'Bundle file outside the manifest allowlist ' + path)
    const sourcePath = join(root, path)
    assert((await lstat(sourcePath)).isFile(), 'Expected a regular source file ' + path)
    const contents = execFileSync('tar', ['-xOzf', archive, '--', entry])
    assert.deepEqual(contents, await readFile(sourcePath), 'Package differs from source for ' + path)
    hashes[path] = digest(contents)
  }
  const body = await readFile(archive)
  assert.equal(body.byteLength, packed.size)
  t.diagnostic('Node ' + process.versions.node + ', npm ' + npmVersion)
  t.diagnostic('Package ' + pkg.version + ' archive SHA-256 ' + digest(body))
  t.diagnostic('File manifest SHA-256 ' + digest(JSON.stringify(hashes)) + ' (' + paths.length + ' files)')
})
