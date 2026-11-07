#!/usr/bin/env node
// Packaging only: this helper never reads private environment files or data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const platforms = ["linux/amd64", "linux/arm64"];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;

export function validateTag(tag, packageVersion) {
  assert.match(tag ?? "", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "release tag must be vMAJOR.MINOR.PATCH");
  assert.equal(tag, `v${packageVersion}`, "release tag must match package.json version");
  return tag;
}

export function imageNames(repository) {
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "invalid repository");
  return Object.fromEntries(["backend", "frontend"].map((service) => [service, `ghcr.io/${repository.toLowerCase()}-${service}`]));
}

function context() {
  const version = validateTag(process.env.RELEASE_VERSION ?? process.env.GITHUB_REF_NAME, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  const revision = process.env.RELEASE_REVISION ?? process.env.GITHUB_SHA;
  assert.match(revision ?? "", shaPattern, "release revision must be a full commit SHA");
  const repository = process.env.GITHUB_REPOSITORY;
  return { version, revision, repository, names: imageNames(repository) };
}

export function validateCandidates(candidates, expected) {
  assert.equal(candidates.length, 2, "exactly two native architecture results are required");
  assert.deepEqual(candidates.map((candidate) => candidate.platform).sort(), platforms);
  for (const candidate of candidates) {
    assert.equal(candidate.version, expected.version, "candidate version mismatch");
    assert.equal(candidate.revision, expected.revision, "candidate revision mismatch");
    for (const service of ["backend", "frontend"]) {
      assert.equal(candidate.images[service].name, expected.names[service], "candidate image repository mismatch");
      assert.match(candidate.images[service].digest, digestPattern);
    }
  }
  return candidates.sort((a, b) => a.platform.localeCompare(b.platform));
}

export function indexDescriptors(index) {
  assert.ok(Array.isArray(index.manifests), "a multi-platform image index is required");
  const runnable = index.manifests.filter((manifest) => manifest.platform?.os !== "unknown");
  assert.deepEqual(runnable.map((manifest) => `${manifest.platform?.os}/${manifest.platform?.architecture}`).sort(), platforms,
    "index must contain exactly the verified amd64 and arm64 images");
  return index.manifests.map((manifest) => {
    assert.match(manifest.digest, digestPattern);
    // Compare every child, including SBOM/provenance descriptors. Ignore only
    // serialization order: an existing version must represent this same pair.
    return JSON.stringify(canonical([manifest.digest, manifest.size, manifest.mediaType, manifest.platform ?? null, manifest.annotations ?? null]));
  }).sort();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function docker(args, allowMissing = false) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // A transport/authorization error is never evidence that a tag is absent.
    if (allowMissing && /(?:manifest unknown|not found)/i.test(result.stderr) && !/(?:unauthorized|denied|forbidden)/i.test(result.stderr)) return null;
    throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function planImagePromotion(name, version, digests, runDocker = docker) {
  const sources = digests.map((digest) => {
    assert.match(digest, digestPattern);
    return `${name}@${digest}`;
  });
  const ref = `${name}:${version}`;
  const intended = JSON.parse(runDocker(["buildx", "imagetools", "create", "--dry-run", ...sources]));
  const descriptors = indexDescriptors(intended);
  const existingRaw = runDocker(["buildx", "imagetools", "inspect", "--raw", ref], true);
  if (existingRaw !== null) {
    assert.deepEqual(indexDescriptors(JSON.parse(existingRaw)), descriptors, `${ref} already exists with different image content; choose a new version`);
  }
  return { name, ref, sources, descriptors, exists: existingRaw !== null };
}

export function applyImagePromotion(plan, runDocker = docker) {
  if (!plan.exists) runDocker(["buildx", "imagetools", "create", "--tag", plan.ref, ...plan.sources]);
  const published = JSON.parse(runDocker(["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", plan.ref]));
  assert.deepEqual(indexDescriptors(published), plan.descriptors, "published index differs from verified candidates");
  assert.match(published.digest, digestPattern);
  return { reference: `${plan.name}@${published.digest}`, digest: published.digest, versionReference: plan.ref };
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createBundle(sourceRoot, output, release) {
  assert.match(release.revision, shaPattern);
  assert.match(release.version, /^v\d+\.\d+\.\d+$/);
  const base = `personalplatform-${release.version}`;
  const bundle = join(output, base);
  mkdirSync(join(bundle, "docker"), { recursive: true });
  const files = ["docker/docker-compose.release.yml", "docker/docker-compose.runtime.yml"];
  for (const file of files) copyFileSync(join(sourceRoot, file), join(bundle, file));
  copyFileSync(join(sourceRoot, "scripts/deploy.sh"), join(bundle, "deploy.sh"));
  chmodSync(join(bundle, "deploy.sh"), 0o755);
  copyFileSync(join(sourceRoot, "docker/RELEASE_README.md"), join(bundle, "README.md"));
  let environment = readFileSync(join(sourceRoot, ".env.release.example"), "utf8");
  for (const key of ["POSTGRES_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD", "DATA_BACKUP_ENCRYPTION_KEY"]) {
    assert.match(environment, new RegExp(`^${key}=$`, "m"), `release template must leave ${key} empty`);
  }
  for (const service of ["backend", "frontend"]) {
    const key = `${service.toUpperCase()}_IMAGE`;
    const reference = release.images[service].reference;
    assert.match(reference, /^ghcr\.io\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/);
    assert.match(environment, new RegExp(`^${key}=.*$`, "m"), `${key} missing from template`);
    environment = environment.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${reference}`);
  }
  writeFileSync(join(bundle, ".env.release.example"), environment);
  const metadata = `${JSON.stringify(release, null, 2)}\n`;
  writeFileSync(join(bundle, "release.json"), metadata);
  const content = [...files, "deploy.sh", "README.md", ".env.release.example", "release.json"].sort();
  writeFileSync(join(bundle, "SHA256SUMS"), content.map((file) => `${hash(readFileSync(join(bundle, file)))}  ${file}\n`).join(""));
  const archive = `${base}.tar.gz`;
  const packed = spawnSync("tar", ["-czf", join(output, archive), "-C", output, base], { encoding: "utf8" });
  if (packed.error || packed.status !== 0) throw new Error(`could not archive release bundle: ${packed.error?.message ?? packed.stderr}`);
  writeFileSync(join(output, "SHA256SUMS"), `${hash(readFileSync(join(output, archive)))}  ${archive}\n`);
  writeFileSync(join(output, "release.json"), metadata);
  writeFileSync(join(output, "release-notes.md"), `First public PersonalPlatform image release, including incremental backups and paired per-user WebDAV continuous sync.\n\nSource: \`${release.revision}\`. Native platforms: ${platforms.join(", ")}. Both application images were exercised through real login, migration, API, attachment and recreation-persistence checks.\n\nDownload \`${archive}\` and \`SHA256SUMS\`, verify the checksum, then follow the included README. Image references are pinned by digest in the credential template. HTTPS is required for production login. User data and credentials are not part of the images. Real WebDAV provider compatibility has not been verified; sync requires a successful conditional-write capability probe.\n`);
  return bundle;
}

export function verifyBundle(bundle) {
  for (const line of readFileSync(join(bundle, "SHA256SUMS"), "utf8").trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_./-]+)$/);
    assert.ok(match && !match[2].includes("..") && !match[2].startsWith("/"), "invalid checksum entry");
    assert.equal(hash(readFileSync(join(bundle, match[2]))), match[1], `bundle checksum mismatch: ${match[2]}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "validate-tag") {
    validateTag(args[0], JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  } else if (command === "candidate-metadata") {
    const expected = context();
    const [architecture, backend, frontend, output] = args;
    assert.ok(["amd64", "arm64"].includes(architecture));
    for (const digest of [backend, frontend]) assert.match(digest, digestPattern);
    const names = expected.names;
    const candidate = { version: expected.version, revision: expected.revision, platform: `linux/${architecture}`, images: {
      backend: { name: names.backend, digest: backend }, frontend: { name: names.frontend, digest: frontend },
    } };
    writeFileSync(output, `${JSON.stringify(candidate, null, 2)}\n`);
  } else if (command === "verify-labels") {
    const expected = context();
    assert.equal(args.length, 2);
    for (const ref of args) {
      const [image] = JSON.parse(docker(["image", "inspect", ref]));
      assert.equal(image.Config.Labels["org.opencontainers.image.revision"], expected.revision);
      assert.equal(image.Config.Labels["org.opencontainers.image.version"], expected.version);
      assert.equal(image.Config.Labels["org.opencontainers.image.source"], `https://github.com/${expected.repository}`);
    }
  } else if (command === "promote") {
    const expected = context();
    const [version, directory, output] = args;
    assert.equal(version, expected.version);
    const candidates = validateCandidates(readdirSync(directory).filter((file) => /^candidate-(amd64|arm64)\.json$/.test(file))
      .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8"))), expected);
    // Preflight BOTH names before writing either final version tag.
    const plans = ["backend", "frontend"].map((service) => [service, planImagePromotion(expected.names[service], version,
      candidates.map((candidate) => candidate.images[service].digest))]);
    const images = Object.fromEntries(plans.map(([service, plan]) => [service, applyImagePromotion(plan)]));
    createBundle(root, resolve(output), { schemaVersion: 1, version, revision: expected.revision, platforms, images });
  } else if (command === "verify-bundle") {
    verifyBundle(resolve(args[0]));
  } else {
    throw new Error("usage: release-images.mjs validate-tag|candidate-metadata|verify-labels|promote|verify-bundle ...");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Release failed: ${error.message}`); process.exitCode = 1; });
}
