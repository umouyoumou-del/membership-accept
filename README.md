# koishi-plugin-membership-accept

基于 [kakushi-w/WikidotAPI](https://github.com/kakushi-w/WikidotAPI)（`membership-apply.php` / `auth.py` / `membership_apply.py`）
实现的全自动审批申请书插件：读取 Wikidot 站点待审批的成员申请书内容，转发到指定群聊，并支持通过 / 拒绝。

## 特性

- 📖 **读取申请书**：调用 Wikidot `ManageSiteMembersApplicationsModule` 模块，列出**多个站点**待审批（`status = pending`）
  的申请书，展示申请人（ID / 用户名 / 昵称）和申请书内容
- 📤 **多站点转发**：每个站点 URL 对应一个 QQ 群，扫描到新申请书自动转发到对应群聊，附 **批准 / 拒绝按钮**
- ✅ **审批**：支持点击群聊中的按钮审批，或通过指令 `审批 <用户名> <通过|拒绝>` 审批，均可附带回复语；
  多站点时自动定位用户名所在的站点
- 🔁 **拒绝后可再申请**：被拒绝的账户再次提交申请书时，会被当作新申请重新扫描/转发
- 🔍 支持通过用户名查询 user_id（`UserLookupQModule`）

## 配置

| 配置项 | 说明 |
| --- | --- |
| `username` | Wikidot 管理员账号（需有站点管理权限） |
| `password` | Wikidot 账号密码 |
| `sites` | **多站点配置**：数组，每项 `{ wiki, target }`——`wiki` 为站点名（不含 `.wikidot.com`），`target` 为该站点对应的转发目标群聊（`platform:channelId`） |
| `wiki` | （旧版）单站点配置：站点名，配置 `sites` 后可留空 |
| `targets` | （旧版）单站点转发目标群聊列表，配置 `sites` 后可留空 |
| `maxApplications` | 每次最多显示的申请书数量（默认 5，上限 20） |
| `scanInterval` | 定时扫描申请书间隔（秒），默认 300（5 分钟），设为 0 关闭；扫描到新申请时自动转发到对应站点配置的群聊 |
| `pollInterval` | 兼容旧配置：自动转发轮询间隔（秒），未配置 scanInterval 时作为扫描间隔 |
| `approveAuthority` | 通过按钮/指令审批所需的最低权限等级（默认 3=机器人所有者） |

在 Koishi 控制台中找到本插件并填写上述配置，或在 `koishi.yml` 中配置：

```yaml
plugins:
  membership-accept:
    username: bot-account
    password: your-password
    scanInterval: 300          # 每 5 分钟扫描一遍申请书
    sites:
      - wiki: your-site-a       # 站点 A → 群 123456789
        target: 'onebot:123456789'
      - wiki: your-site-b       # 站点 B → 群 987654321
        target: 'onebot:987654321'
    approveAuthority: 3
```

> 💡 每个站点对应一个 QQ 群：扫描时按站点分别读取申请书，并只转发到该站点配置的 `target` 群聊。

> ⚠️ **注意**：转发功能需要先启用对应的平台适配器（例如 OneBot/NapCat、Telegram 等），
> 否则 `ctx.bots[platform]` 中找不到机器人。channelId 请使用 Koishi 中显示的实际频道 ID。

## 去重与再申请

- 已转发的申请书按 `站点 + 用户ID + 申请书内容` 记录去重，防止同一申请书被重复转发
- 通过「审批」或按钮**拒绝**某账户后，会自动清除该账户在对应站点的去重记录；
  该账户若再次提交申请书（内容相同或不同），都会被当作**新申请**重新扫描并转发
- 去重记录持久化保存在 `data/approve-processed.json`，重启不丢失

## 指令

- `申请书 [limit:number]` — 读取**所有站点**待审批的申请书内容（按站点分组展示）
  ```
  申请书
  申请书 10
  ```
- `审批 <用户名|全部> <通过|拒绝> [reply:text]` — 通过或拒绝申请书
  ```
  审批 alice 通过 欢迎加入！
  审批 alice 拒绝
  审批 全部 通过
  审批 全部 拒绝 不符合条件
  ```
  `用户名` 为申请人的 Wikidot 用户名（「申请书」列表中的 @用户名），插件会自动定位其在哪个站点；
  填「全部」可批量通过/拒绝**所有站点**全部待审批申请书。
- `扫描` — 主动读取并处理**所有站点**待审批的申请书（输出全部申请书内容；发现新申请会自动转发到对应站点配置的群聊）
- `转发` — 将各站点待审批申请书转发到对应站点配置的群聊（含批准/拒绝按钮）
- `测试` — 读取所有站点申请书并在控制台输出结果

> 指令均要求权限等级 ≥ 3（机器人所有者），可通过 `approveAuthority` 调整按钮审批的权限要求。

## 按钮审批

转发到群聊的消息会包含两个按钮：

```
📋 新成员申请书（站点 rule-wiki）
申请人：lestday233（@lestday233，ID 7504264）
申请书内容：申请test

[✅ 批准]  [❌ 拒绝]
```

- 点击「批准」→ 调用 `acceptApplication`（`type=accept`）
- 点击「拒绝」→ 调用 `acceptApplication`（`type=decline`）
- 按钮 ID 格式为 `approve:accept:<站点>:<user_id>` / `approve:decline:<站点>:<user_id>`（含站点名），由插件监听
  `interaction/button` 事件处理
- 支持按钮的平台（如 Telegram / Discord / QQ 键盘等）会显示为可点击按钮；
  其他平台会自动回退为纯文本，群内成员仍可通过「审批 <用户名> 通过|拒绝」指令操作

## 实现说明

读取逻辑与 Wikidot 官方站点管理后台一致：

1. **登录**：POST `Login2Action`（与 `auth.py` 相同），并从站点根页面获取 `wikidot_token7` CSRF cookie
2. **读取申请书**：POST `ajax-module-connector.php`，`moduleName=managesite/ManageSiteMembersApplicationsModule`，
   该模块查询 `member_application` 表中 `status = 'pending'` 的记录（按 `application_id` 倒序），
   每条记录的 `comment` 字段即申请书内容
3. **审批**：POST `action=ManageSiteMembershipAction&event=acceptApplication&user_id&type=accept|decline&text=回复`
   （与官方前端 `ManageSiteMembersApplicationsModule.js` 一致）

> 注意：本插件使用 Node.js 内置 `fetch` 直连 `*.wikidot.com`。若运行环境需要通过代理访问外网，
> 请在系统环境变量或 Koishi 中配置相应的 HTTP(S) 代理。
