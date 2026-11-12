import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { receiptLog, registerStatusLog } from '../../workflow-view.js'
import { assertIsolated } from './host-fixture.mjs'

test('status log projects only this session metadata from historical receipts', async t => {
  assertIsolated()
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-bridge-status-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const time = '2026-11-12T00:00:00.000Z'
  const hidden = 'Synthetic content and raw identifiers must stay out of the status log.'
  const owner = 'synthetic-status-owner'
  const worker = 'synthetic-status-worker'
  const unrelated = 'synthetic-status-unrelated'
  const receipt = (from, to) => ({
    from, to, requestId: hidden, messageId: 'synthetic-hidden-message-id',
    payloadHash: hidden, text: hidden, at: time, delivery: 'delivered',
  })
  const file = join(directory, 'a'.repeat(64) + '.json')
  await writeFile(file, JSON.stringify(receipt(owner, worker)))
  await writeFile(file.replace(/\.json$/, '.turn.json'), JSON.stringify({
    messageId: 'synthetic-hidden-message-id', at: time, processing: 'failed', endReason: hidden,
  }))
  await writeFile(join(directory, 'b'.repeat(64) + '.json'), JSON.stringify(receipt(unrelated, worker)))

  let route
  registerStatusLog({ connection: { fetch: { register(value) { route = value } } } }, {
    enabled: () => false,
    windows: async () => ({
      items: [[owner, '合成主控'], [worker, '合成执行'], [unrelated, '其他会话']]
        .map(([sessionId, title]) => ({ sessionId, projections: { values: { title } } })),
    }),
    read: (id) => receiptLog(directory, id),
  })
  const query = (body) => route.fetch(new Request('http://localhost' + route.path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  const response = await query({ sessionId: owner })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const at = Date.parse(time)
  const base = { at, kind: 'message', from: '合成主控', to: '合成执行' }
  assert.deepEqual(await response.json(), { enabled: false, events: [
    { ...base, state: 'queued' }, { ...base, state: 'admitted' }, { ...base, state: 'failed', reason: 'unverified' },
  ] })
  assert.equal((await query({ sessionId: owner, text: hidden })).status, 400)
})
