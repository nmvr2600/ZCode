import { useEffect, useState } from "react";
import type { SessionDebugSnapshot } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 每次主链路请求完成都会推一次 usage 快照；随后补读一次的间隔。
 * CLI 的 debug 旁路记录与 usage 投影在同一个事件里写入，但快照帧可能先到，
 * 因此紧跟着再做一次确认读，避免漏掉刚完成的那一轮。
 */
const CONFIRM_READ_DELAY_MS = 400;
const EMPTY_FACTS: DebugFacts = {
  tps: null,
  roundIndex: null,
  outputTokens: null,
  cacheHitRate: null,
};

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
  /** 最近一次主链路请求的输出 token（开发者工具 Output 列）。 */
  outputTokens: number | null;
  /**
   * 缓存命中率，与开发者工具“平均命中”同源（同一个 session-debug 观察窗口）。
   * 不能用 snapshot.usage.contextWindow.cache.hitRate：那是 runtime 的会话级聚合，
   * resume 时按全部持久化消息回填（mainTurnCacheHitAggregateFromMessages），
   * 两处在同一界面会出现两个不同的“缓存命中”。
   */
  cacheHitRate: number | null;
}

function latestOutputTps(rounds: readonly SessionDebugSnapshot["rounds"][number][]): number | null {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const tps = rounds[index]?.tokensPerSecond;
    if (typeof tps === "number" && Number.isFinite(tps) && tps > 0) return Math.round(tps);
  }
  return null;
}

function readDebugFacts(debug: SessionDebugSnapshot): DebugFacts {
  const rounds = debug.rounds;
  const latest = rounds.at(-1);
  const outputTokens = latest?.usage.outputTokens;
  const cacheHitRate = debug.cache?.hitRate;
  return {
    tps: latestOutputTps(rounds),
    roundIndex:
      typeof latest?.requestIndex === "number" && latest.requestIndex > 0
        ? latest.requestIndex
        : null,
    outputTokens:
      typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0
        ? outputTokens
        : null,
    cacheHitRate:
      typeof cacheHitRate === "number" && Number.isFinite(cacheHitRate) && cacheHitRate >= 0
        ? cacheHitRate
        : null,
  };
}

/**
 * 读取吞吐事实的时机：由 `usageKey` 驱动——每当主链路请求完成（snapshot.usage 变化）
 * 读一次 debug 事实，并在 400ms 后补读一次确认。不设定时轮询：usage 投影本身就是
 * 每请求一次的推送事实，空闲会话不会触发任何读取。
 */
function useSessionDebugFacts({
  workspacePath,
  workspaceIdentity,
  sessionId,
  usageKey,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  usageKey: string;
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
        facts = readDebugFacts(debug);
      } catch {
        // 调试事实读取失败不影响统计行其余指标。
      }
      if (!disposed) setResult({ key: scopeKey, facts });
    };

    void read();
    timer = setTimeout(() => void read(), CONFIRM_READ_DELAY_MS);

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [usageKey, scopeKey, sessionId, workspaceIdentity, workspacePath, zcodeAgentService]);

  return result?.key === scopeKey ? result.facts : EMPTY_FACTS;
}

/** 每完成一次主链路请求，这些值都会变；用它作为“该读 debug 事实了”的信号。 */
function resolveUsageKey(snapshot: ConversationSnapshot | null): string {
  if (!snapshot) return "";
  const { contextWindow, cumulative } = snapshot.usage;
  return JSON.stringify([
    contextWindow?.usedTokens ?? null,
    cumulative.inputTokens,
    cumulative.outputTokens,
    cumulative.cacheReadTokens,
  ]);
}

function resolveSessionTokens(usage: ConversationSnapshot["usage"] | null): number | null {
  const usedTokens = usage?.contextWindow?.usedTokens;
  if (typeof usedTokens === "number" && usedTokens > 0) return usedTokens;
  const cumulative = usage?.cumulative;
  if (!cumulative) return null;
  const total = cumulative.inputTokens + cumulative.outputTokens;
  return total > 0 ? total : null;
}

/**
 * 输入框下方的常驻吞吐统计（docs/composer-throughput-stats.md）。
 *
 * 轮次、tok/s、输出与缓存命中都复用开发者工具同一份 session-debug 事实；读取由
 * snapshot.usage 变化（= 每次主链路请求完成）驱动，紧接一次确认读，空闲不读。
 * token 段来自 snapshot 的上下文水位。
 */
export function ComposerThroughputStats({
  snapshot,
  workspacePath,
  workspaceIdentity,
  sessionId,
}: ComposerThroughputStatsProps) {
  const { intl, locale } = useZCodeIntl();
  const { tps, roundIndex, outputTokens, cacheHitRate } = useSessionDebugFacts({
    workspacePath,
    workspaceIdentity,
    sessionId,
    usageKey: resolveUsageKey(snapshot),
  });
  if (!snapshot) return null;

  const tokens = resolveSessionTokens(snapshot.usage);
  if (
    roundIndex === null &&
    tps === null &&
    outputTokens === null &&
    tokens === null &&
    cacheHitRate === null
  )
    return null;

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
  if (outputTokens !== null) {
    segments.push(
      intl.formatMessage(
        { id: "chat.composer.throughput.output" },
        {
          value: new Intl.NumberFormat(locale, {
            notation: "compact",
            maximumFractionDigits: 1,
          }).format(outputTokens),
        },
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
          // 命中率保留 1 位小数：取整会把 98.6% 显示成 99%。
          // 口径与开发者工具“平均命中”一致（同一个 session-debug 观察窗口），
          // 不再读 snapshot 里的会话级聚合，避免同屏出现两个不同的命中率。
          value: new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 1,
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
