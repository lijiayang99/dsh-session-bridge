import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createActivity } from '../../activity.js'
import { openLedger } from '../../workflow-ledger.js'
import '../../test/activity-transport.mjs'

async function frame(reader, eventType) {
  const { done, value } = await reader.read()
  assert.equal(done, false)
  const lines = new TextDecoder().decode(value).trimEnd().split('\n')
  assert.equal(lines[0].startsWith('event:'), eventType === 'baseline')
  if (eventType === 'baseline') assert.equal(lines.shift(), 'event: baseline')
  assert.equal(lines.length, 1)
  assert(lines[0].startsWith('data: '))
  return JSON.parse(lines[0].slice(6))
}

test('activity numbers only actual attempts and reconnects with an owner-filtered baseline', async t => {
  const allowed = new Set(['owner', 'worker'])
  const activity = createActivity(id => allowed.has(id))
  let fetchRoute
  activity.register({
    connection: { fetch: { register(route) { fetchRoute = route } } },
    effect(start) { t.after(start()) },
  })
  const reader = () => fetchRoute.fetch(new Request('http://localhost' + fetchRoute.path)).body.getReader()
  const task = { key: 'private-attempt-identifier', from: 'owner', to: 'worker', kind: 'task' }
  const result = { key: 'private-result-identifier', from: 'worker', to: 'owner', kind: 'result' }
  const live = reader()
  assert.deepEqual(await frame(live, 'baseline'), { sequence: 0, rows: [] })

  activity.record({ ...task, state: 'queued' })
  assert.deepEqual(await frame(live), { sequence: 0,
    rows: [{ id: 1, from: 'owner', to: 'worker', kind: 'task', state: 'queued' }] })
  activity.record({ ...task, state: 'sending' }, true)
  activity.record({ ...task, state: 'sending' }, true)
  activity.record({ ...task, state: 'delivered' })
  assert.deepEqual(await frame(live), { sequence: 1,
    rows: [{ id: 1, from: 'owner', to: 'worker', kind: 'task', state: 'delivered', flight: 1 }] })

  activity.record({ ...result, state: 'sending' }, true)
  const returned = await frame(live)
  assert.equal(returned.sequence, 2)
  assert.deepEqual(returned.rows[0], { id: 2, from: 'worker', to: 'owner', kind: 'result', state: 'sending', flight: 2 })
  await live.cancel()

  const reconnected = reader()
  assert.deepEqual(await frame(reconnected, 'baseline'), returned)
  await reconnected.cancel()
  allowed.delete('worker')
  const revoked = reader()
  assert.deepEqual(await frame(revoked, 'baseline'), { sequence: 2, rows: [] })
  await revoked.cancel()
})

test('activity observes an archive-only reconciliation after the history write commits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-activity-history-'))
  const observed = []
  const ledger = openLedger(dir, (_state, archived) => {
    observed.push(...archived.map(job => ({
      id: job.id,
      committed: ledger.history.job(job.id).wake.state,
    })))
  })
  t.after(async () => {
    ledger.close()
    await rm(dir, { recursive: true, force: true })
  })
  const entry = { id: 'synthetic-attempt', key: 'owner:synthetic-task', item: 'execute', attempt: 1,
    wake: { state: 'uncertain' } }
  ledger.change(({ jobs }) => {
    jobs[entry.id] = entry
    return { changed: true }
  })
  ledger.change(({ jobs }, archive) => {
    archive.job(jobs[entry.id])
    delete jobs[entry.id]
    return { changed: true }
  })
  assert.deepEqual(observed, [{ id: entry.id, committed: 'uncertain' }])

  ledger.change((_state, archive) => {
    archive.job({ ...entry, wake: { state: 'reconciled' } })
    return { changed: false }
  })
  assert.equal(ledger.history.job(entry.id).wake.state, 'reconciled')
  assert.deepEqual(observed, [
    { id: entry.id, committed: 'uncertain' },
    { id: entry.id, committed: 'reconciled' },
  ])
})
