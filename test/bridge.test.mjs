/**
 * 离线单元测试：协议客户端、错误分类、工具层参数传递。
 * 全部使用内存里的假 Blender 服务，不需要真的启动 Blender。
 *
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRIDGE_ERROR, probe, sendCommand } from '../lib/bridge.js'
import { buildTools } from '../lib/index.js'

/** 起一个假 Blender：把收到的请求交给 handler。 */
function fakeBlender(handler) {
  return new Promise((resolve) => {
    const requests = []
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
          if (!line.trim()) continue
          const request = JSON.parse(line)
          requests.push(request)
          handler(request, socket, requests.length)
        }
      })
      socket.on('error', () => undefined)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

const reply = (socket, payload) => socket.write(JSON.stringify(payload) + '\n')

test('成功响应按 result 解包', async () => {
  const fake = await fakeBlender((request, socket) => reply(socket, { id: request.id, ok: true, result: { blender: '5.2.2' } }))
  try {
    const result = await sendCommand({ host: '127.0.0.1', port: fake.port, cmd: 'ping', params: {}, timeoutMs: 5000 })
    assert.equal(result.blender, '5.2.2')
    assert.equal(fake.requests[0].cmd, 'ping')
  } finally {
    await fake.close()
  }
})

test('Blender 侧报错映射成 BRIDGE_REMOTE 并保留原因', async () => {
  const fake = await fakeBlender((request, socket) => reply(socket, {
    id: request.id,
    ok: false,
    error: { message: '找不到对象：Cube', code: 'OBJECT_NOT_FOUND' },
  }))
  try {
    await assert.rejects(
      () => sendCommand({ host: '127.0.0.1', port: fake.port, cmd: 'object.delete', params: {}, timeoutMs: 5000 }),
      (error) => error.code === BRIDGE_ERROR.REMOTE && error.message.includes('找不到对象：Cube'),
    )
  } finally {
    await fake.close()
  }
})

test('响应被拆成多个分片时仍能解析', async () => {
  const fake = await fakeBlender((request, socket) => {
    const payload = JSON.stringify({ id: request.id, ok: true, result: { ok: 1 } }) + '\n'
    socket.write(payload.slice(0, 5))
    setTimeout(() => socket.write(payload.slice(5)), 10)
  })
  try {
    const result = await sendCommand({ host: '127.0.0.1', port: fake.port, cmd: 'ping', params: {}, timeoutMs: 5000 })
    assert.deepEqual(result, { ok: 1 })
  } finally {
    await fake.close()
  }
})

test('超时被标记为 BRIDGE_TIMEOUT', async () => {
  const fake = await fakeBlender(() => undefined)
  try {
    await assert.rejects(
      () => sendCommand({ host: '127.0.0.1', port: fake.port, cmd: 'render.image', params: {}, timeoutMs: 1000 }),
      (error) => error.code === BRIDGE_ERROR.TIMEOUT,
    )
  } finally {
    await fake.close()
  }
})

test('端口没人监听时给出离线提示', async () => {
  const fake = await fakeBlender(() => undefined)
  const deadPort = fake.port
  await fake.close()
  await assert.rejects(
    () => sendCommand({ host: '127.0.0.1', port: deadPort, cmd: 'ping', params: {}, timeoutMs: 2000 }),
    (error) => error.code === BRIDGE_ERROR.OFFLINE && error.message.includes('DSH Blender Bridge'),
  )
})

test('中止信号能取消等待中的命令', async () => {
  const fake = await fakeBlender(() => undefined)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  try {
    await assert.rejects(
      () => sendCommand({ host: '127.0.0.1', port: fake.port, cmd: 'ping', params: {}, timeoutMs: 5000, signal: controller.signal }),
      (error) => error.code === BRIDGE_ERROR.ABORTED,
    )
  } finally {
    await fake.close()
  }
})

test('非法 JSON 响应被归为协议错误', async () => {
  const fake = await fakeBlender((_request, socket) => socket.write('not json\n'))
  try {
    await assert.rejects(
      () => sendCommand({ host: '127.0.0.1', port: fake.port, cmd: 'ping', params: {}, timeoutMs: 5000 }),
      (error) => error.code === BRIDGE_ERROR.PROTOCOL,
    )
  } finally {
    await fake.close()
  }
})

test('probe 在离线时返回 online:false 而不是抛错', async () => {
  const fake = await fakeBlender(() => undefined)
  const deadPort = fake.port
  await fake.close()
  const status = await probe({ host: '127.0.0.1', port: deadPort, timeoutMs: 1500 })
  assert.equal(status.online, false)
  assert.ok(status.error.length > 0)
})

test('工具层把参数原样送到 Blender，并把结果整理成可读结构', async () => {
  const fake = await fakeBlender((request, socket) => reply(socket, {
    id: request.id,
    ok: true,
    result: {
      created: { name: request.params.name, type: 'MESH', vertices: 8, polygons: 6, dimensions: [2, 2, 2], location: [0, 0, 0], materials: [], modifiers: [] },
      scene_counts: { objects: 1 },
    },
  }))
  const { tools } = buildTools({ port: fake.port, outputDir: mkdtempSync(join(tmpdir(), 'dsh-blender-')), timeoutMs: 5000 })
  const create = tools.find((tool) => tool.name === 'blender_create_primitive')
  try {
    const result = await create.execute({ kind: 'cube', name: 'Crate', location: [1, 2, 3] }, {})
    assert.equal(result.created.name, 'Crate')
    assert.equal(fake.requests[0].cmd, 'object.create')
    assert.deepEqual(fake.requests[0].params.location, [1, 2, 3])
    assert.equal(fake.requests[0].params.kind, 'cube')
  } finally {
    await fake.close()
  }
})

test('渲染工具自动分配不覆盖的产物路径', async () => {
  const fake = await fakeBlender((request, socket) => reply(socket, {
    id: request.id,
    ok: true,
    result: { path: request.params.filepath, bytes: 1234, seconds: 0.2 },
  }))
  const outputDir = mkdtempSync(join(tmpdir(), 'dsh-blender-'))
  const { tools } = buildTools({ port: fake.port, outputDir, timeoutMs: 5000 })
  const render = tools.find((tool) => tool.name === 'blender_render_view')
  try {
    const first = await render.execute({}, {})
    writeFileSync(first.path, 'fake png') // 真实渲染会落盘，这里手动落盘以驱动「不覆盖」逻辑
    const second = await render.execute({}, {})
    assert.ok(first.path.endsWith('render.png'), first.path)
    assert.ok(second.path.endsWith('render.01.png'), second.path)
    assert.ok(first.path.startsWith(outputDir))
  } finally {
    await fake.close()
  }
})

test('列表类工具把对象整理成单行摘要', async () => {
  const fake = await fakeBlender((request, socket) => reply(socket, {
    id: request.id,
    ok: true,
    result: {
      total: 1,
      objects: [{
        name: 'TableTop', type: 'MESH', location: [0, 0, 1], dimensions: [2, 2, 0.12], vertices: 8, polygons: 6,
        materials: ['Oak'], modifiers: [{ name: 'Bevel', type: 'BEVEL' }], selected: true,
      }],
    },
  }))
  const { tools } = buildTools({ port: fake.port, timeoutMs: 5000 })
  const list = tools.find((tool) => tool.name === 'blender_list_objects')
  try {
    const result = await list.execute({}, {})
    assert.equal(result.count, 1)
    assert.match(result.objects[0], /TableTop \[MESH\]/)
    assert.match(result.objects[0], /已选中/)
  } finally {
    await fake.close()
  }
})
