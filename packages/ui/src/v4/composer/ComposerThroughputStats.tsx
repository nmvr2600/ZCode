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
const EMPTY_FACTS: DebugFacts = { tps: null, roundIndex: null, outputTokens: null };

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
  const outputTokens = latest?.usage.outputTokens;
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
        facts = readDebugFacts(debug.rounds);
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

function resolveCacheHitRate(usage: ConversationSnapshot["usage"] | null): number | null {
  const hitRate = usage?.contextWindow?.cache?.hitRate;
  return typeof hitRate === "number" && Number.isFinite(hitRate) && hitRate >= 0 ? hitRate : null;
}

/**
 * 输入框下方的常驻吞吐统计（docs/composer-throughput-stats.md）。
 *
 * 轮次与 tok/s 复用开发者工具同一份 session-debug 事实；读取由 snapshot.usage 变化
 * （= 每次主链路请求完成）驱动，紧接一次确认读，空闲不读。token 与缓存命中来自 snapshot。
 */
export function ComposerThroughputStats({
  snapshot,
  workspacePath,
  workspaceIdentity,
  sessionId,
}: ComposerThroughputStatsProps) {
  const { intl, locale } = useZCodeIntl();
  const { tps, roundIndex, outputTokens } = useSessionDebugFacts({
    workspacePath,
    workspaceIdentity,
    sessionId,
    usageKey: resolveUsageKey(snapshot),
  });
  if (!snapshot) return null;

  const usage = snapshot.usage;
  const tokens = resolveSessionTokens(usage);
  const cacheHitRate = resolveCacheHitRate(usage);
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
