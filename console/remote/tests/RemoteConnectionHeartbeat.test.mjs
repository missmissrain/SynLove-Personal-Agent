/** 远控心跳回归：用隔离替身验证目标授权过滤、单轮互斥及失败隔离；不连接真实电脑。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteConnectionHeartbeat } from '../RemoteConnectionHeartbeat.mjs'

test('只探测启用且保存凭据的设备，单个失败不阻断后续设备', async () => {
  const calls = []
  const store = {
    list_targets: () => ({ targets: [
      { id: 'disabled', enabled: false, hasCredential: true },
      { id: 'noKey', enabled: true, hasCredential: false },
      { id: 'offline', enabled: true, hasCredential: true },
      { id: 'online', enabled: true, hasCredential: true },
    ] }),
    probe_target: async body => { calls.push(body.target); if (body.target === 'offline') throw Error('offline') },
  }
  await new RemoteConnectionHeartbeat(store).check_targets()
  assert.deepEqual(calls, ['offline', 'online'])
})

test('上一轮仍在运行时不重叠探测，停止后不再调用', async () => {
  let release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const heartbeat = new RemoteConnectionHeartbeat({
    list_targets: () => ({ targets: [{ id: 'home', enabled: true, hasCredential: true }] }),
    probe_target: async () => { calls++; await gate },
  })
  const first = heartbeat.check_targets()
  await heartbeat.check_targets()
  assert.equal(calls, 1)
  release()
  await first
  heartbeat.stop_heartbeat()
  await heartbeat.check_targets()
  assert.equal(calls, 1)
})
