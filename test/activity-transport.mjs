import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createActivity } from '../activity.js'
import { openLedger } from '../workflow-ledger.js'

test('activity keeps real active deadlines, retires terminal routes, and bounds slow streams', async (t) => {
  let time = 1_000_000
  t.mock.method(Date, 'now', () => time)
  const allowed = new Set(['owner', 'worker'])
  const activity = createActivity((id) => allowed.has(id))
  let route
  activity.register({
    connection: { fetch: { register(value) { route = value } } },
    effect(start) { t.after(start()) },
  })
  const request = () => new Request('http://localhost' + route.path)
  const send = (key, state, keepUntil) => activity.record({
    key, from: 'owner', to: 'worker', kind: 'task', state, keepUntil,
  })
  const frame = async (reader) => {
    const { value, done } = await reader.read()
    assert.equal(done, false)
    return JSON.parse(new TextDecoder().decode(value).split('\n').find((line) => line.startsWith('data: ')).slice(6))
  }
  const deadline = time + 30 * 60_000
  send('queued', 'queued', deadline)
  time += 120_001
  const queued = route.fetch(request()).body.getReader()
  assert.deepEqual((await frame(queued)).rows.map(({ state }) => state), ['queued'])
  await queued.cancel()

  send('queued', 'executing', deadline)
  time += 120_001
  const executing = route.fetch(request()).body.getReader()
  assert.deepEqual((await frame(executing)).rows.map(({ state }) => state), ['executing'])
  send('queued', 'failed')
  assert.deepEqual((await frame(executing)).rows.map(({ state }) => state), ['failed'])
  await executing.cancel()
  time += 18_001

  const readers = Array.from({ length: 8 }, () => route.fetch(request()).body.getReader())
  assert.equal(route.fetch(request()).status, 503)
  for (let i = 0; i < 160; i++) send('active-' + i, 'queued', deadline)
  await new Promise(queueMicrotask)
  for (const reader of readers) assert.equal((await frame(reader)).rows.length, 0)
  const pending = readers.map((reader) => frame(reader))
  send('newest', 'queued', deadline)
  for (const state of await Promise.all(pending)) assert.equal(state.rows.length, 128)
  allowed.delete('worker')
  send('revoked', 'queued', deadline)
  for (const reader of readers) {
    assert.equal((await frame(reader)).rows.length, 0)
    await reader.cancel()
  }
  const controller = new AbortController()
  const aborted = route.fetch(new Request(request(), { signal: controller.signal })).body.getReader()
  await frame(aborted)
  controller.abort()
  assert.equal((await aborted.read()).done, true)
})

test('an activity observer failure cannot invalidate a committed workflow write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-activity-observer-'))
  const ledger = openLedger(dir, () => { throw new Error('synthetic observer failure') })
  t.after(async () => {
    ledger.close()
    await rm(dir, { recursive: true, force: true })
  })
  assert.equal(ledger.change(({ grants }) => {
    grants.synthetic = { state: 'active' }
    return { changed: true, value: 'committed' }
  }), 'committed')
  assert.deepEqual(ledger.read().grants.synthetic, { state: 'active' })
})
