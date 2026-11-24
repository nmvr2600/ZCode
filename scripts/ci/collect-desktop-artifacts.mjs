#!/usr/bin/env node

// 把 electron-builder 产物目录收敛成 CI artifact 目录：只保留可安装文件，附带构建元数据与校验和。
// 平台差异（DMG/ZIP、NSIS、AppImage/deb/rpm/pacman）在这里统一处理，workflow 不需要写平台分支。

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const INSTALLER_SUFFIXES_BY_FAMILY = Object.freeze({
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".appimage", ".deb", ".rpm", ".pkg.tar.zst"],
});

const PRODUCT_NAME_BY_PROFILE = Object.freeze({
  "preview-production": "ZCode Preview",
  "preview-test": "ZCode Preview",
  production: "ZCode",
});

function resolvePlatformFamily(platform) {
  if (platform.startsWith("macos-")) return "mac";
  if (platform.startsWith("windows-")) return "win";
  if (platform.startsWith("linux-")) return "linux";
  throw new Error(`无法识别的平台: ${platform}`);
}

function isInstaller(fileName, family) {
  const lowerCaseName = fileName.toLowerCase();
  return INSTALLER_SUFFIXES_BY_FAMILY[family].some((suffix) => lowerCaseName.endsWith(suffix));
}

// dist 可能残留上一次其他画像的安装包（本地重复构建时尤其常见）。只收集当前画像会产出的
// `${productName}-${version}-` 前缀，避免把正式身份的旧包混进 Preview artifact。
function matchesProfileIdentity(fileName, { profile, version }) {
  const productName = PRODUCT_NAME_BY_PROFILE[profile];
  if (!productName) throw new Error(`未知构建画像: ${profile}`);
  if (!fileName.startsWith(`${productName}-${version}-`)) return false;
  return profile === "preview-test" ? fileName.includes("_TEST") : !fileName.includes("_TEST");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function collectDesktopArtifacts({
  distDir,
  outDir,
  platform,
  profile,
  version,
  buildMetadataPath,
}) {
  const family = resolvePlatformFamily(platform);
  if (!existsSync(distDir)) {
    throw new Error(`产物目录不存在: ${distDir}`);
  }

  const distFiles = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const installerFiles = distFiles.filter(
    (fileName) =>
      isInstaller(fileName, family) && matchesProfileIdentity(fileName, { profile, version }),
  );
  if (installerFiles.length === 0) {
    throw new Error(
      `未找到 ${platform} 安装包: ${distDir}；目录内文件: ${distFiles.join(", ") || "(空)"}`,
    );
  }

  rmSync(outDir, { force: true, recursive: true });
  mkdirSync(outDir, { recursive: true });

  const artifacts = installerFiles.map((fileName) => {
    const sourcePath = resolve(distDir, fileName);
    const targetPath = resolve(outDir, fileName);
    copyFileSync(sourcePath, targetPath);
    return {
      name: basename(targetPath),
      size: statSync(targetPath).size,
      sha256: sha256(targetPath),
    };
  });

  const buildMetadata = existsSync(buildMetadataPath)
    ? JSON.parse(readFileSync(buildMetadataPath, "utf8"))
    : null;
  writeFileSync(
    resolve(outDir, `build-info-${platform}.json`),
    `${JSON.stringify(
      {
        platform,
        profile,
        version,
        generatedAt: new Date().toISOString(),
        artifacts,
        buildMetadata,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  writeFileSync(
    resolve(outDir, `SHA256SUMS-${platform}`),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`,
    "utf8",
  );

  return artifacts;
}

function parseArgs(argv) {
  const options = {
    distDir: "packages/desktop/dist",
    outDir: "ci-artifacts",
    platform: "",
    profile: "preview-production",
    version: "",
    buildMetadataPath: "packages/desktop/out/metadata/build-meta.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (!value) throw new Error(`${arg} 缺少参数值`);
      return value;
    };
    if (arg === "--dist") options.distDir = next();
    else if (arg === "--out") options.outDir = next();
    else if (arg === "--platform") options.platform = next();
    else if (arg === "--profile") options.profile = next();
    else if (arg === "--version") options.version = next();
    else if (arg === "--build-metadata") options.buildMetadataPath = next();
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!options.platform) throw new Error("缺少 --platform");
  if (!options.version) {
    options.version = JSON.parse(readFileSync("package.json", "utf8")).version;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifacts = collectDesktopArtifacts({
    distDir: resolve(options.distDir),
    outDir: resolve(options.outDir),
    platform: options.platform,
    profile: options.profile,
    version: options.version,
    buildMetadataPath: resolve(options.buildMetadataPath),
  });
  for (const artifact of artifacts) {
    process.stdout.write(
      `[desktop-artifacts] ${artifact.name} size=${artifact.size} sha256=${artifact.sha256}\n`,
    );
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[desktop-artifacts] ${error.message}\n`);
    process.exitCode = 1;
  }
}
