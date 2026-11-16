/** OpenCode兼容性测试：假版本缓存验证参数转换，不发起模型请求。默认用现有Node运行。 */
import assert from 'node:assert/strict'
import { OpenCodeCommand } from '../backend/packages/util/native-command/lib/types/OpenCodeCommand.js'
OpenCodeCommand.cache.set('v2', {major:2, at:Date.now()})
OpenCodeCommand.cache.set('v1', {major:1, at:Date.now()})
const args=['run','--auto','--attach','http://127.0.0.1:4096','--dir','C:/test','--fork','-s','session123','hello']
assert.deepEqual(OpenCodeCommand.adapt_args('v2',args,''), ['run','--auto','--fork','-s','session123','hello'])
assert.deepEqual(OpenCodeCommand.adapt_args('v2',args,'http://localhost:3000'), ['run','--auto','--server','http://localhost:3000','--fork','-s','session123','hello'])
assert.deepEqual(OpenCodeCommand.adapt_args('v1',args,''), args)
assert.deepEqual(OpenCodeCommand.adapt_args('v2',['export','session123'],''), ['session','export','session123'])
console.log('OpenCode兼容检查4项通过')
