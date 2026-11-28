/**
 * 自迭代设置：统一保存技能沉淀、代码维护、设备路由、预算与自动应用策略。
 * 参数project为生产根目录，backup为写入前备份回调；默认天选优先、服务器离线兜底。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
export class SelfIterationStore {
  /** project为生产路径，backup默认空函数；仅本机受保护GUI可修改。 */
  constructor(project, backup = () => {}) { this.path = join(project,'config/nightlyMaintenance.json'); this.backup=backup }
  /** 无参数；保留仓库清单等后台字段，返回默认配置合并结果。 */
  read_config() {
    const raw=existsSync(this.path) ? JSON.parse(readFileSync(this.path,'utf8').replace(/^\uFEFF/,'')) : {}
    return { enabled:true, skillEnabled:true, skillHour:'03:00', maintenanceHour:'03:30',
      intervalDays:3, maxRepositoriesPerRun:0, autoApply:true, ...raw,
      execution:{primaryDevice:'tianxuanLaptop',fallbackLocal:true,timeoutSec:900,...raw.execution} }
  }
  /** 无参数；返回功能设置页面可复用控件，不暴露路径、密钥及私人材料。 */
  list_controls() {
    const c=this.read_config()
    const select=(key,label,value,options,help='下一轮任务生效')=>({key:'iteration.'+key,label,kind:'select',value:String(value),
      options:options.map(([value,label])=>({value:String(value),label})),help})
    return [
      {key:'iteration.enabled',label:'夜间代码自迭代',kind:'bool',value:c.enabled,help:'Codex独立检查仓库；通过验收后按策略应用'},
      {key:'iteration.skillEnabled',label:'Codex 自动沉淀 Skill',kind:'bool',value:c.skillEnabled,help:'中文技能，保留证据校验与更新待审'},
      select('primaryDevice','自迭代首选设备',c.execution.primaryDevice,[['tianxuanLaptop','天选笔记本'],['server','服务器']]),
      {key:'iteration.fallbackLocal',label:'天选离线时使用服务器 Codex',kind:'bool',value:c.execution.fallbackLocal,help:'仅确认离线才切换，已提交任务不重复执行'},
      select('timeoutSec','单项任务最长等待',c.execution.timeoutSec,[[600,'10分钟'],[900,'15分钟'],[1800,'30分钟'],[3600,'1小时']]),
      select('skillHour','Skill 沉淀时间',c.skillHour,[['01:00','01:00'],['02:00','02:00'],['03:00','03:00'],['04:00','04:00'],['05:00','05:00']]),
      select('maintenanceHour','代码自迭代时间',c.maintenanceHour,[['02:30','02:30'],['03:30','03:30'],['04:30','04:30'],['05:30','05:30']]),
      select('intervalDays','代码维护周期',c.intervalDays,[[1,'每天'],[3,'每3天'],[7,'每7天']]),
      select('maxRepositoriesPerRun','每次维护仓库数',c.maxRepositoriesPerRun,[[0,'全部仓库'],[1,'1个'],[2,'2个'],[3,'3个'],[4,'4个']]),
      {key:'iteration.autoApply',label:'自动应用已验证更新',kind:'bool',value:c.autoApply,help:'关闭后只保存补丁；失败或原文件被改动时不应用'},
    ]
  }
  /** key/value为白名单字段及控件值；时间同步计划任务，其他设置下一轮读取。 */
  save_setting(key,value) {
    const c=this.read_config()
    const bool=()=>{if(!['0','1','true','false'].includes(value)) throw Error('布尔设置无效');return value==='1'||value==='true'}
    if(['enabled','skillEnabled','autoApply'].includes(key)) c[key]=bool()
    else if(key==='fallbackLocal') c.execution.fallbackLocal=bool()
    else if(key==='primaryDevice') {if(!['server','tianxuanLaptop'].includes(value)) throw Error('设备无效');c.execution.primaryDevice=value}
    else if(key==='timeoutSec') {if(![600,900,1800,3600].includes(Number(value))) throw Error('超时无效');c.execution.timeoutSec=Number(value)}
    else if(key==='maxRepositoriesPerRun') {if(![0,1,2,3,4].includes(Number(value))) throw Error('数量无效');c[key]=Number(value)}
    else if(key==='intervalDays') {if(![1,3,7].includes(Number(value))) throw Error('周期无效');c.intervalDays=Number(value)}
    else if(['skillHour','maintenanceHour'].includes(key)) {
      const allowed=key==='skillHour'?['01:00','02:00','03:00','04:00','05:00']:['02:30','03:30','04:30','05:30']
      if(!allowed.includes(value)) throw Error('时间无效')
      if(process.platform==='win32') {
        const task=key==='skillHour'?'SynLove-SkillReview':'SynLove-NightlyMaintenance'
        const changed=spawnSync('schtasks.exe',['/Change','/TN',task,'/ST',value],{windowsHide:true,timeout:15000,encoding:'utf8'})
        if(changed.status!==0) throw Error('计划任务时间修改失败，请确认任务已部署')
      }
      c[key]=value
    } else throw Error('未知自迭代设置')
    this.backup(this.path)
    const temp=this.path+'.tmp'
    writeFileSync(temp,JSON.stringify(c,null,2),'utf8');renameSync(temp,this.path)
    return {ok:true,note:'自迭代设置已保存，下一轮生效'}
  }
}
