import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { child, fixture, main, name, outsider, until, worker } from './host-fixture.mjs'

const send = (to = worker, text = 'Synthetic message.', request_id = 'synth-message') => ({ to, text, request_id })
const status = (request_id) => ({ action: 'status', request_id })

test('only the current double selection and master switch admit new routes', async t => {
  const host = await fixture(t, {
    enabled: false, selected: [],
    legacySettings: { enabled: true, workflowEnabled: true, allowedSessions: [main, worker, outsider] },
  })
  assert.deepEqual([...host.tools.keys()], [name])
  assert.equal((await host.call(main, send())).error, 'bridge_disabled')
  host.setEnabled(true)
  assert.equal((await host.call(main, send())).error, 'source_not_allowed')
  host.setSelected([main])
  assert.equal((await host.call(main, send())).error, 'destination_not_allowed')
  host.setSelected([worker])
  assert.equal((await host.call(main, send())).error, 'source_not_allowed')
  assert.equal(host.deliveries.length, 0)
  host.setSelected([main, worker])
  assert.deepEqual((await host.call(main)).sessions, [{ id: worker, title: worker }])
  assert.equal((await host.call(main, send())).delivery, 'delivered')
  assert.equal(host.deliveries.length, 1)
})

test('ordinary and relayed turns can conduct a four-message exchange', async t => {
  const host = await fixture(t)
  host.begin(main, 'Synthetic material is ready.')
  for (let i = 0; i < 4; i++) {
    const [from, to] = i % 2 ? [worker, main] : [main, worker]
    const text = 'Synthetic round ' + i
    const sent = await host.call(from, send(to, text, 'synth-round-' + i))
    assert.equal(sent.delivery, 'delivered')
    assert.equal(sent.from, from)
    assert.equal(sent.to, to)
    host.end(from)
    const received = host.receive(to)
    assert.equal(received.id, sent.messageId)
    assert.equal(received.source.kind, 'agent-message')
    assert.equal(received.source.form, 'relay')
    assert.equal(received.source.senderSessionId, from)
    assert(received.content[0].text.endsWith(text))
  }
  host.end(main)
  assert.equal(host.deliveries.length, 4)
  assert.equal(new Set(host.deliveries.map(({ message }) => message.id)).size, 4)
  await until(async () => (await host.call(main, status('synth-round-0'))).processing === 'processed',
    'Receipt must settle after the recipient turn is durable')
})

for (const [description, revoke, expected] of [
  ['switch off', host => host.setEnabled(false), 'bridge_disabled'],
  ['sender unchecked', host => host.setSelected([worker]), 'source_not_allowed'],
  ['recipient unchecked', host => host.setSelected([main]), 'destination_not_allowed'],
  ['sender archived', host => host.archive(main), 'source_not_allowed'],
  ['recipient archived', host => host.archive(worker), 'destination_not_allowed'],
  ['sender evicted', host => host.removeAgent(main), 'source_not_allowed'],
]) {
  test('no append when the route changes during resolution: ' + description, async t => {
    const host = await fixture(t)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    host.faults.resolve = async () => {
      entered.resolve()
      await release.promise
    }
    const pending = host.call(main, send())
    await entered.promise
    revoke(host)
    release.resolve()
    assert.equal((await pending).error, expected)
    assert.equal(host.deliveries.length, 0)
  })
}

test('a hot disable cancels a send suspended in destination resolution', async t => {
  const host = await fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  host.faults.resolve = async () => {
    entered.resolve()
    await release.promise
  }
  const pending = host.call(main, send())
  await entered.promise
  await host.stop()
  release.resolve()
  assert.equal((await pending).error, 'operation_cancelled')
  assert.equal(host.deliveries.length, 0)
})

test('same-named windows require an exact ID and a title change in flight cancels send', async t => {
  const host = await fixture(t)
  host.rename(worker, 'Synthetic Duplicate')
  host.rename(outsider, 'Synthetic Duplicate')
  assert.equal((await host.call(main, send('Synthetic Duplicate'))).error, 'ambiguous_session_title')
  assert.equal((await host.call(main, send(worker))).delivery, 'delivered')
  host.rename(outsider, 'Synthetic Other')
  host.faults.resolve = async () => host.rename(outsider, 'Synthetic Duplicate')
  assert.equal((await host.call(main, send('Synthetic Duplicate', 'Route changed.', 'synth-route'))).error,
    'destination_changed')
  assert.equal(host.deliveries.length, 1)
})

test('only current independent sessions can send or receive and agent identity cannot be forged', async t => {
  const host = await fixture(t, { selected: [main, worker, child] })
  assert.deepEqual((await host.call(main)).sessions.map(({ id }) => id), [worker])
  assert.equal((await host.call(main, send(main))).error, 'destination_not_allowed')
  assert.equal((await host.call(main, send(child))).error, 'destination_not_found')
  assert.equal((await host.call(child, send(main))).error, 'source_not_allowed')
  assert.equal((await host.call(outsider, send(), { agent: { session: { id: main } } })).error, 'source_not_allowed')
  assert.equal((await host.call(main, send('synth-missing'))).error, 'destination_not_found')
  host.faults.stat = async () => undefined
  assert.equal((await host.call(main, send())).error, 'destination_not_available')
  assert.equal(host.deliveries.length, 0)
})

test('overlapping exact retry shares one message ID and changed payload conflicts', async t => {
  const host = await fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  host.faults.flush = async () => {
    entered.resolve()
    await release.promise
    return true
  }
  const pending = host.call(main, send())
  await entered.promise
  const duplicate = await host.call(main, send())
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.delivery, 'unknown')
  assert.equal((await host.call(main, send(worker, 'Changed payload.'))).error, 'request_id_conflict')
  release.resolve()
  const delivered = await pending
  assert.equal(delivered.delivery, 'delivered')
  assert.equal(delivered.messageId, duplicate.messageId)
  await host.restart()
  assert.equal((await host.call(main, send())).messageId, delivered.messageId)
  assert.equal(host.deliveries.length, 1)
})

for (const [description, inject] of [
  ['throw after append', host => { host.faults.afterFollowup = () => { throw new Error('synthetic post-append fault') } }],
  ['flush returns false', host => { host.faults.flush = async () => false }],
]) {
  test('uncertain delivery cannot append a second time after restart: ' + description, async t => {
    const host = await fixture(t)
    inject(host)
    const original = await host.call(main, send())
    assert.equal(original.delivery, 'unknown')
    await host.restart()
    const retried = await host.call(main, send())
    assert.equal(retried.duplicate, true)
    assert.equal(retried.messageId, original.messageId)
    assert.equal(host.deliveries.length, 1)
  })
}

test('legacy receipts remain owner-scoped and readable with the master switch off', async t => {
  const host = await fixture(t, { enabled: false, selected: [] })
  const original = {
    requestId: 'synth-old-receipt', messageId: 'synth-old-id', from: main, to: worker, delivery: 'delivered',
  }
  const key = createHash('sha256').update(JSON.stringify([main, original.requestId])).digest('hex')
  const file = join(host.receipts, key + '.json')
  const data = JSON.stringify(original) + '\n'
  await writeFile(file, data)
  assert.equal((await host.call(main, status(original.requestId))).messageId, original.messageId)
  assert.equal((await host.call(worker, status(original.requestId))).error, 'receipt_not_found')
  await host.restart()
  assert.equal(await readFile(file, 'utf8'), data)
  assert.equal(host.deliveries.length, 0)
})

test('unrecognized host does not register an executable bridge tool', async t => {
  const host = await fixture(t, { hostVersion: '0.2.2-synth.1' })
  assert.equal(host.tools.size, 0)
  assert.equal(host.deliveries.length, 0)
})
