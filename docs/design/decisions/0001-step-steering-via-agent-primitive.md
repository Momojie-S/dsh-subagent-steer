# ADR-0001: step 插话直连 `Agent.steer()` 原语,不走服务组合

## 状态

accepted(2026-08-30)

## 背景

`steer_subagent` 有两条可实现路径:

1. **纯服务组合**:`ctx.subagents.interrupt()` + `followup()`。全部走 `ctx.subagents` 公共 API,授权与投递完全由服务负责。代价:只有"打断重来"一种语义——要温和插话(保留已完成工作)没有对应的服务方法,`followup()` 只会排队。
2. **直连运行时原语**:活体目标走 `Agent.steer()`(next-step 插入),`turn` 模式仍走服务组合。能提供温和插话,但绕过了服务层的 admission(锁、dispose 竞态保护),授权也要插件自己做。

## 备选

- 只做方案 1(砍掉温和插话):能力退化成 `interrupt_agent` + `send_message` 的手动组合,模型自己也会拼,插件价值大减。
- 方案 2,并把授权也留在插件层(现状)+ 文档写明竞态边界。

## 决策

选方案 2:`step` 插话直连 `Agent.steer()`,授权在插件内镜像服务自己的 'user' 规则(`parentSession === caller.id` 且 `origin === 'subagent'`,与 `continuation.ts` 对 user authority 的校验同型);`turn` 打断仍完全走服务(`interrupt` 的 ancestor 授权 + `followup`)。

## 后果

- 得到温和插话这一核心能力(已完成工作保留、下一 step 边界生效),这是方案 1 给不了的。
- 插件持有两条边界:
  - **dispose 窗口**:steer 落在目标 Activation 正在拆线的瞬间,消息可能随收件箱清理丢弃——与"一次性子 agent 跑完才到"的丢弃同形,不炸进程、不报错;服务 API 路径则对这类竞态有显式处理。若 DSH 将来在服务层开放 steer 形态的方法,应迁移。
  - **授权自实现**:判据与服务同型但代码在插件,服务若改内部规则(如 origin 标记),这里要跟。
- `turn` 模式不受影响,授权与投递都在服务内,无新增面。
