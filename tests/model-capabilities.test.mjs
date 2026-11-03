import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyModelPatch,
  applyVariantPatch,
  buildIndex,
  expectedEffortIds,
  findModelEntry,
  loadSnapshot,
  planConfig,
  planVariantConfig,
  reasoningSupport,
  safeLimits,
  saveSnapshot,
  trimCatalog,
} from "../scripts/model-catalog.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const catalog = {
  nvidia: {
    models: {
      "minimaxai/minimax-m3.1-flash": {
        name: "MiniMax M3.1 Flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        limit: { context: 262144, output: 262144 },
      },
      "z-ai/glm-5.3-flash": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        limit: { context: 1000000, output: 131072 },
      },
      "somevendor/plain-chat": {
        reasoning: false,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
  google: {
    models: {
      "gemini-3.8-flash": {
        canonical_model_id: "google/gemini-3.8-flash",
        family: "gemini-flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        limit: { context: 1048576, output: 65536 },
      },
    },
  },
  openai: {
    models: {
      "gpt-6-luna": {
        canonical_model_id: "openai/gpt-6-luna",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
        limit: { context: 1050000, output: 128000 },
      },
    },
  },
};

test("trimCatalog keeps only capability-relevant fields and is idempotent", () => {
  const raw = {
    p: {
      models: {
        m: { name: "M", description: "long text", reasoning: true, limit: { context: 1, output: 2 }, cost: [{ input: 1 }] },
      },
    },
  };
  const once = trimCatalog(raw);
  assert.deepEqual(once, { p: { models: { m: { name: "M", reasoning: true, limit: { context: 1, output: 2 } } } } });
  assert.deepEqual(trimCatalog(once), once);
});

test("snapshot round-trips through gzip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-snapshot-"));
  try {
    const file = path.join(dir, "snap.json.gz");
    await saveSnapshot(catalog, file);
    assert.deepEqual(await loadSnapshot(file), catalog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findModelEntry resolves exact, cross-provider, vendor-prefixed, and canonical matches", () => {
  const index = buildIndex(catalog);
  const exact = findModelEntry(index, "nvidia", "minimaxai/minimax-m3.1-flash");
  assert.equal(exact.match, "provider+model");
  assert.deepEqual(expectedEffortIds(exact), ["low", "medium", "high", "xhigh", "max"]);

  // A custom provider id serving the same model id must still find the entry.
  const cross = findModelEntry(index, "my-custom-provider", "minimaxai/minimax-m3.1-flash");
  assert.ok(cross);
  assert.deepEqual(expectedEffortIds(cross), ["low", "medium", "high", "xhigh", "max"]);

  // Gemini-style ids with a "models/" prefix resolve to the upstream owner.
  const gemini = findModelEntry(index, "gemini", "models/gemini-3.8-flash");
  assert.equal(`${gemini.providerID}/${gemini.modelID}`, "google/gemini-3.8-flash");
  assert.deepEqual(expectedEffortIds(gemini), ["low", "medium", "high"]);

  // "none" is never offered as an explicit effort variant.
  const luna = findModelEntry(index, "vyceai", "gpt-6-luna");
  assert.deepEqual(expectedEffortIds(luna), ["low", "high"]);

  assert.equal(findModelEntry(index, "nvidia", "totally-unknown-model"), null);
});

test("reasoningSupport distinguishes effort, toggle, and unsupported", () => {
  const index = buildIndex(catalog);
  assert.deepEqual(reasoningSupport(findModelEntry(index, "nvidia", "minimaxai/minimax-m3.1-flash")), {
    supported: true,
    toggle: false,
    effort: ["low", "medium", "high", "xhigh", "max"],
  });
  assert.deepEqual(reasoningSupport(findModelEntry(index, "nvidia", "somevendor/plain-chat")), {
    supported: false,
    toggle: false,
    effort: [],
  });
});

test("safeLimits reserves headroom and caps output (matches the verified live values)", () => {
  // MiniMax M3.1 Flash: 262144 context -> reserve 15% (39322) -> 222822; output capped at 12%.
  assert.deepEqual(safeLimits({ context: 262144, output: 262144 }), {
    context: 222822,
    output: 31457,
    trueContext: 262144,
    trueOutput: 262144,
  });
  // 1M context model: output capped at 32768.
  const big = safeLimits({ context: 1048576, output: 65536 });
  assert.equal(big.context, 891289);
  assert.equal(big.output, 32768);
  // Small windows keep the 8192 minimum reserve and never go below 1024.
  assert.deepEqual(safeLimits({ context: 16384, output: 4096 }), {
    context: 8192,
    output: 1966,
    trueContext: 16384,
    trueOutput: 4096,
  });
  assert.equal(safeLimits({}), null);
  assert.equal(safeLimits({ context: 0 }), null);
});

test("planConfig plans capabilities+limit for every provider/model and reports misses", () => {
  const config = {
    provider: {
      nvidia: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.test/v1", apiKey: "secret-value" },
        models: {
          "minimaxai/minimax-m3.1-flash": { name: "minimaxai/minimax-m3.1-flash" },
          "unknown-model-xyz": { name: "unknown-model-xyz" },
        },
      },
      gemini: { models: { "gemini-3.8-flash": { name: "gemini-3.8-flash" } } },
    },
  };
  const { changes, missed } = planConfig(config, catalog);
  assert.equal(changes.length, 2);
  assert.deepEqual(missed, [{ providerID: "nvidia", modelID: "unknown-model-xyz" }]);
  const minimax = changes.find((c) => c.modelID.includes("minimax"));
  assert.deepEqual(minimax.patch.capabilities, {
    reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] },
  });
  assert.deepEqual(minimax.patch.limit, { context: 222822, output: 31457 });
  const gemini = changes.find((c) => c.providerID === "gemini");
  assert.deepEqual(gemini.patch.limit, { context: 891289, output: 32768 });
});

test("applyModelPatch is idempotent and preserves unrelated keys", () => {
  const modelCfg = { name: "m", options: { apiKey: "secret" } };
  const patch = { capabilities: { reasoning: { supported: true, effort: ["low"] } }, limit: { context: 100, output: 10 } };
  assert.equal(applyModelPatch(modelCfg, patch), true);
  assert.equal(modelCfg.options.apiKey, "secret");
  assert.equal(applyModelPatch(modelCfg, patch), false);
});

test("planVariantConfig detects dropped effort variants and undersized default limits", () => {
  const config = {
    provider: {
      nvidia: { models: { "minimaxai/minimax-m3.1-flash": { name: "x" } } },
      gemini: { models: { "gemini-3.8-flash": { name: "y" } } },
    },
  };
  const liveModels = [
    { providerID: "nvidia", id: "minimaxai/minimax-m3.1-flash", variants: [{ id: "none" }, { id: "thinking" }], limit: { context: 262144, output: 262144 } },
    { providerID: "gemini", id: "gemini-3.8-flash", variants: [{ id: "low" }, { id: "medium" }, { id: "high" }], limit: { context: 200000, output: 32000 } },
  ];
  const plans = planVariantConfig(config, liveModels, catalog);
  const minimax = plans.find((p) => p.modelID.includes("minimax"));
  assert.deepEqual(minimax.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(minimax.missing, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(minimax.limit, null); // live limit already equals the safe limit
  const gemini = plans.find((p) => p.providerID === "gemini");
  assert.deepEqual(gemini.efforts, ["low", "medium", "high"]);
  assert.deepEqual(gemini.missing, []);
  assert.deepEqual(gemini.limit, { context: 891289, output: 32768 }); // 200000 default is smaller than the real window
});

test("applyVariantPatch writes a V1 object map with reasoningEffort and converts arrays", () => {
  const fromArray = { variants: [{ id: "none", settings: {} }, "thinking"] };
  assert.equal(applyVariantPatch(fromArray, ["low", "max"]), true);
  assert.deepEqual(fromArray.variants, {
    none: { settings: {} },
    thinking: {},
    low: { reasoningEffort: "low" },
    max: { reasoningEffort: "max" },
  });
  assert.equal(applyVariantPatch(fromArray, ["low", "max"]), false); // idempotent

  const fresh = {};
  assert.equal(applyVariantPatch(fresh, ["high"]), true);
  assert.deepEqual(fresh.variants, { high: { reasoningEffort: "high" } });
});

test("configure-model-capabilities CLI: dry-run, write, idempotence, check, secret safety", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-caps-"));
  try {
    const configPath = path.join(dir, "opencode.json");
    const catalogPath = path.join(dir, "catalog.json");
    await writeFile(catalogPath, JSON.stringify(catalog));
    await writeFile(configPath, JSON.stringify({
      provider: {
        nvidia: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://example.test/v1", apiKey: "super-secret-key" },
          models: { "minimaxai/minimax-m3.1-flash": { name: "minimaxai/minimax-m3.1-flash" } },
        },
      },
    }, null, 2));
    const env = { ...process.env, OPENCODE_CONFIG_FILE: configPath };
    const run = (args) => spawnSync(process.execPath, ["scripts/configure-model-capabilities.mjs", ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });

    const before = await readFile(configPath, "utf8");

    const dry = run(["--catalog", catalogPath, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /minimaxai\/minimax-m3\.1-flash/);
    assert.equal(await readFile(configPath, "utf8"), before, "dry-run must not write");

    const check = run(["--catalog", catalogPath, "--check"]);
    assert.equal(check.status, 1, "check exits 1 while changes are pending");

    const apply = run(["--catalog", catalogPath]);
    assert.equal(apply.status, 0, apply.stderr);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    const model = written.provider.nvidia.models["minimaxai/minimax-m3.1-flash"];
    assert.deepEqual(model.capabilities, { reasoning: { supported: true, effort: ["low", "medium", "high", "xhigh", "max"] } });
    assert.deepEqual(model.limit, { context: 222822, output: 31457 });
    assert.equal(written.provider.nvidia.options.apiKey, "super-secret-key", "secret untouched");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, "config written 0600");
    assert.ok(!apply.stdout.includes("super-secret-key"), "secret never printed");

    const again = run(["--catalog", catalogPath]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already up to date/);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).provider.nvidia.models["minimaxai/minimax-m3.1-flash"].limit.context, 222822);

    const checkAfter = run(["--catalog", catalogPath, "--check"]);
    assert.equal(checkAfter.status, 0, "check exits 0 once applied");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile CLI plans variant patches from a saved /api/model response without a server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reconcile-"));
  try {
    const configPath = path.join(dir, "opencode.json");
    const catalogPath = path.join(dir, "catalog.json");
    const modelsPath = path.join(dir, "models.json");
    await writeFile(catalogPath, JSON.stringify(catalog));
    await writeFile(configPath, JSON.stringify({
      provider: { nvidia: { models: { "minimaxai/minimax-m3.1-flash": { name: "x" } } } },
    }, null, 2));
    await writeFile(modelsPath, JSON.stringify({
      data: [
        { providerID: "nvidia", id: "minimaxai/minimax-m3.1-flash", variants: [{ id: "none" }, { id: "thinking" }], limit: { context: 262144, output: 262144 } },
      ],
    }));
    const env = { ...process.env, OPENCODE_CONFIG_FILE: configPath };
    const run = (args) => spawnSync(process.execPath, ["scripts/reconcile-reasoning-variants.mjs", ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });

    const dry = run(["--catalog", catalogPath, "--models-file", modelsPath, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /variants \+low,medium,high,xhigh,max/);

    const check = run(["--catalog", catalogPath, "--models-file", modelsPath, "--check"]);
    assert.equal(check.status, 1);

    const apply = run(["--catalog", catalogPath, "--models-file", modelsPath, "--no-reload"]);
    assert.equal(apply.status, 0, apply.stderr);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(written.provider.nvidia.models["minimaxai/minimax-m3.1-flash"].variants, {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    });

    // A second run against a live response that already has the variants is a no-op.
    await writeFile(modelsPath, JSON.stringify({
      data: [
        { providerID: "nvidia", id: "minimaxai/minimax-m3.1-flash", variants: ["none", "thinking", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })), limit: { context: 222822, output: 31457 } },
      ],
    }));
    const done = run(["--catalog", catalogPath, "--models-file", modelsPath]);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /no changes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the committed snapshot loads and resolves the models used in production", async () => {
  const index = buildIndex(await loadSnapshot());
  const minimax = findModelEntry(index, "nvidia", "minimaxai/minimax-m3.1-flash");
  assert.deepEqual(expectedEffortIds(minimax), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(safeLimits(minimax.limit), { context: 222822, output: 31457, trueContext: 262144, trueOutput: 262144 });
  const gemini = findModelEntry(index, "gemini", "gemini-3.8-flash");
  assert.equal(`${gemini.providerID}/${gemini.modelID}`, "google/gemini-3.8-flash");
});
