#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error([
    "Usage:",
    "  node scripts/provider-manager.mjs add --id ID --name NAME --base-url URL --api-key KEY [--model-id ID]",
    "  node scripts/provider-manager.mjs remove --id ID",
    "  node scripts/provider-manager.mjs list",
    "",
    "If --model-id is omitted, the provider's OpenAI-compatible /models endpoint is queried.",
  ].join("\n"));
  process.exit(2);
}

function argsToOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (!item.startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) usage();
    const key = item.slice(2);
    if (Object.hasOwn(options, key)) usage();
    options[key] = args[++i];
  }
  return options;
}

function required(options, key) {
  const value = options[key]?.trim();
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function validateId(id) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new Error("Provider ID must be 1–64 letters, numbers, dots, underscores, or hyphens.");
  }
}

function configFile() {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set.");
  return process.env.OPENCODE_CONFIG_FILE || path.join(home, ".config", "opencode", "opencode.json");
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

async function discoverModels(baseURL, apiKey) {
  let response;
  try {
    response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Could not reach provider /models. Supply --model-id or verify --base-url.");
  }
  if (!response.ok) throw new Error(`Provider /models returned HTTP ${response.status}. Supply --model-id if discovery is unsupported.`);
  let payload;
  try { payload = await response.json(); } catch {
    throw new Error("Provider /models did not return valid JSON. Supply --model-id.");
  }
  const items = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(items)) throw new Error("Provider /models response contains no model list. Supply --model-id.");
  const ids = [...new Set(items.map((item) => typeof item === "string" ? item : item?.id ?? item?.name)
    .filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  if (!ids.length) throw new Error("Provider /models returned no usable model IDs. Supply --model-id.");
  return ids;
}

async function addProvider(options) {
  const id = required(options, "id");
  const name = options.name?.trim() || id;
  const baseURL = required(options, "base-url").replace(/\/+$/, "");
  const apiKey = options["api-key"]?.trim() || process.env.AI_PROVIDER_API_KEY;
  if (!apiKey) throw new Error("Missing provider API key.");
  const explicitModel = options["model-id"]?.trim();
  validateId(id);
  let url;
  try { url = new URL(baseURL); } catch { throw new Error("--base-url must be an absolute HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("--base-url must use HTTP(S) and must not contain embedded credentials.");
  }
  const modelIDs = explicitModel ? [explicitModel] : await discoverModels(baseURL, apiKey);
  const models = Object.fromEntries(modelIDs.map((modelID) => [modelID, { name: modelID }]));
  const file = configFile();
  const config = await readConfig(file);
  if (Object.hasOwn(config.provider ?? {}, id)) {
    throw new Error(`Provider "${id}" already exists. Remove it before adding it again.`);
  }
  config.$schema ??= "https://opencode.ai/config.json";
  config.provider ??= {};
  config.provider[id] = {
    npm: "@ai-sdk/openai-compatible",
    name,
    options: { baseURL, apiKey },
    models,
  };
  await writeConfig(file, config);
  process.stdout.write(`Registered provider "${id}" with ${modelIDs.length} model(s). Use /reload, then /models → Providers.\n`);
}

async function removeProvider(options) {
  const id = required(options, "id");
  validateId(id);
  const file = configFile();
  const config = await readConfig(file);
  if (!config.provider?.[id]) {
    process.stdout.write(`Provider "${id}" was not configured.\n`);
    return;
  }
  delete config.provider[id];
  if (typeof config.model === "string" && config.model.startsWith(`${id}/`)) delete config.model;
  await writeConfig(file, config);
  process.stdout.write(`Removed provider "${id}". Use /reload to refresh OpenCode.\n`);
}

async function listProviders() {
  const config = await readConfig(configFile());
  const providers = config.provider ?? {};
  const entries = Object.entries(providers);
  if (!entries.length) {
    process.stdout.write("No custom providers are configured in opencode.json.\n");
    return;
  }
  for (const [id, provider] of entries) {
    const models = Object.keys(provider?.models ?? {});
    process.stdout.write(`${id} | ${provider?.name ?? id} | ${models.join(", ") || "no models"}\n`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!["add", "remove", "list"].includes(command)) usage();
const options = argsToOptions(rest);
if (command === "add") await addProvider(options);
else if (command === "remove") await removeProvider(options);
else await listProviders();
