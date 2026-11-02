import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyImagePromotion, createBundle, imageNames, indexDescriptors, planImagePromotion, platforms, validateCandidates, validateTag, verifyBundle } from "../release-images.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const revision = "a".repeat(40);
const names = imageNames("AmazingUmi/PersonalPlatform");
const version = "v0.1.0";
const expected = { version, revision, names };
const descriptor = (arch, character) => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", size: 123, digest: digest(character), platform: { architecture: arch, os: "linux" } });
const index = { schemaVersion: 2, manifests: [descriptor("amd64", "a"), descriptor("arm64", "b"), { ...descriptor("unknown", "c"), platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } }] };
const candidates = platforms.map((platform) => ({ version, revision, platform, images: {
  backend: { name: names.backend, digest: digest("d") }, frontend: { name: names.frontend, digest: digest("e") },
} }));
const temporary = mkdtempSync(join(tmpdir(), "pp-release-test-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

test("job environment expressions use contexts supported by GitHub workflow validation", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release-images.yml", import.meta.url), "utf8");
  const allowed = new Set(["github", "inputs", "matrix", "needs", "secrets", "strategy", "vars"]);
  for (const [, environment] of workflow.matchAll(/^    env:\n((?:^      .*\n)+)/gm)) {
    for (const [, context] of environment.matchAll(/\$\{\{\s*(\w+)\./g)) {
      assert.ok(allowed.has(context), `${context} is unavailable in job-level env; use step-level env`);
    }
  }
});

test("release tags reject mismatched versions, moving tags, prereleases and injected arguments", () => {
  assert.equal(validateTag(version, "0.1.0"), version);
  for (const tag of ["latest", "v0.1", "v01.1.0", "v0.1.1", "v0.1.0-rc.1", "v0.1.0;echo nope", "--help"]) {
    assert.throws(() => validateTag(tag, "0.1.0"));
  }
});

test("promotion requires the paired images from two distinct native platforms and one exact source", () => {
  assert.deepEqual(validateCandidates(structuredClone(candidates), expected).map((candidate) => candidate.platform), platforms);
  assert.throws(() => validateCandidates([candidates[0], candidates[0]], expected));
  const stale = structuredClone(candidates);
  stale[1].revision = "b".repeat(40);
  assert.throws(() => validateCandidates(stale, expected), /revision mismatch/);
  stale[1].revision = revision;
  stale[1].images.frontend.name = "ghcr.io/another/frontend";
  assert.throws(() => validateCandidates(stale, expected), /repository mismatch/);
});

test("indexes accept attestation descriptors but require the two intended runnable architectures", () => {
  assert.equal(indexDescriptors(index).length, 3);
  assert.throws(() => indexDescriptors({ manifests: [descriptor("amd64", "a")] }));
  assert.throws(() => indexDescriptors({ manifests: [...index.manifests, descriptor("arm", "d")] }));
});

test("an existing matching version is reused without writing; serialization order does not matter", () => {
  const calls = [];
  const reordered = structuredClone(index);
  reordered.manifests.reverse();
  reordered.manifests[1].platform = { os: "linux", architecture: "arm64" };
  const run = (args) => {
    calls.push(args);
    if (args.includes("--dry-run")) return JSON.stringify(index);
    return JSON.stringify({ ...reordered, digest: digest("f") });
  };
  const plan = planImagePromotion(names.backend, version, [digest("d"), digest("e")], run);
  const result = applyImagePromotion(plan, run);
  assert.equal(result.reference, `${names.backend}@${digest("f")}`);
  assert.equal(calls.filter((args) => args.includes("--tag")).length, 0);
});

test("a conflicting immutable version rejects before any registry mutation", () => {
  const changed = structuredClone(index);
  changed.manifests[0].digest = digest("e");
  const calls = [];
  assert.throws(() => planImagePromotion(names.backend, version, [digest("d"), digest("e")], (args) => {
    calls.push(args);
    return JSON.stringify(args.includes("--dry-run") ? index : changed);
  }), /already exists/);
  assert.ok(calls.every((args) => !args.includes("--tag")));
});

test("a verified new version is promoted once and registry failures are not treated as absence", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes("--raw")) return null;
    return JSON.stringify({ ...index, digest: digest("f") });
  };
  const plan = planImagePromotion(names.backend, version, [digest("d"), digest("e")], run);
  applyImagePromotion(plan, run);
  assert.equal(calls.filter((args) => args.includes("--tag")).length, 1);
  assert.throws(() => planImagePromotion(names.backend, version, [digest("d"), digest("e")], (args) => {
    if (args.includes("--dry-run")) return JSON.stringify(index);
    throw new Error("registry access denied");
  }), /access denied/);
});

test("the deployment archive uses an explicit file allowlist, blank secrets, digest pins and checked contents", () => {
  const source = join(temporary, "source");
  const output = join(temporary, "dist");
  mkdirSync(join(source, "docker"), { recursive: true });
  for (const file of ["docker-compose.release.yml", "docker-compose.runtime.yml"]) writeFileSync(join(source, "docker", file), "services: {}\n");
  writeFileSync(join(source, "docker/RELEASE_README.md"), "Install instructions\n");
  writeFileSync(join(source, ".env.release.example"), "BACKEND_IMAGE=placeholder\nFRONTEND_IMAGE=placeholder\nPOSTGRES_PASSWORD=\nBOOTSTRAP_ADMIN_PASSWORD=\nDATA_BACKUP_ENCRYPTION_KEY=\n");
  writeFileSync(join(source, ".env.production"), "PRIVATE=must-not-ship\n");
  const release = { schemaVersion: 1, version, revision, platforms, images: {
    backend: { reference: `${names.backend}@${digest("d")}`, digest: digest("d") },
    frontend: { reference: `${names.frontend}@${digest("e")}`, digest: digest("e") },
  } };
  const bundle = createBundle(source, output, release);
  verifyBundle(bundle);
  assert.deepEqual(readdirSync(bundle).sort(), [".env.release.example", "README.md", "SHA256SUMS", "docker", "release.json"]);
  assert.match(readFileSync(join(bundle, ".env.release.example"), "utf8"), new RegExp(`BACKEND_IMAGE=${names.backend}@${digest("d")}`));
  assert.match(readFileSync(join(output, "SHA256SUMS"), "utf8"), /personalplatform-v0\.1\.0\.tar\.gz/);
  writeFileSync(join(bundle, "docker/docker-compose.release.yml"), "tampered\n");
  assert.throws(() => verifyBundle(bundle), /checksum mismatch/);
  writeFileSync(join(source, ".env.release.example"), "BACKEND_IMAGE=placeholder\nFRONTEND_IMAGE=placeholder\nPOSTGRES_PASSWORD=real-secret\nBOOTSTRAP_ADMIN_PASSWORD=\nDATA_BACKUP_ENCRYPTION_KEY=\n");
  assert.throws(() => createBundle(source, join(temporary, "refused"), release), /leave POSTGRES_PASSWORD empty/);
});
