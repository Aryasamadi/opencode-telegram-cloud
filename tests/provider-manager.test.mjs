import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/provider-manager.mjs");

test("provider manager adds, lists, and removes providers without losing existing config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-provider-test-"));
  const configFile = path.join(root, "config", "opencode.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({
    model: "existing/model",
    provider: { existing: { name: "Existing", models: { model: { name: "Model" } } } },
    theme: "dark",
  }));
  const env = { ...process.env, HOME: root, OPENCODE_CONFIG_FILE: configFile };
  try {
    const add = spawnSync(process.execPath, [script, "add", "--id", "test-provider",
      "--name", "Test Provider", "--base-url", "https://api.example.test/v1/",
      "--api-key", "test-secret", "--model-id", "test-model"], { env, encoding: "utf8" });
    assert.equal(add.status, 0, add.stderr);
    assert.doesNotMatch(add.stdout + add.stderr, /test-secret/);
    let config = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(config.theme, "dark");
    assert.ok(config.provider.existing);
    assert.equal(config.provider["test-provider"].options.baseURL, "https://api.example.test/v1");
    assert.equal(config.provider["test-provider"].options.apiKey, "test-secret");
    assert.ok(config.provider["test-provider"].models["test-model"]);

    const duplicate = spawnSync(process.execPath, [script, "add", "--id", "test-provider",
      "--name", "Replacement", "--base-url", "https://other.example.test/v1",
      "--api-key", "replacement-secret", "--model-id", "replacement-model"], { env, encoding: "utf8" });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /already exists/);
    assert.doesNotMatch(duplicate.stderr + duplicate.stdout, /replacement-secret/);
    config = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(config.provider["test-provider"].options.apiKey, "test-secret");
    assert.equal(config.provider["test-provider"].models["test-model"].name, "test-model");

    const list = spawnSync(process.execPath, [script, "list"], { env, encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /test-provider.*test-model/);
    assert.doesNotMatch(list.stdout, /test-secret/);

    const remove = spawnSync(process.execPath, [script, "remove", "--id", "test-provider"], { env, encoding: "utf8" });
    assert.equal(remove.status, 0, remove.stderr);
    config = JSON.parse(await readFile(configFile, "utf8"));
    assert.ok(config.provider.existing);
    assert.equal(config.provider["test-provider"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
