# koishi-plugin-approve

基于 [kakushi-w/WikidotAPI](https://github.com/kakushi-w/WikidotAPI)（`membership-apply.php` / `auth.py` / `membership_apply.py`）
实现的全自动审批申请书插件：读取 Wikidot 站点待审批的成员申请书内容，转发到指定群聊，并支持通过 / 拒绝。

## 特性

- 📖 **读取申请书**：调用 Wikidot `ManageSiteMembersApplicationsModule` 模块，列出站点待审批（`status = pending`）
  的申请书，展示申请人（ID / 用户名 / 昵称）和申请书内容
- 📤 **转发到群聊**：将申请书内容与用户名转发到指定群聊，附 **批准 / 拒绝按钮**；支持手动 `/转发` 或定时自动转发
- ✅ **审批**：支持点击群聊中的按钮审批，或通过指令 `审批 <用户名> <通过|拒绝>` 审批，均可附带回复语
- 🔍 支持通过用户名查询 user_id（`UserLookupQModule`）

## 配置

| 配置项 | 说明 |
| --- | --- |
| `username` | Wikidot 管理员账号（需有站点管理权限） |
| `password` | Wikidot 账号密码 |
| `wiki` | 站点名（不含 `.wikidot.com`，例如 `scp-wiki`） |
| `maxApplications` | 每次最多显示的申请书数量（默认 5，上限 20） |
| `targets` | 转发目标群聊列表，格式 `platform:channelId`，例如 `qq:123456789` |
| `scanInterval` | 定时扫描申请书间隔（秒），默认 300（5 分钟），设为 0 关闭；扫描到新申请时若配置了 targets 会自动转发 |
| `pollInterval` | 兼容旧配置：自动转发轮询间隔（秒），未配置 scanInterval 时作为扫描间隔 |
| `approveAuthority` | 通过按钮/指令审批所需的最低权限等级（默认 3=机器人所有者） |

在 Koishi 控制台中找到本插件并填写上述配置，或在 `koishi.yml` 中配置：

```yaml
plugins:
  approve:
    username: bot-account
    password: your-password
    wiki: your-site
    scanInterval: 300          # 每 5 分钟扫描一遍申请书
    targets:
      - 'qq:123456789'        # 转发目标群聊（扫描到新申请时自动转发）
    approveAuthority: 3
```

> ⚠️ **注意**：转发功能需要先启用对应的平台适配器（例如 QQ/OneBot/Telegram 等），
> 否则 `ctx.bots[platform]` 中找不到机器人。channelId 请使用 Koishi 中显示的实际频道 ID。

## 指令

- `申请书 [limit:number]` — 读取站点待审批的申请书内容
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
  `用户名` 为申请人的 Wikidot 用户名（「申请书」列表中的 @用户名）；填「全部」可批量通过/拒绝所有待审批申请书。
- `扫描` — 主动读取并处理待审批的申请书（扫描后输出全部待审批申请书内容；发现新申请会自动转发到目标群聊）
- `转发` — 将当前待审批申请书转发到所有配置的目标群聊（含批准/拒绝按钮）
- `测试` — 读取申请书并在控制台输出结果

> 指令均要求权限等级 ≥ 3（机器人所有者），可通过 `approveAuthority` 调整按钮审批的权限要求。

## 按钮审批

转发到群聊的消息会包含两个按钮：

```
📋 新成员申请书
申请人：lestday233（@lestday233，ID 7504264）
申请书内容：申请test

[✅ 批准]  [❌ 拒绝]
```

- 点击「批准」→ 调用 `acceptApplication`（`type=accept`）
- 点击「拒绝」→ 调用 `acceptApplication`（`type=decline`）
- 按钮 ID 格式为 `approve:accept:<user_id>` / `approve:decline:<user_id>`，由插件监听
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
