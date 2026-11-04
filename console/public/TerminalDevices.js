/**
 * 终端设备管理界面：读取真实心跳、编辑通知开关、下载一次性接入文件及预登记扩展设备。
 * 无注册参数；只使用同源终端管理代理，不保存密码或将接入文件写进浏览器持久存储。
 */
class TerminalDevices {
  /** 无参数；安装设备管理事件，沿用服务配置卡片与当前GUI样式。 */
  constructor() {
    this.devices = []
    this.selected = null
    this.dirty = false
    this.types = []
    this.available = false
    this.notificationsConfigured = false
    const card = document.querySelector('.backend-config-card')
    if (card) $('remote-service-container').append(card)
    document.querySelector('[data-tab="remote"]').addEventListener('click', () => {
      this.load_devices().catch(error => this.connection_failed(error.message))
      refresh_backend_config().catch(error => { $('backend-hint').textContent = error.message })
    })
    $('remote-new').addEventListener('click', () => this.edit_device(null))
    $('remote-target-form').addEventListener('input', () => { this.dirty = true })
    $('remote-target-form').addEventListener('submit', event => { event.preventDefault(); this.save_device() })
    $('remote-kind').addEventListener('change', () => this.update_form())
    $('remote-transport').addEventListener('change', () => this.update_form())
    $('remote-pair').addEventListener('click', () => this.create_pair())
    $('remote-test').addEventListener('click', () => this.probe_device())
    this.edit_device(null)
    setInterval(() => {
      if ($('tab-remote').classList.contains('active')) {
        this.load_devices().catch(() => this.connection_failed('终端管理器暂不可用'))
      }
    }, 10000)
  }

  /** text/state为操作结果与状态；只写textContent，不拼接设备提供的HTML。 */
  show_result(text, state = '') {
    $('remote-result').textContent = text
    $('remote-result').dataset.state = state
  }

  /** text为连接失败提示；旧设备列表保留供编辑，但旧在线证据不能继续亮绿灯。 */
  connection_failed(text) {
    this.available = false
    $('terminal-online-count').textContent = '未连接'
    this.render_devices()
    this.update_form()
    this.show_result(text, 'error')
  }

  /** 无参数；读取权威设备列表，不覆盖未保存表单。 */
  async load_devices() {
    const data = await get('/api/remote/devices')
    this.devices = data.devices
    this.types = data.transports
    this.available = true
    this.notificationsConfigured = data.notificationsConfigured === true
    $('remote-notification-hint').hidden = this.notificationsConfigured
    $('terminal-online-count').textContent = `${data.onlineCount} 台在线`
    this.render_devices()
    if (this.selected && !this.dirty) this.edit_device(this.devices.find(row => row.id === this.selected) ?? null)
  }

  /** 无参数；按设备实际心跳显示在线，不以类型、开关或父设备状态代替可用性。 */
  render_devices() {
    const box = $('remote-target-list')
    box.replaceChildren()
    const labels = { online: '在线', offline: '离线', reserved: '已预留', disabled: '已停用' }
    for (const device of this.devices) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `remote-target ${device.id === this.selected ? 'active' : ''}`
      const dot = document.createElement('span')
      const online = this.available && device.online
      const status = this.available ? labels[device.status] : '未连接'
      dot.className = `service-dot ${online ? 'is-up' : 'is-down'}`
      dot.setAttribute('aria-label', status ?? '未连接')
      button.append(dot, document.createTextNode(`${device.name} · ${status ?? '未连接'}`))
      button.addEventListener('click', () => this.edit_device(device))
      box.append(button)
    }
    if (!this.devices.length) box.textContent = '暂无设备'
  }

  /** device为已登记设备或null；编辑名称及开关，已登记的身份与路由字段锁定。 */
  edit_device(device) {
    this.selected = device?.id ?? null
    const values = {
      id: device?.id ?? '', description: device?.name ?? '', kind: device?.kind ?? 'windows',
      transport: device?.transport ?? 'direct', enabled: String(Boolean(device?.enabled ?? true)),
      codex: String(device?.settings?.codex === true), opencode: String(device?.settings?.opencode === true),
    }
    for (const [name, value] of Object.entries(values)) $(`remote-${name}`).value = value
    $('remote-id').readOnly = Boolean(device)
    $('remote-kind').disabled = Boolean(device)
    $('remote-transport').disabled = Boolean(device)
    const parent = $('remote-parent')
    parent.replaceChildren(new Option('请选择', ''))
    for (const item of this.devices.filter(item => item.id !== this.selected)) parent.add(new Option(item.name, item.id))
    parent.value = device?.parentId ?? ''
    parent.disabled = Boolean(device)
    this.dirty = false
    this.update_form()
    this.render_devices()
    const names = { 'shell.exec': '远程命令', 'music.play': '音乐播放',
      'coding.codex': 'Codex 通知', 'coding.opencode': 'OpenCode 通知' }
    const capabilities = (device?.capabilities ?? []).map(value => names[value]).filter(Boolean)
    this.show_result(device ? `${device.name} · ${capabilities.join('、') || '尚未上报功能'}` : '接入文件交给目标设备，双击 Install.cmd 完成登记。')
  }

  /** 无参数；根据设备类型选择配对或预登记，未实现适配器不提供执行入口。 */
  update_form() {
    const kind = $('remote-kind').value
    for (const option of $('remote-transport').options) {
      option.disabled = option.value === 'adb' ? kind !== 'android' :
        option.value === 'gateway' ? !['android', 'embedded'].includes(kind) : false
    }
    if ($('remote-transport').selectedOptions[0]?.disabled) $('remote-transport').value = 'direct'
    const transport = $('remote-transport').value
    const supported = this.types.length
      ? this.types.some(row => row.id === transport && row.implemented && row.kinds.includes(kind))
      : transport === 'direct' && ['windows', 'linux', 'gateway'].includes(kind)
    this.supported = supported
    $('remote-parent-label').hidden = transport === 'direct'
    const device = this.devices.find(row => row.id === this.selected)
    $('remote-save').textContent = device ? '保存设置' : supported ? '生成接入文件' : '预登记设备'
    $('remote-pair').hidden = !device || device.identityReady || !supported
    $('remote-test').disabled = !this.available || !device?.online || !device?.capabilities?.includes('device.probe')
  }

  /** 无参数；读取登记与设置字段，接口不接受浏览器指定在线状态或公钥。 */
  read_form() {
    return { id: this.selected, deviceId: $('remote-id').value.trim() || undefined,
      name: $('remote-description').value.trim(), kind: $('remote-kind').value,
      transport: $('remote-transport').value,
      parentId: $('remote-transport').value === 'direct' ? '' : $('remote-parent').value,
      enabled: $('remote-enabled').value === 'true',
      settings: { codex: $('remote-codex').value === 'true', opencode: $('remote-opencode').value === 'true' } }
  }

  /** bundle为一次性接入文件；只生成本次下载，不写localStorage或页面正文。 */
  download_bundle(bundle) {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'Pairing.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /** 无参数；新设备登记或生成接入文件，已登记设备只更新允许编辑的设置。 */
  async save_device() {
    $('remote-save').disabled = true
    try {
      const data = this.read_form()
      let id = this.selected
      if (id) await post('/api/remote/device', data)
      else {
        const reply = await post(this.supported ? '/api/remote/pair' : '/api/remote/reserve', data)
        id = reply.bundle?.deviceId ?? reply.device.id
        this.selected = id
        if (reply.bundle) this.download_bundle(reply.bundle)
        await post('/api/remote/device', { id, name: data.name || id, enabled: data.enabled, settings: data.settings })
      }
      this.dirty = false
      await this.load_devices()
      this.edit_device(this.devices.find(row => row.id === id))
      const waiting = !this.notificationsConfigured && (data.settings.codex || data.settings.opencode)
      this.show_result(waiting ? '设置已保存；服务器尚未配置通知接收人，完成事件会暂存在服务器。' :
        this.supported ? '已保存；终端连通后会自动显示在线。' : '已预留，等待对应接入适配器。', 'ok')
    } catch (error) { this.show_result(error.message, 'error') }
    finally { $('remote-save').disabled = false }
  }

  /** 无参数；为尚未配对的已登记直连设备重新生成一次接入文件。 */
  async create_pair() {
    $('remote-pair').disabled = true
    try {
      const reply = await post('/api/remote/pair', this.read_form())
      this.download_bundle(reply.bundle)
      this.show_result('接入文件已生成，有效期十分钟，请私下交付目标设备。', 'ok')
    } catch (error) { this.show_result(error.message, 'error') }
    finally { $('remote-pair').disabled = false }
  }

  /** 无参数；只对已选在线设备进行一次实际协议探活，超时后保留原指令。 */
  async probe_device() {
    if (!this.selected) return
    $('remote-test').disabled = true
    this.show_result('正在等待设备签名回执…')
    try {
      const reply = await post('/api/remote/probe', { id: this.selected })
      this.show_result(reply.available ? '设备通信与执行器检查通过。' :
        reply.pending ? '检查已提交，尚未收到结果。' : '设备检查未通过。', reply.available ? 'ok' : 'error')
    } catch (error) { this.show_result(error.message, 'error') }
    finally { this.update_form() }
  }
}

new TerminalDevices()
