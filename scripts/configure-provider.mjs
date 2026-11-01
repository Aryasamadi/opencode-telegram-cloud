#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const values = {
  id: process.env.AI_PROVIDER_ID?.trim(),
  name: process.env.AI_PROVIDER_NAME?.trim(),
  baseURL: process.env.AI_BASE_URL?.trim(),
  apiKey: process.env.AI_PROVIDER_API_KEY,
  modelID: process.env.AI_MODEL_ID?.trim(),
  modelName: process.env.AI_MODEL_NAME?.trim(),
};

const supplied = Object.values(values).some((value) => Boolean(value));
const required = ["id", "baseURL", "apiKey"];
const missing = required.filter((key) => !values[key]);

if (!supplied) {
  process.stdout.write("No custom provider supplied; keeping persisted OpenCode providers unchanged.\n");
  process.exit(0);
}

if (missing.length) {
  throw new Error(`Custom provider is partially configured. Missing: ${missing.join(", ")}.`);
}
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(values.id)) {
  throw new Error("AI_PROVIDER_ID may contain only letters, numbers, dots, underscores, and hyphens.");
}

let endpoint;
try {
  endpoint = new URL(values.baseURL);
} catch {
  throw new Error("AI_BASE_URL must be a valid absolute HTTP(S) URL.");
}
if (!["https:", "http:"].includes(endpoint.protocol)) {
  throw new Error("AI_BASE_URL must use HTTP or HTTPS.");
}
if (endpoint.username || endpoint.password) {
  throw new Error("Put provider credentials in AI_PROVIDER_API_KEY, not in AI_BASE_URL.");
}

async function discoverModels() {
  const baseURL = values.baseURL.replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${values.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Could not reach the provider /models endpoint. Supply AI_MODEL_ID or verify AI_BASE_URL.");
  }
  if (!response.ok) {
    throw new Error(`Provider /models returned HTTP ${response.status}. Supply AI_MODEL_ID or verify provider access.`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Provider /models did not return valid JSON. Supply AI_MODEL_ID.");
  }
  const candidates = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(candidates)) {
    throw new Error("Provider /models response has no model list. Supply AI_MODEL_ID.");
  }
  const ids = [...new Set(candidates.map((item) =>
    typeof item === "string" ? item : item?.id ?? item?.name
  ).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  if (ids.length === 0) {
    throw new Error("Provider /models returned no usable model IDs. Supply AI_MODEL_ID.");
  }
  return ids;
}

const modelIDs = values.modelID ? [values.modelID] : await discoverModels();
const models = Object.fromEntries(modelIDs.map((id) => [id, {
  name: id === values.modelID ? (values.modelName || id) : id,
}]));

const home = process.env.HOME;
if (!home) throw new Error("HOME is not set.");
const configPath = path.join(home, ".config", "opencode", "opencode.json");
await mkdir(path.dirname(configPath), { recursive: true });

let config = {};
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw new Error("Existing ~/.config/opencode/opencode.json is not valid JSON; refusing to overwrite it.");
  }
}

config.$schema ??= "https://opencode.ai/config.json";
config.provider ??= {};
config.provider[values.id] = {
  npm: "@ai-sdk/openai-compatible",
  name: values.name || values.id,
  options: {
    baseURL: values.baseURL.replace(/\/+$/, ""),
    apiKey: "{env:AI_PROVIDER_API_KEY}",
  },
  models,
};

await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(
  `Provider ${values.id} registered in persistent OpenCode config with ${modelIDs.length} model(s). API key is referenced through AI_PROVIDER_API_KEY and is not written to disk.\n`,
);
