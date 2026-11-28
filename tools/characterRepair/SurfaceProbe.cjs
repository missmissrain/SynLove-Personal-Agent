/**
 * 人物表面定位：用实际骨骼矩阵重建 CPU 表面，对截图区域进行射线取样。
 * 参数无；读取本机原型，不写模型、不访问业务接口。
 */
const { chromium } = require('C:/Users/洪嘉锴/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

/** 无参数；输出截图关注区域对应的源网格坐标和纹理 UV。 */
async function run_probe() {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://127.0.0.1:3090/prototype/character-driven/')
    await page.waitForFunction(() => window.synlovePrototype?.avatar.loaded)
    console.log(JSON.stringify(await page.evaluate(async () => {
      const T = await import('/Avatar/vendor/Three.js')
      const a = window.synlovePrototype.avatar
      a.renderer.setAnimationLoop(null)
      a.motion.update_motion(0, true)
      a.controls.value.set(0, 0, 0)
      a.renderer.render(a.scene, a.camera)
      const g = a.figure.children[0].geometry
      const p = g.getAttribute('position'), ji = g.getAttribute('jointIndices'), jw = g.getAttribute('jointWeights')
      const values = new Float32Array(p.count * 3)
      const v = new T.Vector3(), result = new T.Vector3(), m = new T.Matrix4()
      for (let i = 0; i < p.count; i++) {
        result.set(0, 0, 0)
        for (let j = 0; j < 4; j++) {
          m.fromArray(a.motion.data, ji.getComponent(i, j) * 16)
          v.fromBufferAttribute(p, i).applyMatrix4(m).multiplyScalar(jw.getComponent(i, j))
          result.add(v)
        }
        values.set([result.x, result.z, -result.y], i * 3)
      }
      const geo = new T.BufferGeometry()
      geo.setAttribute('position', new T.BufferAttribute(values, 3))
      geo.setIndex(g.index)
      const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ side: T.DoubleSide }))
      mesh.updateMatrixWorld()
      const box = a.renderer.domElement.getBoundingClientRect(), ray = new T.Raycaster()
      const samples = [[687,234],[695,234],[705,234],[712,232],[716,240],[721,245],[726,248]]
      return samples.map(([x, y]) => {
        ray.setFromCamera(new T.Vector2((x - box.left) / box.width * 2 - 1, 1 - (y - box.top) / box.height * 2), a.camera)
        const hit = ray.intersectObject(mesh)[0]
        if (!hit) return { screen: [x, y], miss: true }
        const ids = [hit.face.a, hit.face.b, hit.face.c]
        return { screen: [x, y], source: ids.map(i => [p.getX(i), p.getY(i), p.getZ(i)]),
          uv: ids.map(i => [g.getAttribute('uv').getX(i), g.getAttribute('uv').getY(i)]),
          donor: ids.map(i => [g.getAttribute('hairUv').getX(i),g.getAttribute('hairUv').getY(i)]) }
      })
    }), null, 2))
  } finally { await browser.close() }
}
run_probe().catch(error => { console.error(error); process.exitCode = 1 })
