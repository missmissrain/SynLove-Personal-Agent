/** 终端心跳回归：验证仅查询权威管理器、单轮互斥及失败恢复；不另行探测用户设备。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteConnectionHeartbeat } from '../RemoteConnectionHeartbeat.mjs'

test('只读终端管理器，失败后下一轮仍可检查，不重建SSH设备探活', async () => {
  let calls = 0
  const store = {
    refresh_devices: async () => { calls++; if (calls === 1) throw Error('offline') },
    list_targets: () => { throw Error('不应读取旧SSH配置') },
    probe_target: () => { throw Error('不应另行发送设备探测') },
  }
  const heartbeat = new RemoteConnectionHeartbeat(store)
  await heartbeat.check_targets()
  assert.equal(heartbeat.running, false)
  await heartbeat.check_targets()
  assert.equal(calls, 2)
})

test('上一轮仍在运行时不重叠探测，停止后不再调用', async () => {
  let release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const heartbeat = new RemoteConnectionHeartbeat({
    refresh_devices: async () => { calls++; await gate },
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
