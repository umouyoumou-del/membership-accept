import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { Context, Schema, h } from 'koishi'
import { WikidotClient, WikidotError, WikidotApplication } from './wikidot'

export const name = 'approve'

/** 单个站点的配置：一个站点 URL 对应一个（或多个）转发目标群聊 */
export interface SiteConfig {
  /** Wikidot 站点名（不含 .wikidot.com） */
  wiki: string
  /** 该站点对应的转发目标群聊，格式 platform:channelId（如 onebot:123456789） */
  target?: string
  /** 该站点对应的转发目标群聊列表（与 target 二选一，可留空） */
  targets?: string[]
}

export interface Config {
  /** Wikidot 管理员账号（需有站点管理权限） */
  username?: string
  /** Wikidot 账号密码 */
  password?: string
  /** 旧版单站点配置：站点名（配置 sites 后可留空） */
  wiki?: string
  /** 旧版单站点转发目标列表（配置 sites 后可留空） */
  targets?: string[]
  /** 多站点配置：一个站点 URL 对应一个 QQ 群 */
  sites?: SiteConfig[]
  /** 每次最多显示的申请书数量 */
  maxApplications?: number
  /** 自动转发轮询间隔（秒），0 或留空表示关闭（兼容旧配置） */
  pollInterval?: number
  /** 定时扫描申请书间隔（秒），默认 300 */
  scanInterval?: number
  /** 通过按钮/指令审批所需的最低权限等级 */
  approveAuthority?: number
  /** 已处理/已转发的申请书键（持久化去重，可留空） */
  processed?: string[]
}

export const Config: Schema<Config> = Schema.object({
  username: Schema.string()
    .description('Wikidot 管理员账号（需有站点管理权限）'),
  password: Schema.string()
    .role('secret')
    .description('Wikidot 账号密码'),
  wiki: Schema.string()
    .description('旧版单站点配置：站点名（不含 .wikidot.com；配置 sites 后可留空）'),
  targets: Schema.array(Schema.string())
    .description('旧版单站点转发目标群聊列表（配置 sites 后可留空）'),
  sites: Schema.array(Schema.object({
    wiki: Schema.string()
      .required()
      .description('Wikidot 站点名（不含 .wikidot.com）'),
    target: Schema.string()
      .description('该站点对应的转发目标群聊，格式 platform:channelId，例如 onebot:123456789'),
    targets: Schema.array(Schema.string())
      .description('该站点对应的转发目标群聊列表（与 target 二选一）'),
  }))
    .description('多站点配置：一个站点 URL 对应一个 QQ 群'),
  maxApplications: Schema.number()
    .default(5)
    .min(1)
    .max(20)
    .description('每次最多显示的申请书数量'),
  pollInterval: Schema.number()
    .description('自动转发轮询间隔（秒），0 表示关闭'),
  scanInterval: Schema.number()
    .default(300)
    .min(0)
    .description('定时扫描申请书间隔（秒），默认 300（5 分钟），设为 0 关闭；扫描到新申请书时自动转发到对应站点配置的群聊'),
  approveAuthority: Schema.number()
    .default(2)
    .min(0)
    .description('通过按钮/指令审批所需的最低权限等级（默认 2=管理员）'),
})

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map((line) => pad + line).join('\n')
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('approve')
  /** 已成功转发的申请书去重键集合（持久化，防止同一申请书重复发送） */
  const processed = new Set<string>()
  /** 已处理记录文件（位于 Koishi 应用 data 目录） */
  const processedFile = join(ctx.baseDir, 'data', 'approve-processed.json')

  /** 从文件加载已处理记录 */
  function loadProcessed(): void {
    try {
      if (existsSync(processedFile)) {
        const data = JSON.parse(readFileSync(processedFile, 'utf8'))
        if (Array.isArray(data)) {
          data.map(String).forEach((id) => processed.add(id))
        }
      }
    } catch (e) {
      logger.warn(`【去重】读取已处理记录失败：${(e as Error).message}`)
    }
    // 兼容旧配置中的 processed 字段
    (config.processed ?? []).map(String).forEach((id) => processed.add(id))
    logger.info(`【去重】已加载 ${processed.size} 条已处理申请书记录`)
  }

  /** 保存已处理记录到文件 */
  function saveProcessed(): void {
    try {
      mkdirSync(dirname(processedFile), { recursive: true })
      writeFileSync(processedFile, JSON.stringify([...processed]), 'utf8')
    } catch (e) {
      logger.warn(`【去重】保存已处理记录失败：${(e as Error).message}`)
    }
  }

  /** 判断发送结果中是否有成功项 */
  function hasSuccess(results: string[]): boolean {
    return results.some((r) => r.startsWith('✅'))
  }

  /** 构造去重键：站点 + userId + 申请书内容（同一站点同一用户以不同内容再次申请时视为新申请） */
  function keyOf(wiki: string, app: WikidotApplication): string {
    return `${wiki}\u0000${app.userId}\u0000${app.text}`
  }

  /** 删除某站点下某用户的所有去重记录：被拒绝后允许其再次申请被扫描到 */
  function removeUser(wiki: string, userId: string): void {
    const prefix = `${wiki}\u0000${userId}\u0000`
    for (const key of processed) {
      if (key.startsWith(prefix) || key === userId) {
        processed.delete(key)
      }
    }
  }

  /** 将消息元素转换为纯文本（用于不支持按钮等元素的平台回退发送） */
  function toPlainText(node: string | h): string {
    if (typeof node === 'string') return node
    if (typeof node.attrs.text === 'string') return node.attrs.text
    return (node.children ?? []).map((child) => toPlainText(child)).join('')
  }

  /** 内部站点配置（含归一化后的转发目标列表） */
  interface Site {
    wiki: string
    targets: string[]
  }

  /** 解析站点列表：优先使用多站点 sites 配置，否则回退到旧版 wiki/targets */
  function resolveSites(): Site[] {
    if (config.sites?.length) {
      return config.sites.map((s) => {
        const targets: string[] = []
        if (s.target) targets.push(s.target)
        if (s.targets?.length) targets.push(...s.targets)
        return { wiki: s.wiki, targets }
      })
    }
    if (config.wiki) {
      return [{ wiki: config.wiki, targets: config.targets ?? [] }]
    }
    return []
  }

  loadProcessed()

  function requireConfig(): string | null {
    if (!config.username || !config.password) {
      return '请先在插件配置中填写 Wikidot 管理员账号（username / password）。'
    }
    if (!resolveSites().length) {
      return '请先在插件配置中填写站点信息：sites（多站点：一个站点对应一个群聊）或旧版 wiki。'
    }
    return null
  }

  function newClient(wiki: string): WikidotClient {
    return new WikidotClient(config.username!, config.password!, wiki)
  }

  function handleError(e: unknown): string {
    if (e instanceof WikidotError) return e.message
    logger.warn(e)
    return (e as Error).message || String(e)
  }

  /** 构建转发到群聊的申请书消息（含批准/拒绝按钮） */
  function buildForwardMessage(wiki: string, apps: WikidotApplication[]): h {
    const parts: Array<string | h> = []
    apps.forEach((app, i) => {
      if (i > 0) parts.push('\n\n')
      parts.push(
        `📋 新成员申请书（站点 ${wiki}）\n`,
        `申请人：${app.nickname}（@${app.username}，ID ${app.userId}）\n`,
        `申请书内容：${app.text || '（无）'}\n\n`,
        h('button', { text: '✅ 批准', id: `approve:accept:${wiki}:${app.userId}` }, '批准'),
        '  ',
        h('button', { text: '❌ 拒绝', id: `approve:decline:${wiki}:${app.userId}` }, '拒绝'),
        '\n（也可在群内回复「审批 ' + app.username + ' 通过|拒绝」）',
      )
    })
    return h('message', ...parts)
  }

  /** 将消息发送到指定目标群聊列表 */
  async function sendToTargets(content: string | h, targets: string[]): Promise<string[]> {
    const results: string[] = []
    for (const target of targets) {
      const idx = target.indexOf(':')
      const platform = idx === -1 ? '' : target.slice(0, idx)
      const channelId = idx === -1 ? target : target.slice(idx + 1)
      const bot = platform ? ctx.bots.find((b) => b.platform === platform) : undefined
      if (!bot) {
        const available = ctx.bots.map((b) => `${b.platform}:${b.selfId}`).join(', ') || '（无已连接机器人）'
        logger.warn(`未找到平台 ${platform || '(未知)'} 的机器人（当前可用：${available}），无法转发到 ${target}`)
        results.push(`❌ ${target}：未找到平台 ${platform || '(未知)'} 的机器人（当前可用：${available}）`)
        continue
      }
      try {
        await bot.sendMessage(channelId, content)
        logger.info(`【转发】已发送申请书到 ${target}`)
        results.push(`✅ ${target}`)
      } catch (e) {
        // 部分平台（如 OneBot/NapCat）不支持按钮元素，回退为纯文本发送
        logger.warn(`转发到 ${target} 失败，尝试纯文本发送：${handleError(e)}`)
        try {
          await bot.sendMessage(channelId, toPlainText(content))
          logger.info(`【转发】已通过纯文本发送申请书到 ${target}`)
          results.push(`✅ ${target}（纯文本，无按钮）`)
        } catch (e2) {
          logger.warn(`转发到 ${target} 纯文本发送也失败：${handleError(e2)}`)
          results.push(`❌ ${target}：${handleError(e2)}`)
        }
      }
    }
    return results
  }

  /**
   * 主动执行一次扫描：读取所有站点待审批申请书并输出，将新申请书转发到对应站点配置的群聊。
   * 与定时扫描共用同一套逻辑；report=true 时在聊天中展示全部申请书内容（供「扫描」指令使用）。
   */
  async function runScan(report: boolean): Promise<string> {
    const sites = resolveSites()
    const tag = report ? '【主动扫描】' : '【扫描】'
    const lines: string[] = []
    try {
      for (const site of sites) {
        const client = newClient(site.wiki)
        const apps = await client.listApplications()
        logger.info(`${tag}站点 ${site.wiki} 当前有 ${apps.length} 份待审批申请书`)
        lines.push(`📋 站点 ${site.wiki} 当前共有 ${apps.length} 份待审批申请书`)
        const fresh = apps.filter((app) => !processed.has(keyOf(site.wiki, app)))
        // 将新申请书输出到日志
        fresh.forEach((app, i) => {
          logger.info(`${tag}新申请书 #${i + 1}：${app.nickname}（@${app.username}，ID ${app.userId}）`)
          logger.info(`${tag}  内容：${app.text || '（无）'}`)
        })
        if (report) {
          // 指令模式：在聊天中展示全部待审批申请书的申请人信息与申请书内容
          apps.forEach((app, i) => {
            const mark = processed.has(keyOf(site.wiki, app)) ? '（已转发）' : ''
            lines.push('')
            lines.push(`${i + 1}. 申请人：${app.nickname}（@${app.username}，ID ${app.userId}）${mark}`)
            lines.push(app.text ? indent(app.text, 4) : '   （无内容）')
          })
        }
        if (!fresh.length) {
          if (apps.length > 0) {
            lines.push(report ? '（以上申请书均已处理过，无需重复转发）' : '没有新的申请书需要处理。')
          }
          continue
        }
        // 转发到该站点配置的目标群聊（含批准/拒绝按钮）
        if (site.targets.length) {
          const results = await sendToTargets(buildForwardMessage(site.wiki, fresh), site.targets)
          // 仅当至少一个群聊发送成功时才标记为已处理，防止同一申请书重复发送
          if (hasSuccess(results)) {
            fresh.forEach((app) => processed.add(keyOf(site.wiki, app)))
            saveProcessed()
            logger.info(`${tag}已自动转发 ${fresh.length} 份新申请书（站点 ${site.wiki}）到群聊`)
            lines.push('', `📤 已转发 ${fresh.length} 份新申请书（站点 ${site.wiki}）到目标群聊：`)
            results.forEach((r) => lines.push(r))
          } else {
            logger.warn(`${tag}站点 ${site.wiki} 转发失败，未标记为已处理，下次扫描将重试`)
            lines.push('', `⚠️ 站点 ${site.wiki} 转发失败（未标记为已处理），请稍后重试或检查 targets 配置。`)
          }
        } else {
          // 未配置转发目标：仅记录扫描结果，不标记为已处理
          logger.info(`${tag}站点 ${site.wiki} 未配置转发目标，仅记录扫描结果（不转发）`)
          lines.push('', `⚠️ 站点 ${site.wiki} 未配置转发目标，仅展示结果（未转发）。`)
        }
      }
      return lines.join('\n')
    } catch (e) {
      logger.warn(`${tag}失败：${handleError(e)}`)
      return `扫描失败：${handleError(e)}`
    }
  }

  /** 在所有站点中查找某用户名对应的待审批申请（用于审批时自动确定站点） */
  async function findSiteByUser(username: string): Promise<{ site: Site; app: WikidotApplication } | null> {
    const target = username.toLowerCase()
    for (const site of resolveSites()) {
      const client = newClient(site.wiki)
      const apps = await client.listApplications()
      const app = apps.find((a) => a.username.toLowerCase() === target || a.nickname.toLowerCase() === target)
      if (app) return { site, app }
    }
    return null
  }


  // 读取所有站点待审批的申请书内容
  ctx.command('申请书 [limit:number]', '读取站点待审批的申请书内容', { authority: config.approveAuthority ?? 2 })
    .usage('在插件配置中填写 Wikidot 管理员账号后，即可列出所有站点待审批的申请书及其内容。')
    .example('申请书')
    .example('申请书 10')
    .action(async ({ }, limit) => {
      const missing = requireConfig()
      if (missing) return missing

      const count = Math.min(Math.max(limit ?? config.maxApplications!, 1), 20)
      try {
        const lines: string[] = []
        for (const site of resolveSites()) {
          const client = newClient(site.wiki)
          const apps = await client.listApplications()
          if (apps.length) {
            const shown = apps.slice(0, count)
            lines.push(`📋 站点 ${site.wiki} 共有 ${apps.length} 份待审批申请书，显示前 ${shown.length} 份：`)
            shown.forEach((app, i) => {
              lines.push('')
              lines.push(`${i + 1}. 申请人：${app.nickname}（@${app.username}，ID ${app.userId}）`)
              lines.push('   申请书内容：')
              lines.push(app.text ? indent(app.text, 4) : '   （无内容）')
            })
          }
        }
        if (!lines.length) return '当前所有站点都没有待审批的申请书。'
        lines.push('', '使用「审批 <用户名> 通过|拒绝 [回复语]」处理申请。')
        return lines.join('\n')
      } catch (e) {
        return `读取申请书失败：${handleError(e)}`
      }
    })

  // 通过或拒绝某人的申请书（参数为 Wikidot 用户名，或「全部」批量处理所有站点待审批申请）
  ctx.command('审批 <user:string> <decision:string> [reply:text]', '通过或拒绝成员的申请书', { authority: config.approveAuthority ?? 2 })
    .usage('user 为申请人的 Wikidot 用户名（「申请书」列表中的 @用户名），或「全部」表示处理所有站点全部待审批申请书。decision 为「通过」或「拒绝」。')
    .example('审批 alice 通过 欢迎加入！')
    .example('审批 alice 拒绝')
    .example('审批 全部 通过')
    .example('审批 全部 拒绝 不符合条件')
    .action(async ({ }, user, decision, reply = '') => {
      const missing = requireConfig()
      if (missing) return missing

      const username = user.trim()
      const decisionText = decision.trim()
      let type: 'accept' | 'decline'
      if (decisionText === '通过' || decisionText === '批准' || decisionText === 'accept') {
        type = 'accept'
      } else if (decisionText === '拒绝' || decisionText === 'decline') {
        type = 'decline'
      } else {
        return 'decision 参数无效，请输入「通过」或「拒绝」。'
      }

      const label = type === 'accept' ? '通过' : '拒绝'
      try {
        // 批量处理所有站点全部待审批申请书
        if (username === '全部' || username === 'all') {
          const results: string[] = []
          let total = 0
          let ok = 0
          for (const site of resolveSites()) {
            const client = newClient(site.wiki)
            const apps = await client.listApplications()
            total += apps.length
            for (const app of apps) {
              try {
                await client.decideApplication(app.userId, type, reply)
                if (type === 'decline') {
                  // 被拒绝后清除该用户的去重记录，允许其再次申请被扫描到
                  removeUser(site.wiki, app.userId)
                } else {
                  processed.add(keyOf(site.wiki, app))
                }
                ok++
                results.push(`✅ [${site.wiki}] ${app.nickname}（@${app.username}，ID ${app.userId}）`)
              } catch (e) {
                results.push(`❌ [${site.wiki}] ${app.nickname}（@${app.username}，ID ${app.userId}）：${handleError(e)}`)
              }
            }
          }
          saveProcessed()
          logger.info(`【审批】批量${label}了 ${ok}/${total} 份申请书`)
          return `📋 共 ${total} 份待审批申请书，已${label} ${ok} 份：\n${results.join('\n')}`
        }

        // 自动定位该用户名所在的站点
        const found = await findSiteByUser(username)
        if (!found) {
          const siteNames = resolveSites().map((s) => s.wiki).join('、')
          return `在以下站点均未找到 @${username} 的待审批申请：${siteNames}`
        }
        const { site, app } = found
        await newClient(site.wiki).decideApplication(app.userId, type, reply)
        if (type === 'decline') {
          // 被拒绝后清除该用户的去重记录，允许其再次申请被扫描到
          removeUser(site.wiki, app.userId)
          saveProcessed()
        }
        return `✅ 已在站点 ${site.wiki} ${label} @${username}（ID ${app.userId}）的申请${reply ? `，并回复：${reply}` : ''}。`
      } catch (e) {
        return `${label}失败：${handleError(e)}`
      }
    })

  // 测试：读取所有站点申请书并在控制台输出结果
  ctx.command('测试', '测试读取 Wikidot 申请书，并在控制台输出结果', { authority: config.approveAuthority ?? 2 })
    .usage('调用 Wikidot 接口读取所有站点待审批申请书，结果会输出到聊天与控制台日志。')
    .example('测试')
    .action(async () => {
      const missing = requireConfig()
      if (missing) return missing

      logger.info('【测试】开始读取申请书…')
      try {
        const lines: string[] = []
        for (const site of resolveSites()) {
          const client = newClient(site.wiki)
          const apps = await client.listApplications()
          logger.info(`【测试】站点 ${site.wiki} 共有 ${apps.length} 份待审批申请书`)
          apps.forEach((app, i) => {
            logger.info(`【测试】[${site.wiki}][${i + 1}] 申请人：${app.nickname}（@${app.username}，ID ${app.userId}）`)
            logger.info(`【测试】   申请书内容：${app.text || '（无）'}`)
          })
          if (apps.length) {
            lines.push(`📋 站点 ${site.wiki} 共有 ${apps.length} 份待审批申请书：`)
            apps.forEach((app, i) => {
              lines.push('')
              lines.push(`${i + 1}. 申请人：${app.nickname}（@${app.username}，ID ${app.userId}）`)
              lines.push(app.text ? indent(app.text, 4) : '   （无内容）')
            })
          }
        }
        if (!lines.length) return '当前所有站点都没有待审批的申请书。（控制台已输出结果）'
        return lines.join('\n')
      } catch (e) {
        const message = handleError(e)
        logger.error(`【测试】读取失败：${message}`)
        return `读取失败：${message}`
      }
    })


  // 将各站点待审批申请书转发到对应配置的群聊
  ctx.command('转发', '将各站点待审批申请书转发到对应群聊（含批准/拒绝按钮）', { authority: config.approveAuthority ?? 2 })
    .usage('需要在插件配置中为每个站点填写 target/targets（目标群聊列表）。')
    .example('转发')
    .action(async () => {
      const missing = requireConfig()
      if (missing) return missing
      const sites = resolveSites()
      if (!sites.some((s) => s.targets.length)) {
        return '尚未为任何站点配置转发目标群聊（sites[].target），请先填写。\n格式：platform:channelId，例如 onebot:123456789'
      }
      try {
        const lines: string[] = []
        let forwarded = 0
        for (const site of sites) {
          const client = newClient(site.wiki)
          const apps = await client.listApplications()
          if (!apps.length) {
            lines.push(`ℹ️ 站点 ${site.wiki} 当前没有待审批的申请书，无需转发。`)
            continue
          }
          if (!site.targets.length) {
            lines.push(`⚠️ 站点 ${site.wiki} 未配置转发目标，跳过。`)
            continue
          }
          const results = await sendToTargets(buildForwardMessage(site.wiki, apps), site.targets)
          // 仅当至少一个群聊发送成功时才标记为已处理（防止同一申请书重复发送）
          if (hasSuccess(results)) {
            apps.forEach((app) => processed.add(keyOf(site.wiki, app)))
            saveProcessed()
            forwarded += apps.length
          }
          lines.push(`📤 站点 ${site.wiki}（${apps.length} 份申请书）：`)
          results.forEach((r) => lines.push(r))
        }
        logger.info(`【转发】手动转发了 ${forwarded} 份申请书`)
        return `📤 转发完成：\n${lines.join('\n')}`
      } catch (e) {
        return `转发失败：${handleError(e)}`
      }
    })

  // 主动读取并处理各站点待审批的申请书（相当于手动触发一次定时扫描）
  ctx.command('扫描', '主动读取并处理各站点待审批的申请书', { authority: config.approveAuthority ?? 2 })
    .usage('立即执行一次扫描：读取所有站点待审批的申请书，在聊天中输出全部申请书内容，并将新申请自动转发到对应群聊。')
    .example('扫描')
    .action(async () => {
      const missing = requireConfig()
      if (missing) return missing
      return runScan(true)
    })

  // 处理群聊中点击的批准/拒绝按钮（按钮 ID 含站点名）
  ctx.on('interaction/button', async (session) => {
    const anySession = session as any
    const buttonId = anySession.button?.id ?? anySession.event?.button?.id
    if (!buttonId || !buttonId.startsWith('approve:')) return
    const [, action, wiki, userId] = buttonId.split(':')
    if ((action !== 'accept' && action !== 'decline') || !wiki || !userId) return

    const missing = requireConfig()
    if (missing) {
      await session.send(missing).catch(() => {})
      return
    }

    // 权限检查：点击者权限等级需达到要求
    const required = config.approveAuthority ?? 2
    const authority = anySession.user?.authority
    if (typeof authority !== 'number' || authority < required) {
      await session.send(`❌ 权限不足：需要权限等级 ≥ ${required} 才能审批。`).catch(() => {})
      return
    }

    const label = action === 'accept' ? '批准' : '拒绝'
    try {
      await newClient(wiki).decideApplication(userId, action)
      if (action === 'decline') {
        // 被拒绝后清除该用户的去重记录，允许其再次申请被扫描到
        removeUser(wiki, userId)
        saveProcessed()
      }
      await session.send(`✅ 已在站点 ${wiki} ${label}用户 ${userId} 的申请。`).catch(() => {})
      logger.info(`【审批】${anySession.user?.name || anySession.userId} 通过按钮在站点 ${wiki} ${label}了 ${userId} 的申请`)
    } catch (e) {
      const message = handleError(e)
      await session.send(`❌ ${label}失败：${message}`).catch(() => {})
      logger.warn(`【审批】按钮${label}失败：${message}`)
    }
  })

  // 定时扫描申请书：每隔一段时间扫描一遍所有站点（无论是否配置 targets 都会运行）
  const scanSeconds = (config.scanInterval && config.scanInterval > 0)
    ? config.scanInterval
    : (config.pollInterval && config.pollInterval > 0 ? config.pollInterval : 0)
  if (scanSeconds > 0) {
    // 与「扫描」指令共用同一套主动扫描逻辑
    ctx.setInterval(() => {
      runScan(false).catch(() => {})
    }, scanSeconds * 1000)
    logger.info(`【扫描】定时扫描已启用，每 ${scanSeconds} 秒扫描一遍申请书`)
  }
}

