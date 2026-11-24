import { useEffect, useState } from "react";
import type { SessionDebugSnapshot } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

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

function readDebugFacts(rounds: SessionDebugSnapshot["rounds"]): DebugFacts {
  const latest = rounds.at(-1);
  return {
    tps: latestOutputTps(rounds),
    roundIndex:
      typeof latest?.requestIndex === "number" && latest.requestIndex > 0
        ? latest.requestIndex
        : null,
  };
}

function latestOutputTps(rounds: SessionDebugSnapshot["rounds"]): number | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const tps = rounds[index]?.tokensPerSecond;
    if (typeof tps === "number" && Number.isFinite(tps) && tps > 0) return Math.round(tps);
  }
  return null;
}

/**
 * 会话稳定后各读一次吞吐事实：挂载、以及每次从 running 收口到终态。
 * 不用 1s 轮询——本行只需要“最近一次请求”的速率与累计轮次，流式期间保留上一次结果即可。
 */
function useSessionDebugFacts({
  workspacePath,
  workspaceIdentity,
  sessionId,
  refreshKey,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  refreshKey: string | null;
}): DebugFacts {
  const { zcodeAgentService } = useServices();
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
  const [result, setResult] = useState<{ key: string; facts: DebugFacts } | null>(null);

  useEffect(() => {
    if (!sessionId || refreshKey === null) return;
    let disposed = false;
    const read = async () => {
      let facts: DebugFacts = { tps: null, roundIndex: null };
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
    };
    void read();
    return () => {
      disposed = true;
    };
    // scopeKey 已覆盖 workspace/session 身份；sessionId 显式保留以便切会话即失效。
  }, [scopeKey, refreshKey, sessionId, workspaceIdentity, workspacePath, zcodeAgentService]);

  return result?.key === scopeKey ? result.facts : { tps: null, roundIndex: null };
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
 * token 与缓存命中来自 v4 snapshot；tok/s 复用开发者工具同一份 session-debug 事实，
 * 因为 `turnHeader.modelDurationMs` 只对加速卡轮次写入，普通轮次没有该字段。
 */
export function ComposerThroughputStats({
  snapshot,
  workspacePath,
  workspaceIdentity,
  sessionId,
}: ComposerThroughputStatsProps) {
  const { intl, locale } = useZCodeIntl();
  const phase = snapshot?.control.phase ?? null;
  // 只有稳定态才读取速率；running/prewarming 期间保留上一次结果，避免轮询。
  const refreshKey =
    phase === null || phase === "draft" || phase === "prewarming" || phase === "running"
      ? null
      : phase;
  const { tps, roundIndex: roundNumber } = useSessionDebugFacts({
    workspacePath,
    workspaceIdentity,
    sessionId,
    refreshKey,
  });
  if (!snapshot) return null;

  const usage = snapshot.usage;
  const tokens = resolveSessionTokens(usage);
  const cacheHitRate = resolveCacheHitRate(usage);
  if (roundNumber === null && tps === null && tokens === null && cacheHitRate === null) return null;

  const segments: string[] = [];
  if (roundNumber !== null) {
    segments.push(
      intl.formatMessage(
        { id: "chat.composer.throughput.round" },
        { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(roundNumber) },
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
