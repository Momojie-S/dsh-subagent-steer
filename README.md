# @momojie-s/dsh-subagent-steer

> **⚠️ 已废弃（2026-09-05）**：DSH 0.1.2-rc.1 移除了本插件依赖的 `ctx.subagents.followup` 服务操作，且官方 `send_message` 工具已原生覆盖同等能力（subagent 服务统一走 sendMessage，steer 语义内建）。本插件不再维护；在 0.1.2-rc.1+ 环境请直接使用官方 send_message。依赖本插件行为的部署请留在 0.1.1-rc.2 或迁移到官方工具。

给正在工作的后台子agent**当轮插入新指示**:主 agent 派出去的后台子 agent 干到一半时,把纠偏/补充指令直接送进它当前这一轮(下一个动作步骤前生效),而不是排在整条指令后面干等。官方 `send_message` 的默认排队行为完全不动,本插件只新增一个 `steer_subagent` 工具。

## 环境要求

- DSH `>= 0.1.0-rc.7`(已验证至 `0.1.1-rc.2`;依赖 `ctx.subagents.followup` / `interrupt`、`ctx.agents` 活体注册表、`Agent.steer` 的 next-step 插入语义)
- 仅 host 半部,无浏览器资源;Windows/Linux 均可
- **0.1.2-rc.1+ 不可用**:该版本移除了本插件依赖的 `ctx.subagents.followup` 服务操作(见顶部废弃声明)

## 用法

模型可见一个 `steer_subagent` 工具(工具名可配)。三种投递行为:

| 调用方式 | 子 agent 的反应 |
|---|---|
| `send_message`(官方,不变) | 排队:把**整条当前指令干完**,才读新消息 |
| `steer_subagent`(默认) | 插话:手头这一步做完(下一次思考前)就读新指示,**已完成的步骤保留**,剩余步骤按新指示走 |
| `steer_subagent` + `mode: "turn"` | 打断:立即停手,当前轮做到一半的**作废**,新指示作为全新一轮开始(已排队未消费的消息保留) |

参数:

| 参数 | 必填 | 说明 |
|---|---|---|
| `subagent_id` | ✅ | 后台子 agent 启动时返回的 id |
| `message` | ✅ | 要插入的指示 |
| `mode` | — | `'step'`(默认,温和插话)/ `'turn'`(硬打断重开);省略取默认 |

行为要点:

- **目标不在线时自动回退**:子 agent 空闲或只存于存储时,自动走与 `send_message` 相同的唤醒/冷恢复路径,FIFO 顺序不变(工具结果会注明实际走的路线 `route`)
- **授权**:只允许父 agent 插话自己的**直接**后台子 agent;更深层后代仍是 `interrupt_agent` 的候选
- **插话即时生效,回信照旧**:插话立刻进入子 agent 当前轮;但它的回复与结算通知仍按 DSH 现有机制跨轮送达
- **适用对象**:可继续(continuable)后台子 agent;一次性子 agent 若在读到插话前就跑完,插话会随收件箱清理被丢弃

## 安装

```bash
dsh plugin --profile web add github:Momojie-S/dsh-subagent-steer
# 首次按 pnpm 提示在 profile 的 pnpm-workspace.yaml 加 allowBuilds 授权构建
```

本仓开发机:`dsh plugin --profile web add <本目录路径>`,然后重启 DSH。

## 配置

patch `config` 字段(`cordis.patch.yml` 行内覆盖):

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `toolName` | string | `steer_subagent` | 模型可见工具名(多实例需互异) |

## 验证

主会话派一个慢速后台子 agent(如"从 1 数到 12,每步等 4 秒"),数到 3 左右时调用:

```
steer_subagent  subagent_id: <id>
  message: 当前步完成后立即停止计数,汇报你完成到第几步,并逐字引述本条指示
```

子 agent 的最终汇报引述了指示、完成步数停在 3 左右、剩余步骤未执行 = 全链路正常(实测 12 步任务在第 3 步被插话后,第 4~12 步零执行)。

设计取舍与机制详见 [docs/design/overview.md](./docs/design/overview.md)。
