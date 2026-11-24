import { useEffect, useState } from "react";
import type { SessionDebugSnapshot } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 运行中按 1s 拉一次；空闲不轮询（CLI 没有推送每请求 token/耗时的通道）。 */
const RUNNING_REFRESH_MS = 1000;
const EMPTY_FACTS: DebugFacts = { tps: null, roundIndex: null };

interface ComposerThroughputStatsProps {
  snapshot: ConversationSnapshot | null;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
}

interface DebugFacts {
  /** 最近一次主链路请求的输出速率；尚未产生速率时向前找。 */
  tps: number | null;
  /** 会话累计主链路请求序号，与开发者工具“轮次”列同源。 */
  roundIndex: number | null;
}

function latestOutputTps(rounds: readonly SessionDebugSnapshot["rounds"][number][]): number | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const tps = rounds[index]?.tokensPerSecond;
    if (typeof tps === "number" && Number.isFinite(tps) && tps > 0) return Math.round(tps);
  }
  return null;
}

function readDebugFacts(rounds: readonly SessionDebugSnapshot["rounds"][number][]): DebugFacts {
  const latest = rounds.at(-1);
  return {
    tps: latestOutputTps(rounds),
    roundIndex:
      typeof latest?.requestIndex === "number" && latest.requestIndex > 0
        ? latest.requestIndex
        : null,
  };
}

/**
 * 读取吞吐事实的时机：挂载 / 切会话 / 每轮开始与结束各读一次；只有会话运行中才按 1s 续读。
 *
 * CLI 目前没有推送 per-request token 与耗时的通知（localTtftFacts 只带 TTFT 时间点），
 * `session-debug` 只能拉取，所以运行中必须轮询才能跟上轮内连续多次模型请求；空闲时不读。
 */
function useSessionDebugFacts({
  workspacePath,
  workspaceIdentity,
  sessionId,
  active,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  active: boolean;
}): DebugFacts {
  const { zcodeAgentService } = useServices();
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
  const [result, setResult] = useState<{ key: string; facts: DebugFacts } | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      let facts: DebugFacts = EMPTY_FACTS;
      try {
        const debug = await zcodeAgentService.readSessionDebug({
          workspacePath,
          workspaceIdentity,
          sessionId,
        });
        facts = readDebugFacts(debug.rounds);
      } catch {
        // 调试事实读取失败不影响统计行其余指标。
      }
      if (!disposed) setResult({ key: scopeKey, facts });
      return !disposed;
    };

    const scheduleNext = () => {
      timer = setTimeout(() => {
        void read().then((alive) => {
          if (alive) scheduleNext();
        });
      }, RUNNING_REFRESH_MS);
    };

    // 进终态或切会话时 active 变化会重建本 effect：先读一次拿到最终一轮的数据。
    void read();
    if (active) scheduleNext();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, scopeKey, sessionId, workspaceIdentity, workspacePath, zcodeAgentService]);

  return result?.key === scopeKey ? result.facts : EMPTY_FACTS;
}

function resolveSessionTokens(usage: ConversationSnapshot["usage"] | null): number | null {
  const usedTokens = usage?.contextWindow?.usedTokens;
  if (typeof usedTokens === "number" && usedTokens > 0) return usedTokens;
  const cumulative = usage?.cumulative;
  if (!cumulative) return null;
  const total = cumulative.inputTokens + cumulative.outputTokens;
  return total > 0 ? total : null;
}

function resolveCacheHitRate(usage: ConversationSnapshot["usage"] | null): number | null {
  const hitRate = usage?.contextWindow?.cache?.hitRate;
  return typeof hitRate === "number" && Number.isFinite(hitRate) && hitRate >= 0 ? hitRate : null;
}

/**
 * 输入框下方的常驻吞吐统计（docs/composer-throughput-stats.md）。
 *
 * 轮次与 tok/s 复用开发者工具同一份 session-debug 事实，按 1s 节拍读取：一轮里可能连续
 * 发生多次模型请求，只在整轮终态读一次会落后很多轮。token 与缓存命中来自 v4 snapshot。
 */
export function ComposerThroughputStats({
  snapshot,
  workspacePath,
  workspaceIdentity,
  sessionId,
}: ComposerThroughputStatsProps) {
  const { intl, locale } = useZCodeIntl();
  const phase = snapshot?.control.phase ?? null;
  const { tps, roundIndex } = useSessionDebugFacts({
    workspacePath,
    workspaceIdentity,
    sessionId,
    active: phase === "running" || phase === "prewarming",
  });
  if (!snapshot) return null;

  const usage = snapshot.usage;
  const tokens = resolveSessionTokens(usage);
  const cacheHitRate = resolveCacheHitRate(usage);
  if (roundIndex === null && tps === null && tokens === null && cacheHitRate === null) return null;

  const segments: string[] = [];
  if (roundIndex !== null) {
    segments.push(
      intl.formatMessage(
        { id: "chat.composer.throughput.round" },
        { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(roundIndex) },
      ),
    );
  }
  if (tps !== null) {
    segments.push(
      intl.formatMessage(
        { id: "chat.composer.throughput.tps" },
        { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(tps) },
      ),
    );
  }
  if (tokens !== null) {
    segments.push(
      intl.formatMessage(
        { id: "chat.composer.throughput.tokens" },
        {
          value: new Intl.NumberFormat(locale, {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(tokens),
        },
      ),
    );
  }
  if (cacheHitRate !== null) {
    segments.push(
      intl.formatMessage(
        { id: "chat.composer.throughput.cacheHit" },
        {
          value: new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 0,
          }).format(cacheHitRate),
        },
      ),
    );
  }

  return (
    // 由 timeline 的 belowDockContent 渲染在滚动容器之外（输入卡正下方）：滚动消息被
    // scroll 区裁掉，不会透到这一行，因此这里既不加底色/胶囊，也不会撑高 composer dock。
    <div
      data-testid="composer-throughput-stats"
      title={intl.formatMessage({ id: "chat.composer.throughput.description" })}
      className="flex min-w-0 items-center justify-center px-2 pt-1.5 text-ui-xs text-foreground-subtle tabular-nums"
    >
      <span className="truncate">{segments.join(" · ")}</span>
    </div>
  );
}
