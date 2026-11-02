/**
 * 远程连接界面：编辑电脑、核对主机身份、保存本机凭据及执行固定连接检查。
 * 注册参数无；依赖现有 get/post 辅助函数，不把密码写入 localStorage 或日志。
 * 连接测试只针对保存后的电脑；编辑表单后先保存，避免测到旧地址。
 */
class RemoteConnections {
  /** 无参数；复用现有服务配置卡片，并安装仅此页的事件监听。 */
  constructor() {
    this.targets = []
    this.selected = null
    this.dirty = false
    this.checks = new Map()
    $('remote-service-container').append(document.querySelector('.backend-config-card'))
    document.querySelector('[data-tab="remote"]').addEventListener('click', () => {
      this.load_targets().catch(error => this.show_result(error.message, 'error'))
      refresh_backend_config().catch(error => { $('backend-hint').textContent = error.message })
    })
    $('remote-new').addEventListener('click', () => this.edit_target(null))
    $('remote-target-form').addEventListener('input', event => {
      this.dirty = true
      if (['remote-host', 'remote-port', 'remote-fingerprint'].includes(event.target.id)) $('remote-trust').checked = false
    })
    $('remote-target-form').addEventListener('submit', event => { event.preventDefault(); this.save_target() })
    $('remote-key').addEventListener('click', () => this.read_key())
    $('remote-test').addEventListener('click', () => this.test_target())
    $('remote-delete').addEventListener('click', () => this.delete_target())
    this.edit_target(null)
    setInterval(() => {
      if ($('tab-remote').classList.contains('active')) {
        get('/api/remote/targets').then(data => { this.targets = data.targets; this.render_targets() }).catch(() => {})
      }
    }, 10000)
  }

  /** 参数 text/state 为脱敏提示与结果状态；只写 textContent，防止响应注入 HTML。 */
  show_result(text, state = '') {
    $('remote-result').textContent = text
    $('remote-result').dataset.state = state
  }

  /** 无参数；加载目标公开字段，不请求或回填密码。 */
  async load_targets() {
    const data = await get('/api/remote/targets')
    this.targets = data.targets
    this.render_targets()
    // 切换页签不覆盖用户尚未保存的输入。
    if (!this.dirty && this.selected) this.edit_target(this.targets.find(item => item.id === this.selected) ?? null)
  }

  /** 无参数；仅本次真实检查通过才亮绿灯，不把“启用”当成“连接可用”。 */
  render_targets() {
    const box = $('remote-target-list')
    box.replaceChildren()
    for (const item of this.targets) {
      const button = document.createElement('button')
      button.type = 'button'
      button.classList.toggle('is-selected', item.id === this.selected)
      const dot = document.createElement('span')
      const local = this.checks.get(item.id)
      const checked = item.checkedAt && (!local || item.checkedAt > local.at)
        ? { available: item.available, at: item.checkedAt } : local
      dot.className = `service-dot ${checked?.available && Date.now() - checked.at < 60000 ? 'is-up' : 'is-down'}`
      dot.setAttribute('aria-label', checked?.available ? '最近连接检查通过' : '尚未验证可用')
      button.append(dot, document.createTextNode(item.description || item.id))
      button.addEventListener('click', () => this.edit_target(item))
      box.append(button)
    }
  }

  /** 参数 item 为已保存目标或 null；密码永远留空，电脑标识在编辑时锁定。 */
  edit_target(item) {
    this.selected = item?.id ?? null
    for (const [field, value] of Object.entries({
      id: item?.id ?? '', description: item?.description ?? '', host: item?.host ?? '',
      port: item?.port ?? 22, user: item?.user ?? '', fingerprint: item?.hostKeySha256 ?? '',
      enabled: String(item?.enabled ?? true), password: '',
    })) $(`remote-${field}`).value = value
    $('remote-id').readOnly = Boolean(item)
    $('remote-trust').checked = false
    $('remote-password').placeholder = item?.hasCredential ? '已保存；留空保留原凭据' : '输入目标电脑登录密码'
    $('remote-test').disabled = !item?.enabled
    $('remote-delete').disabled = !item
    this.dirty = false
    this.render_targets()
    this.show_result(item ? '配置已读取。点击测试连接验证 SSH 和 CMD。' : '添加电脑，填写地址、账号和密码。')
  }

  /** 无参数；收集本机表单，未保存密码不会写入浏览器存储。 */
  read_form() {
    return { id: $('remote-id').value.trim(), description: $('remote-description').value.trim(),
      host: $('remote-host').value.trim(), port: Number($('remote-port').value),
      user: $('remote-user').value.trim(), password: $('remote-password').value,
      hostKeySha256: $('remote-fingerprint').value.trim(),
      enabled: $('remote-enabled').value === 'true', trustConfirmed: $('remote-trust').checked }
  }

  /** 无参数；读取对端公钥但不自动信任、不提交登录密码。 */
  async read_key() {
    $('remote-key').disabled = true
    this.show_result('正在读取 SSH 公钥…')
    const host = $('remote-host').value.trim(), port = Number($('remote-port').value)
    try {
      const result = await post('/api/remote/key', { host, port })
      if (!result.ok) throw new Error(result.message)
      if (host !== $('remote-host').value.trim() || port !== Number($('remote-port').value)) throw new Error('地址已变化，请重新读取指纹')
      $('remote-fingerprint').value = result.fingerprint
      $('remote-trust').checked = false
      this.dirty = true
      this.show_result(result.message)
    } catch (error) { this.show_result(error.message, 'error') }
    finally { $('remote-key').disabled = false }
  }

  /** 无参数；保存目标并清空密码输入；变更配置立即清除旧探活结果。 */
  async save_target() {
    $('remote-save').disabled = true
    try {
      const body = this.read_form()
      const data = await post('/api/remote/targets', body)
      $('remote-password').value = ''
      this.targets = data.targets
      this.checks.delete(body.id)
      this.edit_target(this.targets.find(item => item.id === body.id))
      this.show_result('已保存，欣爱会在下次调用时读取新配置。', 'ok')
    } catch (error) { this.show_result(error.message, 'error') }
    finally { $('remote-save').disabled = false }
  }

  /** 无参数；仅对未改动的已保存目标进行固定 CMD 协议检查，失败不自动重试。 */
  async test_target() {
    if (this.dirty) { this.show_result('配置有修改，请先保存再测试。', 'error'); return }
    const id = this.selected
    $('remote-test').disabled = true
    this.show_result('正在验证 SSH 身份、登录和 CMD 响应…')
    try {
      const result = await post('/api/remote/probe', { id })
      this.checks.set(id, { available: result.available === true, at: Date.now() })
      this.render_targets()
      if (this.selected === id) this.show_result(result.message, result.available ? 'ok' : 'error')
    } catch (error) {
      this.checks.delete(id)
      this.render_targets()
      if (this.selected === id) this.show_result(error.message, 'error')
    } finally { $('remote-test').disabled = !this.targets.find(item => item.id === this.selected)?.enabled }
  }

  /** 无参数；删除当前明确选中的本机配置，不删除或停机远端系统。 */
  async delete_target() {
    const id = this.selected
    if (!id) return
    $('remote-delete').disabled = true
    try {
      const data = await post('/api/remote/delete', { id })
      this.targets = data.targets
      this.checks.delete(id)
      this.edit_target(null)
      this.show_result('已删除本机连接配置。')
    } catch (error) { this.show_result(error.message, 'error'); $('remote-delete').disabled = false }
  }
}

new RemoteConnections()
