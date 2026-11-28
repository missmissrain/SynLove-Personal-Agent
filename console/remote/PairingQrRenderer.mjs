/**
 * 手机接入二维码渲染器：通过标准输入传递敏感配置，仅在内存返回PNG。
 * 参数python为现有解释器路径获取函数；默认15秒超时，不写磁盘、不记录正文。
 */
import { execFileSync } from 'node:child_process'

export class PairingQrRenderer {
  /** python为解释器获取函数；不创建额外环境或下载依赖。 */
  constructor(python) { this.python = python }

  /** bundle为Android接入配置；返回PNG数据地址，依赖缺失时明确失败。 */
  render_qr(bundle) {
    const script = [
      'import base64,io,sys,qrcode',
      'qr=qrcode.QRCode(border=4,box_size=6,error_correction=qrcode.constants.ERROR_CORRECT_M)',
      'qr.add_data(sys.stdin.buffer.read())',
      'qr.make(fit=True)',
      'out=io.BytesIO()',
      "qr.make_image().save(out,format='PNG')",
      "sys.stdout.write(base64.b64encode(out.getvalue()).decode('ascii'))",
    ].join('\n')
    try {
      const value = execFileSync(this.python(), ['-c', script], {
        input: JSON.stringify(bundle), encoding: 'utf8', timeout: 15000,
        maxBuffer: 1048576, windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      }).trim()
      if (!/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error('invalid')
      return `data:image/png;base64,${value}`
    } catch { throw new Error('无法生成配对二维码，请检查现有Python的qrcode依赖') }
  }
}
