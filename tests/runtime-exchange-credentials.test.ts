import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentBlocksCredentialRotation } from "../packages/persistence/src/exchange-connection-repository";

test("expired connection can rotate while deployments are paused", () => {
  assert.equal(deploymentBlocksCredentialRotation("INVALID", "PAUSED"), false);
  assert.equal(deploymentBlocksCredentialRotation("INVALID", "RUNNING"), true);
  assert.equal(deploymentBlocksCredentialRotation("INVALID", "READY"), true);
});

test("active connection cannot rotate while a deployment is attached", () => {
  assert.equal(deploymentBlocksCredentialRotation("ACTIVE", "PAUSED"), true);
  assert.equal(deploymentBlocksCredentialRotation("UNVERIFIED", "PAUSED"), true);
});
