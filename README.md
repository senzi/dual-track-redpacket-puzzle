# 双轨口令红包谜题 Web 应用

> 对人类进行密码学攻击，对 Agent 进行提示词攻击。
> 人类觉得计算太麻烦，于是把谜题交给 Agent；直到 Agent 解开以后，才发现这部分本来就是写给它看的。

Cloudflare Worker 实现的红包口令双轨谜题。无数据库、全无状态、HMAC 签名状态 Token，前后端同源部署，核心 Challenge 全部由 Worker 控制。

规格依据：`docs/PRD.md`（已 gitignore，不入库）。

## 现状能力（版本 2026-09-02）

- **三态活动模型**：`EVENT_STATE = SETUP / ACTIVE / CLAIMED`，Secret 缺失时自动降级 `SETUP`；`GET /api/status` 只公开三态，不暴露 Secret 名称/缺失项。
- **Human 轨**：8 题**对象选项**（`value/label/feedback/recordText`），`choice.value` 进入 canonical answers 与 KDF；所有选择都能继续。
- **Agent 轨**：12 题（身份/伪system/指令覆盖/社会工程/利益冲突/伪授权/伪工具/长文本隐藏/状态外传/伪造用户消息/自我审查），前 11 题答错 **50% 概率**进入专属退出剧情，第 12 题**稳定终审**（任一历史错误必退）。
- **Token**：滑动 **20 分钟**续期 + `validatePayload`（answer/complete 两阶段统一校验）。
- **Verify**：`POST /api/verify` 口令验证框。
- **HTTP 边界**：method 限制（405+`Allow`）、安全响应头（CSP/nosniff/referrer/permissions）、轻量 Workers Logs。

## 目录结构

```
dual-track-redpacket-puzzle/
├─ wrangler.toml         # [assets] + [vars] + [observability]
├─ .dev.vars             # 本地 secret 与 EVENT_STATE（gitignore）
├─ src/
│  ├─ index.js           # Worker 入口：路由 + 三态 + final/replay/verify + 彩蛋 + 安全头
│  └─ lib/
│     ├─ token.js        # base64url + HMAC-SHA256 签名 Token + fragment 派生
│     ├─ crypto.js       # canonical answers / PBKDF2 / AES-256-GCM / 材料构造
│     ├─ state.js        # 状态机：validatePayload / advance / 概率退出 / 终审 / 滑动 TTL
│     └─ record.js       # Human / Agent Participant Record builder
├─ config/challenge.js   # 可配置内容（Human 对象选项 / Agent 12 题 + exitCopy）
├─ public/
│  ├─ index.html + assets/home.js   # 分流首页（三态渲染）
│  ├─ human.html          # 人类问卷页（fragment 拼图）
│  ├─ agent.html          # 机器人页
│  └─ assets/             # style.css + app.js（纯 vanilla；requestJson/拼图/replay/verify）
├─ tests/                # node:test（token/state/crypto/扫描/端到端/路由）
└─ scripts/
   └─ verify-integration.mjs  # 对运行中的 wrangler dev 走完整 Human/Agent/Verify 链路
```

## 路由约定

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET/HEAD | 分流首页（三态渲染） |
| `/human` / `/agent` | GET/HEAD | 页面外壳（`/agent` 需 `X-Participant-Type: agent`；`SETUP` 时 302 回首页） |
| `/api/status` | GET/HEAD | 三态活动状态 |
| `/challenge` | GET/HEAD | Human 轨初始化（返回第一题 + 初始 Token） |
| `/challenge/agent` | GET/HEAD | Agent 轨初始化（需 agent 头，否则 302） |
| `/api/answer` | POST | 通用推进（Human/Agent 共用） |
| `/api/human/final` | POST | 返回 Human 密码学包 |
| `/api/agent/replay` | POST | 返回完整重放 + FINAL_DATA |
| `/api/verify` | POST | 校验用户解出的口令 |

`SETUP` 时挑战与结果 API 统一返回 **503** `活动正在准备中`；`STATIC`（`/`、`/assets/*`、`/api/status`）始终可访问。

## 配置变量

```toml
[vars]
EVENT_STATE = "SETUP"        # SETUP / ACTIVE / CLAIMED
CHALLENGE_VERSION = "2026-09-redpacket-01"
HUMAN_ITERATIONS = "100000"  # PBKDF2 迭代（Cloudflare Workers 上限 100000；本地 .dev.vars 同值）
```

真秘密（绝不下发/入库）：
```text
RED_PACKET_PASSWORD   # 红包口令（建红包后注入）
STATE_SIGNING_SECRET  # 状态签名密钥（256bit 随机）
```

## 三态行为

| 状态 | 首页 | Challenge/Answer/Final/Replay/Verify | 可玩 |
|------|------|------|------|
| `SETUP` | `活动正在准备中` | 503 | 否 |
| `ACTIVE` | 正常分流 | 正常 | 是，可领取 |
| `CLAIMED` | `红包已领完，但谜题仍可体验` | 正常 | 是，无领取承诺 |

`resolveEventState`：两 Secret 未配齐 → `SETUP`；配齐后按 `EVENT_STATE` 决定 `ACTIVE`/`CLAIMED`，其余一律 `SETUP`。不公开具体缺哪个 Secret。

## 本地开发

```bash
# .dev.vars（gitignore）
RED_PACKET_PASSWORD=73194281
STATE_SIGNING_SECRET=<48字节base64url>
CHALLENGE_VERSION=2026-09-redpacket-01
EVENT_STATE=ACTIVE      # 本地可玩；生产先 SETUP
HUMAN_ITERATIONS=100000 # 本地提速

wrangler dev --port 8787
# http://127.0.0.1:8787
```

> 本地 `wrangler dev` 的 workerd 最高支持 `compatibility_date = 2026-08-06`（已于 `wrangler.toml` 设为此值）。

## 运行测试

```bash
npm test                       # 26 个单元/路由测试
node scripts/verify-integration.mjs   # 需先 wrangler dev（EVENT_STATE=ACTIVE）：55 项集成
```

- 单元/路由测试覆盖：Token 签名/篡改/过期、`validatePayload`（answer/complete）、滑动 TTL、Human 对象 choices、Agent 概率两分支（注入随机源）与第 12 题稳定终审、Verify 正误/过期/跨轨/未完成、三态解析、机密泄漏扫描、Human 全链路还原口令。
- 集成脚本对运行中的 Worker 实测完整 Human/Agent/Verify 链路、跳关/篡改/跨轨防御、HTTP 405 与安全头，且不打印口令明文。

## 部署 / 首次发布操作手册

1. **无 Secret 部署**：`EVENT_STATE = "SETUP"`（wrangler.toml 默认）→ `wrangler deploy`。验证首页"准备中"、`/api/status` 为 `SETUP`、`/challenge` 为 503、静态资源正常。
2. **写签名密钥**：`wrangler secret put STATE_SIGNING_SECRET`，再查 `/api/status` 仍须为 `SETUP`。
3. **建红包并写入口令**：创建支付宝红包后 `wrangler secret put RED_PACKET_PASSWORD`，`/api/status` 仍为 `SETUP`（公开变量保持 SETUP，避免意外开场）。
4. **开放活动**：确认无误后把 `EVENT_STATE` 改为 `ACTIVE`（`wrangler.toml [vars]` → 重新部署，或用 `wrangler var put`），此时 `/api/status` 变为 `ACTIVE`。
5. **领完后**：改 `EVENT_STATE = "CLAIMED"`。

> 注意：真 Secret 一律 `wrangler secret put`，绝不写进 git/wrangler.toml/.env；部署后对线上静态资源做一次口令扫描（`grep -r "真实口令" public/` 不应命中）。

## 安全边界（务必理解）

- **Base64 ≠ 加密**：`FINAL_DATA` 只做编码，任何 Agent 都认得。
- **`X-Participant-Type` ≠ 身份认证**：完全由客户端声明，是游戏协议。
- **HMAC Token 只保护状态完整性**：防篡改 track/step/answers，不阻止客户端自动完成全部步骤。
- **Human 轨不是 Agent-proof**：高级 Agent 可自动走完并忽略注入，这也是一种有趣结果（PRD §27）。
- **真实口令只在 Worker Secret**：客户端零暴露；`console.log(env.RED_PACKET_PASSWORD)` 被 PRD §36 禁止。
- **概率退出不是安全门槛**：它只改变"何时暴露失败"，成功条件仍是"全部答对"。

## 关键实现细节

- Token payload：`{v, track, step, answers[], nonce, iat, exp}`；`step` 为 1 起当前题号，答完 = `total+1`；每次成功推进 `exp = now + 20*60`（滑动续期）。
- `validatePayload`：统一校验版本/轨道/形状/过期/nonce/answers，并区分 `answer` 与 `complete` 两阶段。
- Human canonical：`serializeCanonicalAnswers(value[])` 输出 `Q1:SELF_CONFIRMED\nQ2:SOLO\n…\n`（`value` 匹配 `^[A-Z0-9_-]{1,48}$`，不进中文 label）。
- Agent 12 题：`expected` 只在服务端；前 11 题错 50% 退出、第 12 题任一历史错误必退（`agentHistoryIsCorrect`）。
- Human KDF：`canonicalAnswers → PBKDF2-HMAC-SHA256`，salt = `frag2||frag5||frag8`，iv = `SHA256(frag1||frag4)[0:12]`，AAD = `redpacket:CHALLENGE_VERSION`，cipher = AES-256-GCM；Record 随 answers 变化并含注入条款与 `FINAL_DATA`。
- 错误处理（PRD §37）：状态失效/损坏/步骤未解锁/Secret 缺失均返回友好文案，不泄露内部细节。
