import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectDesktopArtifacts } from "../ci/collect-desktop-artifacts.mjs";
import { PULL_REQUEST_LABEL, resolveDesktopBuildPlan } from "../ci/desktop-build-plan.mjs";

const packageVersion = "4.0.0";

test("release tag builds the default macOS platform with the ZCode identity", () => {
  const plan = resolveDesktopBuildPlan({
    eventName: "push",
    refType: "tag",
    refName: "v4.0.0",
    packageVersion,
  });

  assert.equal(plan.shouldBuild, true);
  assert.equal(plan.releaseTag, "v4.0.0");
  assert.equal(plan.profile, "production");
  assert.equal(plan.zcodeEnv, "production");
  assert.equal(plan.previewIdentity, "0");
  assert.deepEqual(plan.platforms, ["macos-arm64"]);
  assert.equal(plan.matrix.include[0].runner, "macos-15");
  assert.equal(plan.matrix.include[0].os, "mac");
});

test("release tag must match the repository version", () => {
  assert.throws(
    () =>
      resolveDesktopBuildPlan({
        eventName: "push",
        refType: "tag",
        refName: "v4.0.1",
        packageVersion,
      }),
    /不匹配/,
  );
});

test("branch push builds the default macOS platform and never publishes", () => {
  const plan = resolveDesktopBuildPlan({
    eventName: "push",
    refType: "branch",
    refName: "dev",
    packageVersion,
  });

  assert.equal(plan.shouldBuild, true);
  assert.equal(plan.releaseTag, "");
  assert.deepEqual(plan.platforms, ["macos-arm64"]);
});

test("pull request build is gated by the desktop-build label", () => {
  const skipped = resolveDesktopBuildPlan({
    eventName: "pull_request",
    labels: ["documentation"],
    packageVersion,
  });
  assert.equal(skipped.shouldBuild, false);

  const labeled = resolveDesktopBuildPlan({
    eventName: "pull_request",
    labels: `documentation,${PULL_REQUEST_LABEL}`,
    packageVersion,
  });
  assert.equal(labeled.shouldBuild, true);
  assert.equal(labeled.releaseTag, "");
  assert.deepEqual(labeled.platforms, ["macos-arm64"]);
});

test("manual dispatch accepts an explicit platform list and profile", () => {
  const plan = resolveDesktopBuildPlan({
    eventName: "workflow_dispatch",
    platformsInput: "linux-x64, windows-arm64 ,linux-x64",
    profileInput: "production",
    packageVersion,
  });

  assert.equal(plan.shouldBuild, true);
  assert.equal(plan.profile, "production");
  assert.equal(plan.zcodeEnv, "production");
  assert.equal(plan.previewIdentity, "0");
  assert.deepEqual(plan.platforms, ["linux-x64", "windows-arm64"]);
  assert.deepEqual(
    plan.matrix.include.map((entry) => entry.platform),
    ["linux-x64", "windows-arm64"],
  );
});

test("unknown platform and profile are rejected", () => {
  assert.throws(
    () =>
      resolveDesktopBuildPlan({
        eventName: "workflow_dispatch",
        platformsInput: "macos-ppc",
        packageVersion,
      }),
    /不支持的平台/,
  );
  assert.throws(
    () =>
      resolveDesktopBuildPlan({
        eventName: "workflow_dispatch",
        profileInput: "nightly",
        packageVersion,
      }),
    /不支持的构建画像/,
  );
});

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "desktop-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distDir = join(root, "dist");
  await mkdir(join(distDir, "unpacked"), { recursive: true });
  return { root, distDir, outDir: join(root, "out") };
}

test("mac installers are copied with checksums and build metadata", async (t) => {
  const { root, distDir, outDir } = await createFixture(t);
  const dmgName = "ZCode Preview-4.0.0-mac-arm64.dmg";
  const zipName = "ZCode Preview-4.0.0-mac-arm64.zip";
  await writeFile(join(distDir, dmgName), "dmg-bytes");
  await writeFile(join(distDir, zipName), "zip-bytes");
  await writeFile(join(distDir, `${dmgName}.blockmap`), "blockmap");
  await writeFile(join(distDir, "latest-mac.yml"), "version: 4.0.0");
  await writeFile(join(distDir, "unpacked", "ignored.dmg"), "ignored");
  const metadataPath = join(root, "build-meta.json");
  await writeFile(metadataPath, JSON.stringify({ appVersion: "4.0.0", buildCommitId: "abcdef12" }));

  const artifacts = collectDesktopArtifacts({
    distDir,
    outDir,
    platform: "macos-arm64",
    profile: "preview-production",
    version: "4.0.0",
    buildMetadataPath: metadataPath,
  });

  assert.deepEqual(artifacts.map((artifact) => artifact.name).sort(), [dmgName, zipName].sort());
  assert.ok(artifacts.every((artifact) => artifact.sha256.length === 64));

  const sums = await readFile(join(outDir, "SHA256SUMS-macos-arm64"), "utf8");
  assert.equal(sums.trim().split("\n").length, 2);
  assert.ok(sums.includes(dmgName));
  assert.ok(sums.includes(zipName));

  const buildInfo = JSON.parse(await readFile(join(outDir, "build-info-macos-arm64.json"), "utf8"));
  assert.equal(buildInfo.platform, "macos-arm64");
  assert.equal(buildInfo.profile, "preview-production");
  assert.equal(buildInfo.buildMetadata.buildCommitId, "abcdef12");
  assert.equal(buildInfo.artifacts.length, 2);
});

test("linux packaging suffixes cover AppImage, deb, rpm and pacman", async (t) => {
  const { distDir, outDir } = await createFixture(t);
  const names = [
    "ZCode Preview-4.0.0-linux-x64.AppImage",
    "ZCode Preview-4.0.0-linux-x64.deb",
    "ZCode Preview-4.0.0-linux-x64.rpm",
    "ZCode Preview-4.0.0-linux-x64.pkg.tar.zst",
  ];
  for (const name of names) await writeFile(join(distDir, name), name);
  await writeFile(join(distDir, "latest-linux.yml"), "version: 4.0.0");

  const artifacts = collectDesktopArtifacts({
    distDir,
    outDir,
    platform: "linux-x64",
    profile: "preview-production",
    version: "4.0.0",
    buildMetadataPath: join(distDir, "missing-build-meta.json"),
  });

  assert.deepEqual(artifacts.map((artifact) => artifact.name).sort(), [...names].sort());
});

test("stale installers from another identity are ignored", async (t) => {
  const { distDir, outDir } = await createFixture(t);
  const currentNames = ["ZCode Preview-4.0.0-mac-arm64.dmg", "ZCode Preview-4.0.0-mac-arm64.zip"];
  for (const name of [...currentNames, "ZCode-4.0.0-mac-arm64.dmg", "ZCode-4.0.0-mac-arm64.zip"]) {
    await writeFile(join(distDir, name), name);
  }

  const artifacts = collectDesktopArtifacts({
    distDir,
    outDir,
    platform: "macos-arm64",
    profile: "preview-production",
    version: "4.0.0",
    buildMetadataPath: join(distDir, "missing-build-meta.json"),
  });

  assert.deepEqual(artifacts.map((artifact) => artifact.name).sort(), [...currentNames].sort());
});

test("test-environment profile only accepts _TEST installers", async (t) => {
  const { distDir, outDir } = await createFixture(t);
  await writeFile(join(distDir, "ZCode Preview-4.0.0-mac-arm64.dmg"), "prod-identity");
  await writeFile(join(distDir, "ZCode Preview-4.0.0-mac-arm64_TEST.dmg"), "test-env");

  const artifacts = collectDesktopArtifacts({
    distDir,
    outDir,
    platform: "macos-arm64",
    profile: "preview-test",
    version: "4.0.0",
    buildMetadataPath: join(distDir, "missing-build-meta.json"),
  });

  assert.deepEqual(
    artifacts.map((artifact) => artifact.name),
    ["ZCode Preview-4.0.0-mac-arm64_TEST.dmg"],
  );
});

test("missing installer fails the job instead of uploading an empty bundle", async (t) => {
  const { distDir, outDir } = await createFixture(t);
  await writeFile(join(distDir, "latest.yml"), "version: 4.0.0");

  assert.throws(
    () =>
      collectDesktopArtifacts({
        distDir,
        outDir,
        platform: "windows-x64",
        profile: "preview-production",
        version: "4.0.0",
        buildMetadataPath: join(distDir, "missing-build-meta.json"),
      }),
    /未找到 windows-x64 安装包/,
  );
});
