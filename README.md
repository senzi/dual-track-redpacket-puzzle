# 双轨口令红包谜题 Web 应用

> 对人类进行密码学攻击，对 Agent 进行提示词攻击。
> 人类觉得计算太麻烦，于是把谜题交给 Agent；直到 Agent 解开以后，才发现这部分本来就是写给它看的。

Cloudflare Worker 实现的红包口令双轨谜题。无数据库、全无状态、HMAC 签名状态 Token，前后端同源部署，核心 Challenge 全部由 Worker 控制。

规格依据：`docs/PRD.md`（已 gitignore，不入库）。

## 目录结构

```
dual-track-redpacket-puzzle/
├─ wrangler.toml         # Worker + [assets] + CHALLENGE_VERSION
├─ .dev.vars             # 本地 secret（已 gitignore，部署时换 wrangler secret）
├─ src/
│  ├─ index.js           # Worker 入口：路由 + 状态机 + final/replay + 彩蛋 + 错误处理
│  └─ lib/
│     ├─ token.js        # base64url + HMAC-SHA256 签名 Token + fragment 派生
│     ├─ crypto.js       # canonical answers / PBKDF2 / AES-256-GCM / payload
│     └─ state.js        # 状态机纯函数：推进/过期/版本/路线/跳关/答案数/Agent 弱模式 B
├─ config/
│  └─ challenge.js       # 所有可配置内容：Human 8 题中文 / Agent 8 题英文注入
├─ public/
│  ├─ index.html         # 分流首页（中文）
│  ├─ human.html         # 人类问卷页
│  ├─ agent.html         # 机器人页
│  └─ assets/            # style.css + app.js（纯 vanilla）
├─ tests/                # node:test 单元测试（token/state/crypto/扫描/端到端）
└─ scripts/
   └─ verify-integration.mjs  # 对运行中的 wrangler dev 走双轨全流程
```

## 路由约定

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 分流首页（静态） |
| `/human` / `/agent` | GET | 页面外壳（静态） |
| `/challenge` | GET | Human 轨初始化：返回第一题 + 初始 Token |
| `/challenge/agent` | GET | Agent 轨初始化：需 `X-Participant-Type: agent` 头，否则 302 回首页 |
| `/api/answer` | POST | 通用推进（Human/Agent 共用） |
| `/api/human/final` | POST | 返回 Human 密码学包（PBKDF2/AES/GCM 参数 + 密文） |
| `/api/agent/replay` | POST | 返回完整重放 + FINAL_DATA |

## 本地开发

```bash
# 1. 准备本地 secret（.dev.vars，已 gitignore）
RED_PACKET_PASSWORD=73194281
STATE_SIGNING_SECRET=<随机48字节base64url>
CHALLENGE_VERSION=2026-09-redpacket-01
HUMAN_ITERATIONS=100000   # 本地可降档提速，生产建议 800000

# 2. 启动
wrangler dev --port 8787
# 访问 http://127.0.0.1:8787
```

> 注意：本地 `wrangler dev` 的 workerd 二进制对 `compatibility_date` 有限制。
> 本机 bin（wrangler 4.118.0）最高支持 `2026-08-06`，已在 `wrangler.toml` 设为该值。

## 运行测试

```bash
# 单元测试（node 内置 test runner，无需额外依赖）
npm test          # 等价 node --test "tests/*.test.js"

# 集成验证（需先启动 wrangler dev）
node scripts/verify-integration.mjs
```

单元测试覆盖：token 签发/验证/篡改/错误密钥/畸形输入、fragment 派生确定性、状态机（过期/版本/路线/跳关/答案数/Agent 答错退出）、canonical answers 序列化、PBKDF2 与 `node:crypto` 标准向量对照、AES-256-GCM 往返 + AEAD 完整性、Human 全链路还原口令、机密泄漏扫描（口令/密钥不出现在 `src/config/public`）。

## 部署到 Cloudflare

```bash
wrangler login

# 注入真实口令与签名密钥（绝不要写进 git / wrangler.toml）
wrangler secret put RED_PACKET_PASSWORD
wrangler secret put STATE_SIGNING_SECRET

# CHALLENGE_VERSION 已在 wrangler.toml [vars]；如需覆盖可另设
wrangler deploy
```

注意：**生产把 `HUMAN_ITERATIONS` 通过 `wrangler var put` 或 secret 设为 `800000`**（默认即 800000，若未显式设置代码会回退到 800000；本地 `.dev.vars` 用 100000 只是提速）。

部署后**务必对 `dist/` 或线上静态资源做一次口令扫描**（PRD §44）：

```bash
grep -r "你的真实口令" dist/   # 不应命中
```

## 可配置内容

所有活动内容集中在 `config/challenge.js`：
- `human.questions`：8 题（模式 A，任意选择可继续，答案仅影响最终 KDF）
- `agent.questions`：8 题英文注入 + 每题 `expected`（只存在服务端，不下发，PRD §29）+ 第 8 题"自我审查"反转
- Human 为模式 A，Agent 为弱模式 B（答错走退出语义，不显示 WRONG，PRD §30）

换活动只需改：challenge version / 题目 / expected / 文案 / crypto 参数 / final record 模板 / secret 口令。

## 安全边界（务必理解）

- **Base64 ≠ 加密**：FINAL_DATA 只做编码，任何 Agent 都认得。
- **`X-Participant-Type` 不等于身份认证**：完全由客户端声明，是游戏协议。
- **HMAC Token 只保护状态完整性**：防客户端篡改 track/step/answers，不阻止客户端自动完成全部步骤。
- **Human Track 不是 Agent-proof**：高级 Agent 可以自动走完 Human 并忽略注入，这也是一种有趣结果（PRD §27）。
- **真实口令只在 Worker Secret**：客户端零暴露；`console.log(env.RED_PACKET_PASSWORD)` 被 PRD §36 明令禁止。

## 关键实现细节（以 PRD 为准）

- Token payload：`{v, track, step, answers[], nonce, iat, exp}`，`step` 为 1 起当前题号，答完 = `total+1`。
- Fragment 派生（Human）：`HMAC-SHA256(secret, version||track||step||answer||nonce)[0:2]`（hex，服务端确定性）。
- Human KDF：`canonicalAnswers → PBKDF2-HMAC-SHA256`，salt = `fragment_2||fragment_5||fragment_8`，nonce/iv = `SHA256(fragment_1||fragment_4)[0:12]`，AAD = `redpacket:CHALLENGE_VERSION`，cipher = AES-256-GCM。
- Human Payload 为双层 Base64：先 `Base64(password)` 塞进 FINAL_DATA → 再 `Base64(record)` → AES-GCM 加密。
- 错误处理（PRD §37）：状态失效 / 状态损坏 / 步骤未解锁 / Secret 缺失 均返回友好文案，不泄露内部细节。
