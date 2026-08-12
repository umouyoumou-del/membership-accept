/**
 * Wikidot API 客户端
 *
 * 参照 kakushi-w/WikidotAPI（scripts/auth.py、scripts/membership_apply.py）
 * 以及 Wikidot 官方源码（github.com/gabrys/wikidot）实现：
 *
 *  - 登录：      POST /default--flow/login__LoginPopupScreen（Login2Action）
 *  - CSRF：      获取站点 wikidot_token7 cookie
 *  - 读取申请书：ManageSiteMembersApplicationsModule（筛选 status = pending）
 *  - 审批申请书：ManageSiteMembershipAction / acceptApplication（type = accept | decline）
 *  - 用户查询：  UserLookupQModule（用户名 → user_id）
 */

const LOGIN_URL = 'https://www.wikidot.com/default--flow/login__LoginPopupScreen'
const TEST_URL = 'https://www.wikidot.com/account/activity'
const USER_LOOKUP_URL = 'https://www.wikidot.com/quickmodule.php'
const AJAX_URL = 'https://{site}/ajax-module-connector.php'

/** 一份成员申请书 */
export interface WikidotApplication {
  /** 申请人 user_id */
  userId: string
  /** 申请人用户名（不含 @，与 user:info 页面一致） */
  username: string
  /** 申请人昵称 */
  nickname: string
  /** 申请书内容（comment 字段） */
  text: string
}

export class WikidotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WikidotError'
  }
}

/** 一条带域名信息的 Cookie */
interface CookieEntry {
  value: string
  /** cookie 所属域名（host-only 时为设置它的主机名） */
  domain?: string
  /** 是否为 host-only cookie */
  hostOnly: boolean
}

export class WikidotClient {
  private readonly site: string
  private readonly timeout: number
  /** 带域名的 Cookie 存储（同名取最后写入） */
  private cookies = new Map<string, CookieEntry>()
  private token7 = ''
  private authed = false

  constructor(
    private readonly username: string,
    private readonly password: string,
    wiki: string,
    timeout = 30000,
  ) {
    this.site = `${wiki}.wikidot.com`
    this.timeout = timeout
  }

  /** 解析并保存 Set-Cookie 响应头（记录所属域名，供请求时按域过滤） */
  private setCookies(headers: Headers, host: string): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      let domain: string | undefined
      let hostOnly = true
      for (const attr of attrs) {
        const eq2 = attr.indexOf('=')
        const k = (eq2 === -1 ? attr : attr.slice(0, eq2)).trim().toLowerCase()
        const v = eq2 === -1 ? '' : attr.slice(eq2 + 1).trim()
        if (k === 'domain' && v) {
          domain = v.toLowerCase()
          hostOnly = false
        }
      }
      const removed = value.toLowerCase() === 'deleted'
        || attrs.some((attr) => {
          const eq2 = attr.indexOf('=')
          const k = (eq2 === -1 ? attr : attr.slice(0, eq2)).trim().toLowerCase()
          const v = eq2 === -1 ? '' : attr.slice(eq2 + 1).trim()
          return (k === 'max-age' && v === '0') || (k === 'expires' && /^thu, 01 jan 1970/.test(v))
        })
      if (removed) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, { value, domain: hostOnly ? host : domain, hostOnly })
      }
    }
  }

  /** 构造 Cookie 请求头：仅发送与目标主机域名匹配的 Cookie */
  private cookieHeader(url: string | URL): string {
    const host = new URL(url).hostname.toLowerCase()
    return [...this.cookies.entries()]
      .filter(([, entry]) => {
        if (entry.hostOnly) return entry.domain === host
        const d = (entry.domain ?? '').replace(/^\./, '')
        return host === d || host.endsWith('.' + d)
      })
      .map(([k, entry]) => `${k}=${entry.value}`)
      .join('; ')
  }

  /**
   * 发起请求：手动跟随重定向，并收集整个重定向链路上每个响应的 Cookie
   * （fetch 的 redirect: 'follow' 只会暴露最后一个响应的响应头，无法取到会话 Cookie）
   * 对 5xx（服务端暂时不可用/限流）自动重试，最多 3 次，指数退避。
   */
  private async request(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
    const maxRetries = 3
    const DEFAULT_HEADERS = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      accept: '*/*',
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let current = url
      let options = init
      let retryable = false
      for (let i = 0; i <= maxRedirects; i++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)
        let res: Response
        try {
          res = await fetch(current, {
            ...options,
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              ...DEFAULT_HEADERS,
              ...options.headers,
              // 关键：将收集到的会话 Cookie 附加到每个请求上（按域名过滤）
              ...(this.cookies.size ? { Cookie: this.cookieHeader(current) } : {}),
            },
          })
        } finally {
          clearTimeout(timer)
        }
        this.setCookies(res.headers, new URL(current).hostname)
        // 5xx：服务端暂时不可用或限流，稍后整体重试
        if (res.status >= 500) {
          res.body?.cancel()
          retryable = true
          break
        }
        if (res.status < 300 || res.status >= 400) return res
        const location = res.headers.get('location')
        if (!location) return res
        current = new URL(location, current).toString()
        const method = (options.method ?? 'GET').toUpperCase()
        if ((res.status === 301 || res.status === 302 || res.status === 303) && method !== 'GET' && method !== 'HEAD') {
          options = { ...options, method: 'GET', body: undefined }
        }
      }
      if (retryable && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
        continue
      }
      if (retryable) {
        throw new WikidotError('服务器暂时不可用（连续多次返回 5xx），请稍后重试')
      }
      throw new WikidotError('请求重定向次数过多')
    }
    throw new WikidotError('请求重定向次数过多')
  }

  /** 登录 Wikidot 并校验登录结果 */
  async login(): Promise<void> {
    const form = new URLSearchParams({
      login: this.username,
      password: this.password,
      originSiteId: '648902',
      action: 'Login2Action',
      event: 'login',
    })
    const res = await this.request(LOGIN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    // 登录失败时，服务器会在返回的页面中附带错误横幅，如：
    //   <h2 class="title error alert alert-danger">
    //   The login and password do not match.
    const html = await res.text()
    const errorMatch = html.match(/<h2[^>]*class="[^"]*\berror\b[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h2>/i)
    if (errorMatch) {
      throw new WikidotError(`Wikidot 登录失败（账号 ${this.username}）：${decodeEntities(errorMatch[1].trim())}`)
    }
    // 备用校验：访问活动页，确认会话已建立
    const test = await this.request(TEST_URL)
    const text = await test.text()
    if (text.includes('Sign in')) {
      throw new WikidotError(`登录失败，请检查 Wikidot 账号（${this.username}）与密码`)
    }
  }

  /** 获取站点 CSRF token（wikidot_token7） */
  async getToken7(): Promise<void> {
    const res = await this.request(`https://${this.site}/`)
    await res.text()
    this.token7 = this.cookies.get('wikidot_token7')?.value ?? ''
    if (!this.token7) {
      throw new WikidotError('无法获取 wikidot_token7，请确认该账号拥有站点管理权限')
    }
  }

  private async ensureAuth(): Promise<void> {
    if (this.authed) return
    await this.login()
    await this.getToken7()
    this.authed = true
  }

  /** 调用站点 AJAX 接口（ajax-module-connector.php） */
  private async ajax(payload: Record<string, string>): Promise<Record<string, unknown>> {
    await this.ensureAuth()
    const form = new URLSearchParams({
      ...payload,
      callbackIndex: '0',
      wikidot_token7: this.token7,
    })
    const res = await this.request(`https://${this.site}/ajax-module-connector.php`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: `https://${this.site}/admin:membership`,
      },
      body: form.toString(),
    })
    let data: Record<string, unknown>
    try {
      data = await res.json() as Record<string, unknown>
    } catch {
      throw new WikidotError(`AJAX 接口返回了非 JSON 内容（HTTP ${res.status}）`)
    }
    if (String(data.status).toLowerCase() !== 'ok') {
      throw new WikidotError(String(data.message ?? `AJAX 请求失败（${String(data.status)}）`))
    }
    return data
  }

  /** 读取站点待审批的申请书列表 */
  async listApplications(): Promise<WikidotApplication[]> {
    const data = await this.ajax({
      moduleName: 'managesite/ManageSiteMembersApplicationsModule',
    })
    return parseApplications(String(data.body ?? ''))
  }

  /** 通过用户名查询 user_id */
  async lookupUser(username: string): Promise<string> {
    await this.login()
    const res = await this.request(`${USER_LOOKUP_URL}?module=UserLookupQModule&q=${encodeURIComponent(username)}`)
    const data = await res.json() as { users?: Array<{ user_id?: number | string }> }
    const userId = data.users?.[0]?.user_id
    if (userId == null) {
      throw new WikidotError(`未找到用户 ${username}`)
    }
    return String(userId)
  }

  /**
   * 审批申请书
   * @param userId 申请人 user_id
   * @param type   通过或拒绝
   * @param text   附加回复（可选）
   */
  async decideApplication(userId: string, type: 'accept' | 'decline', text = ''): Promise<void> {
    await this.ajax({
      action: 'ManageSiteMembershipAction',
      event: 'acceptApplication',
      moduleName: 'Empty',
      user_id: userId,
      type,
      text,
    })
  }
}

/**
 * 解析「待审批申请书」模块返回的 HTML
 *
 * 模板结构（templates/modules/managesite/ManageSiteMembersApplicationsModule.tpl）：
 *   <h3>成员申请书来自 {printuser}</h3>
 *   <table>
 *     <tr><td>申请书正文：</td><td>{comment}</td></tr>
 *     <tr><td>选项：</td>
 *         <td><a onclick="...listeners.accept(event, {userId}, '{nickname}', 'accept')">批准</a> ...</td></tr>
 *   </table>
 * 注意：现代 Wikidot 已中文本地化，但旧英文模板（Membership application from / Application text:）
 * 仍可能出现在部分站点，因此两种标签都支持。
 */
export function parseApplications(html: string): WikidotApplication[] {
  const applications: WikidotApplication[] = []
  const parts = html.split(/<h3>(?:membership application from|成员申请书来自)/i)
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i]
    const accept = block.match(/listeners\.accept\(\s*event,\s*(\d+),\s*'([^']*)'/)
    const username = block.match(/user:info\/([a-zA-Z0-9_\-]+)/)?.[1] ?? ''
    applications.push({
      userId: accept?.[1] ?? '',
      nickname: accept?.[2] ?? '',
      username,
      text: extractApplicationText(block),
    })
  }
  return applications
}

/** 从单个申请区块中提取「申请书内容」（申请书正文 / Application text 后的单元格） */
function extractApplicationText(block: string): string {
  const marker = block.match(/(?:application\s*text|申请书正文)\s*[:：]?/i)
  if (!marker) return ''
  const rest = block.slice(marker.index! + marker[0].length)
  const tdOpen = rest.indexOf('<td')
  if (tdOpen === -1) return ''
  const afterTd = rest.slice(tdOpen)
  const gt = afterTd.indexOf('>')
  if (gt === -1) return ''
  const inner = afterTd.slice(gt + 1)
  const tdClose = inner.indexOf('</td>')
  if (tdClose === -1) return ''
  return decodeEntities(inner.slice(0, tdClose).trim())
}

/** 反转义 HTML 实体 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}
