import assert from "node:assert/strict";
import { test } from "node:test";
import { verificationOptions, verificationCleanupArgs } from "../docker-verification-options.mjs";

test("prebuilt verification requires an explicit image pair and never removes external images", () => {
  const options = verificationOptions(["--backend-image", "example/backend@sha256:abc", "--frontend-image", "example/frontend@sha256:def", "--pull"], "/repo");
  assert.equal(options.prebuilt, true);
  assert.equal(options.pull, true);
  assert.ok(!verificationCleanupArgs(true).includes("--rmi"));
  assert.ok(verificationCleanupArgs(false).includes("--rmi"));
  assert.throws(() => verificationOptions(["--backend-image", "one"], "/repo"), /Both/);
  assert.throws(() => verificationOptions(["--pull"], "/repo"), /require both/);
  assert.throws(() => verificationOptions(["--compose-file", "docker/custom.yml"], "/repo"), /require both/);
});

test("invalid options fail before touching Docker and bundle paths resolve explicitly", () => {
  for (const args of [["--backend-image"], ["--unknown"], ["--backend-image", "a\nPOSTGRES_PASSWORD=bad"], ["--pull", "--pull"]]) {
    assert.throws(() => verificationOptions(args, "/repo"));
  }
  assert.equal(verificationOptions(["--backend-image", "backend:one", "--frontend-image", "frontend:one", "--compose-file", "bundle/docker/release.yml"], "/repo").composeFile, "/repo/bundle/docker/release.yml");
  assert.equal(verificationOptions([], "/repo").prebuilt, false);
});
