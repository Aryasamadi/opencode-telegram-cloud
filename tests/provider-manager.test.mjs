import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";

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

test("removes provider by case-insensitive ID/display name and fails truthfully when absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-provider-remove-test-"));
  const configFile = path.join(root, "config", "opencode.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({
    provider: {
      "nvidia-kimi": { name: "NVIDIA Kimi", models: { "kimi-k2": { name: "Kimi K2" } } },
      keep: { name: "Keep", models: { model: { name: "Model" } } },
    },
  }));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), OPENCODE_CONFIG_FILE: configFile };
  try {
    const removeByName = spawnSync(process.execPath, [script, "remove", "--id", "NvidiaKimi"], { env, encoding: "utf8" });
    assert.equal(removeByName.status, 0, removeByName.stderr);
    assert.match(removeByName.stdout, /Removed provider "nvidia-kimi"/);
    let config = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(config.provider["nvidia-kimi"], undefined);
    assert.ok(config.provider.keep);

    const missing = spawnSync(process.execPath, [script, "remove", "--id", "not-configured"], { env, encoding: "utf8" });
    assert.notEqual(missing.status, 0, "missing providers must not look like successful removals");
    assert.match(missing.stderr, /was not found/);
    config = JSON.parse(await readFile(configFile, "utf8"));
    assert.ok(config.provider.keep);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registers the selected model plus the full provider /models catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-provider-catalog-test-"));
  const configFile = path.join(root, "config", "opencode.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer catalog-test-key");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [
      { id: "provider-model-a" },
      { id: "provider-model-b" },
      { id: "provider-model-c" },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const env = { ...process.env, HOME: root, OPENCODE_CONFIG_FILE: configFile };
  try {
    const add = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, "add", "--id", "catalog-provider",
        "--name", "Catalog Provider", "--base-url", `http://127.0.0.1:${address.port}/v1`,
        "--api-key", "catalog-test-key", "--model-id", "my-selected-model",
        "--discover-models", "true"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(add.code, 0, add.stderr);
    assert.match(add.stdout, /4 model\\(s\\)/);
    const config = JSON.parse(await readFile(configFile, "utf8"));
    const modelIDs = Object.keys(config.provider["catalog-provider"].models).sort();
    assert.deepEqual(modelIDs, [
      "my-selected-model", "provider-model-a", "provider-model-b", "provider-model-c",
    ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
