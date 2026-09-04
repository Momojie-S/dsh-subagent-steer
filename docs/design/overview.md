# dsh-subagent-steer 机制总览

子 agent 插话插件:把 agent 运行时内置、但没暴露成工具的 `Agent.steer()` 原语,包装成主 agent 可用的 `steer_subagent` 模型工具。

## 目标

- 向**正在工作**的后台子 agent 的当前轮插入新指示:下一个动作步骤(step 边界)前生效,已完成的工作保留
- 提供可选的硬打断模式(`mode: 'turn'`):终止当前轮重开,等价于 `interrupt_agent` + 立即投递
- 目标不在线/空闲时自动回退到官方 `send_message` 同款投递路径(冷恢复/唤醒),FIFO 顺序不变
- **不改变官方工具**:`send_message` 的排队语义、`interrupt_agent` 的打断语义原样保留;本插件纯增量

## 非目标

- **不改变子 agent 的回信机制**:插话即时生效,但回复与结算通知仍按 DSH 现有跨轮投递送达(忙时不打扰,轮次间隙送达)
- **不服务更深层后代**:直接子 agent 以外(`interrupt_agent` 候选)不在范围内
- **不保证一次性子 agent 的插话**:one-shot 子 agent 跑完即 dispose 并清空收件箱,插话若未被消费会随之丢弃;适用对象是 continuable 子 agent
- **不做排队消息的插队**:子 agent 收件箱是唯一队列,已排队的消息保持在 FIFO 原位,插话不越过它们

## 工作原理

```
steer_subagent(subagent_id, message, mode?)
        │
        ├─ route = resolveRoute(mode, live, running)     ← 纯函数,单测覆盖
        │
        ├─ route 'turn' ──► ctx.subagents.interrupt(keepInbox cancel)   ← 服务授权 ancestor
        │                   ctx.subagents.followup(唤醒投递,冷目标也可达)
        │
        ├─ route 'step' ──► 校验 child.header.parentSession === caller.id
        │                   且 child.header.origin === 'subagent'
        │                   └─► targetAgent.steer(userMessage)           ← 直连运行时原语
        │                       (inbox 的 next-step 位插入,忙时下一 step 边界消费,闲时唤醒)
        │
        └─ route 'wakeup' / 'cold-resume' ──► ctx.subagents.followup     ← 服务自有路径
```

关键机制对照:

| 环节 | 用了什么 | 为什么 |
|---|---|---|
| 温和插话 | `Agent.steer()`(next-step 插入) | 官方续管服务给忙碌父 agent 送结算通知用的同一原语;不丢已完成工作 |
| 硬打断 | `ctx.subagents.interrupt()` + `followup()` | 保持服务层授权与 keepInbox 语义,不自行 cancel |
| 活体子 agent | `ctx.agents.get(childId)` | 子 agent 经 `ctx.agents.create()` 注册,与官方 interrupt 授权同源 |
| 授权判据 | `session.header.parentSession` + `origin === 'subagent'` | 与服务 'user' 权限规则一致;`turn` 路由走服务的 ancestor 授权 |
| 消息构造 | `createUserMessage({ content, source })`,source 与 `send_message` 相同(coordinator/relay) | 子 agent 会话里两种消息来源一致,回放/冷恢复无差别 |

## 边界情况

| 场景 | 行为 |
|---|---|
| 目标空闲或冷(仅存于存储) | 回退 `followup`(唤醒/冷恢复),结果 `route` 注明实际路线 |
| 目标是别人的/更深层子 agent | `step` 路由:父链校验失败报错;`turn` 路由:服务 ancestor 授权拒绝 |
| 已有排队消息 | 插话不越队:排队消息保持 FIFO 原位;`step` 插话插在当前轮 next-step 位,先于排队消息被消费 |
| 一次性子 agent | 插话可能随其结算 dispose 被丢弃(收件箱清理);不报错 |
| 工具调用方不是活体 agent | 报错(与官方 `send_message` 行为一致) |

## 与原生工具的关系

| | `send_message` | `interrupt_agent` | 本插件 `steer_subagent` |
|---|---|---|---|
| 到达时机 | 当前整条指令完成后 | —(只停不投) | 默认下一 step 边界;`turn` 模式重开即达 |
| 已完成工作 | 全部保留 | 当前轮半成品作废 | 默认全保留;`turn` 模式当前轮半成品作废 |
| 典型用途 | 追加活儿(不急) | 叫停 | 中途纠偏/转向;`turn` 模式叫停并给新任务 |

决策记录见 [decisions/](./decisions/)。
