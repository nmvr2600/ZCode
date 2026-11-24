#!/usr/bin/env node

// GitHub Actions 桌面包构建计划。
//
// 触发方式（PR 标签 / 分支 push / tag / 手动 dispatch）到“平台矩阵 + 构建画像 + 是否发布”
// 的映射只在这里判定，避免同一套规则散落在多个 workflow 表达式里，出现 YAML 与脚本两层漂移。
// 脚本只做规划，不执行安装、构建或上传。

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// runner 标签按 actions/runner-images 当前 GA 镜像固定，不使用 -latest，
// 避免镜像迁移悄悄改变 macOS/Windows 的构建基线。
const PLATFORM_CATALOG = Object.freeze({
  "macos-arm64": { os: "mac", arch: "arm64", runner: "macos-15", label: "macOS arm64" },
  "macos-x64": { os: "mac", arch: "x64", runner: "macos-15-intel", label: "macOS x64" },
  "windows-x64": { os: "win", arch: "x64", runner: "windows-2025", label: "Windows x64" },
  "windows-arm64": {
    os: "win",
    arch: "arm64",
    runner: "windows-11-arm",
    label: "Windows arm64",
  },
  "linux-x64": { os: "linux", arch: "x64", runner: "ubuntu-22.04", label: "Linux x64" },
  "linux-arm64": { os: "linux", arch: "arm64", runner: "ubuntu-22.04-arm", label: "Linux arm64" },
});

// 构建画像：安装身份（Preview / 正式）与后端环境（ZCODE_ENV）分开表达。
// Preview 身份使用独立 appId 和可执行名，可以和本机正式版并排安装，适合 GitHub 产出的未签名包。
const BUILD_PROFILES = Object.freeze({
  "preview-production": {
    zcodeEnv: "production",
    previewIdentity: "1",
    description: "生产后端 + ZCode Preview 身份（可与正式版并存）",
  },
  "preview-test": {
    zcodeEnv: "test",
    previewIdentity: "0",
    description: "测试后端 + ZCode Preview 身份，产物带 _TEST 后缀",
  },
  production: {
    zcodeEnv: "production",
    previewIdentity: "0",
    description: "生产后端 + 正式 ZCode 身份（会覆盖系统内同 appId 安装）",
  },
});

// PR 默认只打两个平台，与既有 MR 验收口径一致；tag 发布补齐 macOS x64。
const PULL_REQUEST_PLATFORMS = Object.freeze(["macos-arm64", "windows-x64"]);
const BRANCH_PLATFORMS = Object.freeze(["macos-arm64", "windows-x64", "linux-x64"]);
const TAG_PLATFORMS = Object.freeze(["macos-arm64", "macos-x64", "windows-x64", "linux-x64"]);

const DEFAULT_PLATFORMS = BRANCH_PLATFORMS;
// 这是官方开源版的分支产物，默认使用正式 ZCode 身份；Preview 画像只用于并排安装验证。
const DEFAULT_PROFILE = "production";
export const PULL_REQUEST_LABEL = "desktop-build";

function normalizeList(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parsePlatforms(rawPlatforms, fallbackPlatforms) {
  const tokens = normalizeList((rawPlatforms ?? "").split(","));
  const platforms = tokens.length > 0 ? tokens : [...fallbackPlatforms];
  for (const platform of platforms) {
    if (!PLATFORM_CATALOG[platform]) {
      throw new Error(
        `不支持的平台: ${platform}；可选值: ${Object.keys(PLATFORM_CATALOG).join(", ")}`,
      );
    }
  }
  return platforms;
}

function resolveProfile(rawProfile) {
  const profile = rawProfile?.trim() || DEFAULT_PROFILE;
  if (!BUILD_PROFILES[profile]) {
    throw new Error(
      `不支持的构建画像: ${profile}；可选值: ${Object.keys(BUILD_PROFILES).join(", ")}`,
    );
  }
  return profile;
}

function toMatrix(platforms) {
  return {
    include: platforms.map((platform) => ({ platform, ...PLATFORM_CATALOG[platform] })),
  };
}

/**
 * @param {{
 *   eventName: string,
 *   refType?: string,
 *   refName?: string,
 *   labels?: string[] | string,
 *   platformsInput?: string,
 *   profileInput?: string,
 *   packageVersion: string,
 * }} options
 */
export function resolveDesktopBuildPlan({
  eventName,
  refType = "",
  refName = "",
  labels = [],
  platformsInput = "",
  profileInput = "",
  packageVersion,
}) {
  const labelList = Array.isArray(labels) ? labels : `${labels ?? ""}`.split(",");
  const normalizedLabels = normalizeList(labelList);
  let platforms;
  let profile;
  let releaseTag = "";
  let shouldBuild = true;
  let reason;

  if (refType === "tag") {
    // 发布 tag 必须与仓库版本一致，否则安装包文件名、应用版本和 Release 标题会互相矛盾。
    const expectedTag = `v${packageVersion}`;
    if (refName !== expectedTag) {
      throw new Error(
        `tag ${refName} 与 package.json 版本 ${packageVersion} 不匹配；期望 ${expectedTag}`,
      );
    }
    platforms = parsePlatforms("", TAG_PLATFORMS);
    profile = DEFAULT_PROFILE;
    releaseTag = refName;
    reason = `release tag ${refName}`;
  } else if (eventName === "push") {
    platforms = parsePlatforms("", BRANCH_PLATFORMS);
    profile = DEFAULT_PROFILE;
    reason = `branch push ${refName}`;
  } else if (eventName === "pull_request") {
    platforms = parsePlatforms("", PULL_REQUEST_PLATFORMS);
    profile = DEFAULT_PROFILE;
    shouldBuild = normalizedLabels.includes(PULL_REQUEST_LABEL);
    reason = shouldBuild
      ? `PR 带 ${PULL_REQUEST_LABEL} 标签`
      : `PR 未带 ${PULL_REQUEST_LABEL} 标签，跳过安装包构建`;
  } else if (eventName === "workflow_dispatch") {
    platforms = parsePlatforms(platformsInput, DEFAULT_PLATFORMS);
    profile = resolveProfile(profileInput);
    reason = "手动触发";
  } else {
    platforms = [];
    profile = DEFAULT_PROFILE;
    shouldBuild = false;
    reason = `未支持的触发方式: ${eventName}`;
  }

  const buildProfile = BUILD_PROFILES[profile];

  return {
    shouldBuild,
    platforms,
    matrix: toMatrix(platforms),
    profile,
    zcodeEnv: buildProfile.zcodeEnv,
    previewIdentity: buildProfile.previewIdentity,
    releaseTag,
    version: packageVersion,
    reason,
  };
}

function readPackageVersion(root = process.cwd()) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json 缺少 version 字段");
  }
  return packageJson.version;
}

function writeGithubOutputs(outputs, outputPath) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value ?? ""}`);
  if (outputPath) {
    appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
    return;
  }
  process.stdout.write(`${JSON.stringify(outputs)}\n`);
}

function main() {
  const plan = resolveDesktopBuildPlan({
    eventName: process.env.EVENT_NAME ?? "",
    refType: process.env.REF_TYPE ?? "",
    refName: process.env.REF_NAME ?? "",
    labels: process.env.PR_LABELS ?? "",
    platformsInput: process.env.INPUT_PLATFORMS ?? "",
    profileInput: process.env.INPUT_PROFILE ?? "",
    packageVersion: readPackageVersion(),
  });

  process.stdout.write(
    [
      `[desktop-plan] should_build=${plan.shouldBuild}`,
      `platforms=${plan.platforms.join(",")}`,
      `profile=${plan.profile}`,
      `release_tag=${plan.releaseTag || "-"}`,
      `reason=${plan.reason}`,
    ].join(" ") + "\n",
  );

  writeGithubOutputs(
    {
      should_build: plan.shouldBuild ? "true" : "false",
      matrix: JSON.stringify(plan.matrix),
      profile: plan.profile,
      zcode_env: plan.zcodeEnv,
      preview_identity: plan.previewIdentity,
      release_tag: plan.releaseTag,
      version: plan.version,
      reason: plan.reason,
    },
    process.env.GITHUB_OUTPUT,
  );
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[desktop-plan] ${error.message}\n`);
    process.exitCode = 1;
  }
}
