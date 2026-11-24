# 输入框吞吐统计（Composer Throughput Stats）

## 目标

在输入框下方常驻一行只读统计，直接展示最近一次模型输出速率与会话 token / 缓存命中，替代“必须打开开发者工具才能看到 TPS”的现状。

## 数据所有权

UI 只读既有事实，不新增状态、不新增 RPC、不改协议：

| 指标       | 来源                                                                                                | 缺失处理                          |
| ---------- | --------------------------------------------------------------------------------------------------- | --------------------------------- |
| 轮次       | `snapshot.rows.window` 中最近一个带 `historyRoundCount` 的 `turnHeader`                             | 窗口被裁剪或旧投影无该字段 → 省略 |
| tok/s      | `readSessionDebug().rounds` 中最近一次主链路请求的 `tokensPerSecond`（与开发者工具同源同口径）      | 尚无速率事实 → 省略整段           |
| 会话 token | `snapshot.usage.contextWindow.usedTokens`，缺失时回退 `usage.cumulative.inputTokens + outputTokens` | 都为 0 → 省略整段                 |
| 缓存命中率 | `snapshot.usage.contextWindow.cache.hitRate`                                                        | 旧快照无该字段 → 省略整段         |

`snapshot` 与 `session-debug` 的唯一所有者仍是 CLI；renderer 不复制、不缓存、不二次聚合跨会话数据。

## 展示时机

- 行本身：拿到 `snapshot` 且任一指标可用时出现；新任务草稿态（`snapshot === null`）与三段全空时不渲染。
- 轮次与 tok/s：挂载会话与每轮进入终态（`completedSuccess` / `completedInterrupted` / `error`）时读一次 `session-debug`，**不按 1s 轮询**；`running` / `prewarming` 期间沿用上一次结果。
- token 与缓存命中：随 snapshot 实时更新。

## 展示契约

- 位置：输入卡正下方、**滚动容器之外**（`ConversationTimeline` 的 `belowDockContent`），桌面与手机 Web 共用。
- 形态：单行、居中、`text-ui-xs` + `text-foreground-subtle` + `tabular-nums`，分段以 `·` 连接，例如 `第 12 轮 · 148 tok/s · 343K tok · 缓存命中 91%`。
- `data-testid="composer-throughput-stats"` 作为验收锚点。
- 任一段缺失只省略该段；各段全部缺失时整行不渲染，不占高度、不产生布局跳动。
- 窄窗口下整行保持单行并截断，不换行、不挤占发送按钮。
- 不能放进 composer dock（scroll 区内的 sticky 透明层）：dock 加高后滚动中的消息会从新增区域透出来并与统计文字重叠（2026-11-24 实测）。放在 scroll 容器之外后，overflow 直接裁掉消息，因此这一行既不需要底色，也不会撑高 dock。

## 口径说明

- tok/s 与开发者工具逐行值一致：分母是首输出到请求结束的生成段耗时，不含 TTFT。
- 不使用 `turnHeader.modelDurationMs`：该字段只在加速卡（highspeed）轮次写入，普通轮次恒为缺失（`product-projection.ts` 的 highspeed 计时器带 provider 判定）。
- 展示的是“最近一次请求”的速率，不是整轮平均，也不承诺历史轮统计。
- 轮次不使用 `turnHeader.historyRoundCount`：该字段在每个用户 turn 内从 0 重新累计模型步数（`turn.ts` 初始化 + `recordModelHistoryRound`），展示成“第 N 轮”会每轮回到 1。

## 不做

- 不放输入卡内部：产品要求与 dsh/Kimi 一致，统计在卡下方、不占用输入区。
- 不做每条回复内的轮次级展示（后续可复用同一组件，需再穿透 unit → row 的 props）。
- 不改 `packages/shared`、CLI 协议、`session-debug` RPC 契约。
- 不做步骤计数：`rows.window` 裁剪后 tool 行数不可靠；轮次号只取 turnHeader 的权威 `historyRoundCount`。

## 验收场景

1. 新会话、无数据：不出现统计行，composer 高度与改动前一致。
2. 完成一轮后：显示轮次、tok/s、会话 token、缓存命中四段。
3. 流式中（`running`）：token / 缓存随 snapshot 更新，tok/s 保持上一轮数值，不发起额外请求。
4. 旧快照缺少 `contextWindow.cache`：仅显示轮次、tok/s 与 token 段。
5. 切换到另一个会话：先不显示上一会话的 tok/s，读取完成后更新。
6. 一轮内多次模型调用：轮次随每次主链路请求递增，与开发者工具“轮次”列一致。
7. 窄窗口与手机 Web：单行不溢出，发送按钮与工具条位置不变。
