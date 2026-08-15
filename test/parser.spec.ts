/**
 * parseApplications / decodeEntities 的单元测试
 * 运行方式：cd koishi-app && npx tsx plugins/approve/test/parser.spec.ts
 */
import { parseApplications, decodeEntities } from '../src/wikidot'

// 模拟 ManageSiteMembersApplicationsModule 返回的 HTML（含头像、用户链接、accept/decline 按钮）
const html = `
<h1>Current Member Applications:</h1>
<h3>Membership application from <a onclick="WIKIDOT.page.listeners.userInfo(12345); return false;" href="http://www.wikidot.com/user:info/alice"><img class="small" src="/common--images/avatars/12/12345/a16.png" alt="Alice"/>Alice</a></h3>
<table class="form alignleft">
  <tr>
    <td>
      Application text:
    </td>
    <td>
      我想加入这个站点，希望能一起协作。
    </td>
  </tr>
  <tr>
    <td>
      Options:
    </td>
    <td>
      <a href="javascript:;" onclick="WIKIDOT.modules.ManageSiteMembersApplicationsModule.listeners.accept(event, 12345, 'Alice', 'accept')">accept</a>
      or <a href="javascript:;" onclick="WIKIDOT.modules.ManageSiteMembersApplicationsModule.listeners.accept(event, 12345, 'Alice', 'decline')">decline</a>
    </td>
  </tr>
</table>
<h3>Membership application from <a onclick="WIKIDOT.page.listeners.userInfo(67890); return false;" href="http://www.wikidot.com/user:info/bob"><img src="..." alt="Bob"/>Bob</a></h3>
<table class="form alignleft">
  <tr>
    <td>
      Options:
    </td>
    <td>
      <a href="javascript:;" onclick="WIKIDOT.modules.ManageSiteMembersApplicationsModule.listeners.accept(event, 67890, 'Bob', 'accept')">accept</a>
      or <a href="javascript:;" onclick="WIKIDOT.modules.ManageSiteMembersApplicationsModule.listeners.accept(event, 67890, 'Bob', 'decline')">decline</a>
    </td>
  </tr>
</table>
`

// 现代 Wikidot 中文本地化版本（与真实站点返回结构一致）
const zhHtml = `
<h1>申请书<small>Users applying to your wiki</small></h1>
<h3>成员申请书来自 <span class="printuser avatarhover"><a href="http://www.wikidot.com/user:info/alice" onclick="WIKIDOT.page.listeners.userInfo(12345678); return false;"><img class="small" src="https://www.wikidot.com/avatar.php?userid=12345678&amp;amp;size=small" alt="alice"/></a><a href="http://www.wikidot.com/user:info/alice" onclick="WIKIDOT.page.listeners.userInfo(12345678); return false;" >alice</a></span></h3>
<table class="form alignleft">
  <tr>
    <td>申请书正文：</td>
    <td>我想加入这个站点，希望能一起协作。</td>
  </tr>
  <tr>
    <td>选项：</td>
    <td>
      <a href="javascript:;" onclick="WIKIDOT.modules.ManageSiteMembersApplicationsModule.listeners.accept(event, 12345678, 'alice', 'accept')" class="btn btn-primary">批准</a>
      <a href="javascript:;" onclick="WIKIDOT.modules.ManageSiteMembersApplicationsModule.listeners.accept(event, 12345678, 'alice', 'decline')" class="btn btn-danger">拒绝</a>
    </td>
  </tr>
</table>
`

// 1. 无申请时返回空数组
if (parseApplications('<h1>Current Member Applications:</h1><p>Sorry, no applications.</p>').length !== 0) {
  throw new Error('空列表解析失败')
}

// 2. 英文模板解析
const apps = parseApplications(html)
console.log('英文模板解析结果:', JSON.stringify(apps, null, 2))

if (apps.length !== 2) throw new Error(`应解析出 2 份申请，实际 ${apps.length}`)
const [a, b] = apps

if (a.userId !== '12345') throw new Error(`user_id 解析错误: ${a.userId}`)
if (a.username !== 'alice') throw new Error(`username 解析错误: ${a.username}`)
if (a.nickname !== 'Alice') throw new Error(`nickname 解析错误: ${a.nickname}`)
if (a.text !== '我想加入这个站点，希望能一起协作。') throw new Error(`申请书内容解析错误: ${a.text}`)

if (b.userId !== '67890') throw new Error(`user_id 解析错误: ${b.userId}`)
if (b.username !== 'bob') throw new Error(`username 解析错误: ${b.username}`)
if (b.nickname !== 'Bob') throw new Error(`nickname 解析错误: ${b.nickname}`)
if (b.text !== '') throw new Error(`空申请书内容解析错误: ${b.text}`)

// 3. 中文模板解析
const zhApps = parseApplications(zhHtml)
console.log('中文模板解析结果:', JSON.stringify(zhApps, null, 2))
if (zhApps.length !== 1) throw new Error(`应解析出 1 份申请，实际 ${zhApps.length}`)
const zh = zhApps[0]
if (zh.userId !== '12345678') throw new Error(`中文 user_id 解析错误: ${zh.userId}`)
if (zh.username !== 'alice') throw new Error(`中文 username 解析错误: ${zh.username}`)
if (zh.nickname !== 'alice') throw new Error(`中文 nickname 解析错误: ${zh.nickname}`)
if (zh.text !== '我想加入这个站点，希望能一起协作。') throw new Error(`中文申请书内容解析错误: ${zh.text}`)

// 4. HTML 实体反转义
if (decodeEntities('a &lt; b &amp; c &quot;d&quot; &#39;e&#39; &nbsp;x') !== 'a < b & c "d" \'e\'  x') {
  throw new Error(`decodeEntities 解析错误: ${decodeEntities('a &lt; b &amp; c &quot;d&quot; &#39;e&#39; &nbsp;x')}`)
}

console.log('✅ 所有解析器测试通过')
