#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
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
const required = ["id", "baseURL", "apiKey", "modelID"];
const missing = required.filter((key) => !values[key]);

if (!supplied) {
  process.stdout.write(
    "No custom provider configured; keeping the existing OpenCode provider selection.\n",
  );
  process.exit(0);
}

if (missing.length) {
  throw new Error(
    `Custom provider is partially configured. Missing: ${missing.join(", ")}. Add all required AI_PROVIDER_ID, AI_BASE_URL, AI_PROVIDER_API_KEY, and AI_MODEL_ID secrets.`,
  );
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

const config = {
  $schema: "https://opencode.ai/config.json",
  model: `${values.id}/${values.modelID}`,
  provider: {
    [values.id]: {
      npm: "@ai-sdk/openai-compatible",
      name: values.name || values.id,
      options: {
        baseURL: values.baseURL.replace(/\/+$/, ""),
        apiKey: "{env:AI_PROVIDER_API_KEY}",
      },
      models: {
        [values.modelID]: {
          name: values.modelName || values.modelID,
        },
      },
    },
  },
};

const output = path.join(process.env.RUNNER_TEMP || "/tmp", "opencode-provider.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});

if (!process.env.GITHUB_ENV) {
  throw new Error("GITHUB_ENV is not set; cannot pass the custom config to OpenCode.");
}
await writeFile(
  process.env.GITHUB_ENV,
  `OPENCODE_CONFIG=${output}\n`,
  { flag: "a", mode: 0o600 },
);

process.stdout.write(
  `Custom provider configured: ${values.id}/${values.modelID}. API key remains in the Actions secret and is referenced only as an environment variable.\n`,
);
