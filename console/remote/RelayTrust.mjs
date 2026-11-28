/**
 * Relay TLS 信任：将服务注册表中明确配置的 CA 加到本进程的默认信任。
 * 注册参数 project 为生产根；不修改操作系统证书库，不关闭证书和主机名验证。
 */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'

export class RelayTrust {
  /** 参数 project 为生产根目录；返回加入的 CA 文件数量，缺失或无效证书直接报错。 */
  static configure_trust(project) {
    const data = JSON.parse(readFileSync(process.env.SYNLOVE_SERVICE_CONFIG ||
      join(project, 'config', 'serviceConfig.json'), 'utf8').replace(/^\uFEFF/, ''))
    const paths = [...new Set(Object.values(data.services ?? {})
      .map(cfg => cfg.tlsCaFile).filter(Boolean))]
    if (!paths.length) return 0
    const extra = paths.map(path => readFileSync(resolve(project, path), 'utf8'))
    setDefaultCACertificates([...getCACertificates('default'), ...extra])
    return paths.length
  }
}
