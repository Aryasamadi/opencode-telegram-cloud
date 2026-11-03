#!/usr/bin/env node
// L2: post-start reconciliation of reasoning variants and limits against the LIVE
// OpenCode server, for every provider and model — not just one.
//
// OpenCode 2.2.5's NVIDIA variant protocol drops catalog effort options for
// minimax*/glm* (it only builds a thinking toggle), and any provider protocol can
// do the same. This script reads GET /api/model, compares each model's live variant
// ids with the effort ids declared in models.dev, writes the missing ones as explicit
// config variants ({ id: { reasoningEffort: id } }), fixes default limits that are
// smaller than the model's real context window, reloads the config
// (POST /api/location/reload) and re-verifies the live state.
//
// Env: OPENCODE_API_URL (default http://127.0.0.1:49374), OPENCODE_SERVER_PASSWORD,
//      OPENCODE_SERVER_USERNAME (default opencode).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SNAPSHOT,
  applyModelPatch,
  applyVariantPatch,
  loadCatalog,
  planVariantConfig,
  trimCatalog,
} from "./model-catalog.mjs";
import { reloadOpenCodeConfig } from "./reload-opencode-config.mjs";

function usage() {
  return [
    "Usage: node scripts/reconcile-reasoning-variants.mjs [options]",
    "",
    "Options:",
    "  --config <path>     OpenCode config file (default: OPENCODE_CONFIG_FILE or XDG path)",
    "  --snapshot <path>   models.dev snapshot override",
    "  --catalog <path>    plain models.dev api.json instead of the snapshot",
    "  --models-file <path> read a saved /api/model response instead of calling the server (offline mode)",
    "  --no-fetch          never hit models.dev; fail if snapshot/catalog is missing",
    "  --no-reload         write the config but skip POST /api/location/reload and re-verification",
    "  --dry-run           print planned changes without writing",
    "  --check             exit 1 when changes are pending; writes nothing",
    "  --help              show this help",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseArgs(argv) {
  const options = { dryRun: false, check: false, reload: true, modelsFile: null, catalog: null, snapshot: DEFAULT_SNAPSHOT, config: null, noFetch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help": options.help = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--check": options.check = true; break;
      case "--no-fetch": options.noFetch = true; break;
      case "--no-reload": options.reload = false; break;
      case "--config": options.config = requireValue(argv, ++i, arg); break;
      case "--snapshot": options.snapshot = requireValue(argv, ++i, arg); break;
      case "--catalog": options.catalog = requireValue(argv, ++i, arg); break;
      case "--models-file": options.modelsFile = requireValue(argv, ++i, arg); break;
      default: throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function configFile(explicit) {
  if (explicit) return path.resolve(explicit);
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set.");
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return process.env.OPENCODE_CONFIG_FILE || path.join(configHome, "opencode", "opencode.json");
}

async function readConfig(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("OpenCode config is unreadable or invalid JSON; refusing to overwrite it.");
  }
}

async function writeConfig(file, config) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

function authHeader(env) {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) throw new Error("OPENCODE_SERVER_PASSWORD is not set; cannot call the OpenCode server.");
  const username = env.OPENCODE_SERVER_USERNAME || "opencode";
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function apiBase(env) {
  return (env.OPENCODE_API_URL?.trim() || "http://127.0.0.1:49374").replace(/\/+$/, "");
}

async function fetchModels(env, authorization) {
  const response = await fetch(`${apiBase(env)}/api/model`, {
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GET /api/model failed with HTTP ${response.status}`);
  const payload = await response.json();
  const models = payload?.data ?? payload;
  if (!Array.isArray(models)) throw new Error("GET /api/model did not return a model list.");
  return models;
}

function describePlan(plan) {
  const parts = [];
  if (plan.missing.length) parts.push(`variants +${plan.missing.join(",")} (reasoningEffort; full set: ${plan.efforts.join(",")})`);
  if (plan.limit) parts.push(`limit(context=${plan.limit.context},output=${plan.limit.output})`);
  return parts.join(" +");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const file = configFile(options.config);
  const config = await readConfig(file);

  let catalog;
  if (options.catalog) {
    catalog = trimCatalog(JSON.parse(await readFile(options.catalog, "utf8")));
  } else {
    catalog = await loadCatalog({ snapshot: options.snapshot, allowFetch: !options.noFetch });
  }

  let liveModels;
  let authorization = null;
  if (options.modelsFile) {
    const payload = JSON.parse(await readFile(options.modelsFile, "utf8"));
    liveModels = payload?.data ?? payload;
  } else {
    authorization = authHeader(process.env);
    liveModels = await fetchModels(process.env, authorization);
  }
  if (!Array.isArray(liveModels)) throw new Error("No live model list available.");

  let plans = planVariantConfig(config, liveModels, catalog);

  const applied = [];
  for (const plan of plans) {
    // The model may be served from the provider catalog without a config entry; create
    // a minimal one so the explicit variants survive config normalization.
    const provider = (config.provider ??= {})[plan.providerID] ??= { models: {} };
    provider.models ??= {};
    const target = (provider.models[plan.modelID] ??= { name: plan.modelID });
    let changed = false;
    if (plan.efforts.length) changed = applyVariantPatch(target, plan.efforts) || changed;
    if (plan.limit) changed = applyModelPatch(target, { limit: plan.limit }) || changed;
    if (changed) applied.push(plan);
    process.stdout.write(`  ${plan.providerID}/${plan.modelID}: ${describePlan(plan)}${changed ? "" : " (already present)"}\n`);
  }

  if (!applied.length) {
    process.stdout.write(`All ${liveModels.length} live models already expose their catalog reasoning variants and safe limits; no changes.\n`);
    return 0;
  }
  process.stdout.write(`${applied.length} model(s) ${options.dryRun || options.check ? "would be" : ""} updated in ${file}.\n`);
  if (options.dryRun) return 0;
  if (options.check) return 1;

  await writeConfig(file, config);
  process.stdout.write(`Wrote ${file} (mode 600).\n`);

  if (options.reload && !options.modelsFile) {
    await reloadOpenCodeConfig(process.env);
    process.stdout.write("Reloaded OpenCode configuration (POST /api/location/reload).\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const verified = await fetchModels(process.env, authorization);
    const remaining = planVariantConfig({}, verified, catalog).filter((plan) => plan.missing.length);
    if (remaining.length) {
      for (const plan of remaining) {
        process.stderr.write(`Still missing after reload: ${plan.providerID}/${plan.modelID} variants ${plan.missing.join(",")}\n`);
      }
      return 1;
    }
    process.stdout.write(`Verified: all ${verified.length} live models now expose their catalog reasoning variants.\n`);
  }
  return 0;
}

process.exitCode = await main();
