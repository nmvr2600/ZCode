# 输入框吞吐统计（Composer Throughput Stats）

## 目标

在输入框下方常驻一行只读统计，直接展示最近一次模型输出速率与会话 token / 缓存命中，替代“必须打开开发者工具才能看到 TPS”的现状。

## 术语（三者不是一回事）

| 概念                      | 含义                                                                          | 权威字段                              | 本项目是否展示                                      |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| 用户轮次（product turn）  | 一次用户输入到该轮结束，对应一行 `turnHeader`；`control.phase` 只在整轮上变化 | `turnHeader`                          | 不展示                                              |
| 模型请求（model request） | 轮内的一次主链路模型调用；一轮里可以连续发生多次                              | `session-debug.rounds[].requestIndex` | **展示**（“第 N 次请求”，与开发者工具“轮次”列同源） |
| 轮内历史轮次              | 同一次用户输入内已提交的模型步数，每个用户轮次从 0 重新累计                   | `turnHeader.historyRoundCount`        | 不展示                                              |

`control.phase` 只在用户轮次粒度上变化（running → completed\*），因此“每次模型请求完成”无法从 snapshot 事件感知，只能靠运行期拉取 `session-debug`。

## 数据所有权

UI 只读既有事实，不新增状态、不新增 RPC、不改协议：

| 指标       | 来源                                                                                                | 缺失处理                          |
| ---------- | --------------------------------------------------------------------------------------------------- | --------------------------------- |
| 轮次       | `readSessionDebug().rounds` 最近一条的 `requestIndex`（与开发者工具“轮次”列同源）                  | 尚无请求事实 → 省略整段           |
| tok/s      | `readSessionDebug().rounds` 中最近一次主链路请求的 `tokensPerSecond`（与开发者工具同源同口径）      | 尚无速率事实 → 省略整段           |
| 会话 token | `snapshot.usage.contextWindow.usedTokens`，缺失时回退 `usage.cumulative.inputTokens + outputTokens` | 都为 0 → 省略整段                 |
| 缓存命中率 | `readSessionDebug().cache.hitRate`（与开发者工具“平均命中”同源同窗口）                              | 窗口内无请求或存在未知缓存用量 → 省略整段 |

`snapshot` 与 `session-debug` 的唯一所有者仍是 CLI；renderer 不复制、不缓存、不二次聚合跨会话数据。

## 展示时机

- 行本身：拿到 `snapshot` 且任一指标可用时出现；新任务草稿态（`snapshot === null`）与各段全空时不渲染。
- 轮次、tok/s、输出与缓存命中：由 `snapshot.usage` 变化驱动 —— CLI 每次主链路请求完成都会推一次 usage 投影，
  行内据此读一次 `session-debug`，并在 400ms 后补读一次确认（debug 旁路记录与 usage 同事件写入，
  快照帧可能先到）。**不设定时轮询**；空闲会话不产生读取。
  - 为什么不用事件推送：CLI 没有推送 per-request token 与耗时的通知（`localTtftFacts` 只带 TTFT
    时间点），`session-debug` 是拉取型接口；usage 投影是当前唯一“每请求一次”的推送事实，因此用它
    当触发器。
  - 与开发者工具的时序：开发者工具按 1s 轮询同一份事实，本行在 usage 帧到达时立即读，因此不会晚于它。
- 会话 token：随 snapshot 实时更新（上下文水位，与 session-debug 观察窗口无关）。

## 展示契约

- 位置：输入卡正下方、**滚动容器之外**（`ConversationTimeline` 的 `belowDockContent`），桌面与手机 Web 共用。
- 形态：单行、居中、`text-ui-xs` + `text-foreground-subtle` + `tabular-nums`，分段以 `·` 连接，例如 `第 12 次请求 · 148 tok/s · 输出 177 · 343K tok · 缓存命中 91.4%`。
- 缓存命中率保留 1 位小数：`hitRate` 是 `totalCacheReadTokens / totalInputTokens` 的浮点比例，取整会把 98.6% 显示成 99%，也与上下文胶囊、开发者工具（同为 1 位小数）口径不一致。
- `data-testid="composer-throughput-stats"` 作为验收锚点。
- 任一段缺失只省略该段；各段全部缺失时整行不渲染，不占高度、不产生布局跳动。
- 窄窗口下整行保持单行并截断，不换行、不挤占发送按钮。
- 不能放进 composer dock（scroll 区内的 sticky 透明层）：dock 加高后滚动中的消息会从新增区域透出来并与统计文字重叠（2026-11-24 实测）。放在 scroll 容器之外后，overflow 直接裁掉消息，因此这一行既不需要底色，也不会撑高 dock。

## 口径说明

- tok/s 与开发者工具逐行值一致：分母是首输出到请求结束的生成段耗时，不含 TTFT。
- 缓存命中率与开发者工具“平均命中”一致：两者都读 session-debug 旁路，口径为
  `totalCacheReadTokens / totalInputTokens`，统计窗口都是**当前 CLI 进程内已观察到的主链路请求**
  （会话 resume 后从第 1 次重新累计）。
  - 不用 `snapshot.usage.contextWindow.cache.hitRate`：那是 runtime 的会话级聚合，resume 时按全部
    持久化 assistant 消息回填（`mainTurnCacheHitAggregateFromMessages`），与新进程观察到的事实窗口
    不同，会让同一界面出现两个“缓存命中”（2026-11-24 实测 97.1% vs 99.3%）。
- 不使用 `turnHeader.modelDurationMs`：该字段只在加速卡（highspeed）轮次写入，普通轮次恒为缺失（`product-projection.ts` 的 highspeed 计时器带 provider 判定）。
- 展示的是“最近一次请求”的速率，不是整轮平均，也不承诺历史轮统计。
- 轮次不使用 `turnHeader.historyRoundCount`：该字段在每个用户 turn 内从 0 重新累计模型步数（`turn.ts` 初始化 + `recordModelHistoryRound`），展示成“第 N 轮”会每轮回到 1。

## 不做

- 不放输入卡内部：产品要求与 dsh/Kimi 一致，统计在卡下方、不占用输入区。
- 不做每条回复内的轮次级展示（后续可复用同一组件，需再穿透 unit → row 的 props）。
- 不改 `packages/shared`、CLI 协议、`session-debug` RPC 契约。
- 不做步骤计数：`rows.window` 裁剪后 tool 行数不可靠；轮次号只取 session-debug 的 `requestIndex`。

## 验收场景

1. 新会话、无数据：不出现统计行，composer 高度与改动前一致。
2. 完成一轮后：显示轮次、tok/s、输出、会话 token、缓存命中五段。
3. 流式中（`running`）：token 随 snapshot 更新，tok/s 与缓存命中保持上一轮数值，不发起额外请求。
4. 会话恢复（resume）后：缓存命中与开发者工具“平均命中”显示同一数值，都从当前进程观察窗口重新累计。
5. 观察窗口内缺少 debug 事实：仅显示会话 token 段。
6. 切换到另一个会话：先不显示上一会话的 tok/s 与缓存命中，读取完成后更新。
7. 一轮内多次模型调用：轮次随每次主链路请求递增，与开发者工具“轮次”列一致。
8. 窄窗口与手机 Web：单行不溢出，发送按钮与工具条位置不变。
