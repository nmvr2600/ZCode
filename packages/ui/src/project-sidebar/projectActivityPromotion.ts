import { useEffect, useMemo, useRef } from "react";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";
import { compareProjectTaskRows, projectKey } from "@/project-sidebar/view.js";

/**
 * 会话活动领先时把所属项目前移到表头。
 * 只移动目标项目，其余项目保持原相对顺序；已在表头时返回原顺序（调用方据此跳过写入）。
 */
export function promoteProjectOrder(saved: readonly string[], key: string): string[] {
  return saved[0] === key ? [...saved] : [key, ...saved.filter((item) => item !== key)];
}

/**
 * 最近活动的项目：会渲染在项目行里的任务中比较器最靠前的一条所属项目。
 *
 * 与会话行共用 `compareProjectTaskRows`，所以「会话置顶」和「项目置前」同源：
 * 比较器对运行层按 createdAt 稳定排序，流式事件推进 updatedAt 时不会让两个项目反复换位。
 * 未归档、未置顶、已渲染项目之外的任务不参与——置顶行渲染在全局置顶区，不在项目里。
 */
export function selectLeadingProjectKey(
  tree: ProjectTree,
  projects: readonly VirtualProject[],
): string | null {
  const rendered = new Set(projects.map(projectKey));
  let leading: { key: string; task: ProjectTask } | null = null;
  for (const task of tree.tasks) {
    if (task.archived || task.pinned || task.projectId == null) continue;
    const key = projectKey({ id: task.projectId, hostId: task.hostId });
    if (!rendered.has(key)) continue;
    if (!leading || compareProjectTaskRows(task, leading.task, "project") < 0) {
      leading = { key, task };
    }
  }
  return leading?.key ?? null;
}

/**
 * 领先项目变化时写一次侧栏偏好，把该项目置前。
 *
 * 边沿触发而不是每次按活动重排：重复刷新、手动拖动和新建项目 prepend 都不会被
 * 无关更新覆盖，直到下一个项目成为领先；只在顺序真正变化时由偏好 owner 落盘。
 */
export function useProjectActivityPromotion({
  tree,
  projects,
  loading,
  promote,
}: {
  tree: ProjectTree;
  projects: readonly VirtualProject[];
  loading: boolean;
  promote(key: string): void;
}) {
  const leadingKey = useMemo(() => selectLeadingProjectKey(tree, projects), [tree, projects]);
  // 首次成功读取后以当前最近活动项目为表头；之后只在领先项目变化时前移。
  const promoted = useRef<string | null>(null);
  useEffect(() => {
    if (loading || !leadingKey || promoted.current === leadingKey) return;
    promoted.current = leadingKey;
    promote(leadingKey);
  }, [leadingKey, loading, promote]);
}
