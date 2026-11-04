import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { patchAgentCallbackSource, patchV2ClientSource } from "./agent-selection-patch.mjs";

const packageRoot = process.env.OPENCODE_TELEGRAM_DIST
  ? path.resolve(process.env.OPENCODE_TELEGRAM_DIST)
  : (() => {
      const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("Could not locate global npm package directory.");
      return path.join(result.stdout.trim(), "@grinev", "opencode-telegram-bot", "dist");
    })();

async function patch(file, transform, label) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    throw new Error(`Could not find upstream ${label}; package layout changed.`);
  }
  const next = transform(source);
  if (next !== source) await writeFile(file, next, { mode: 0o644 });
  return next !== source;
}

const clientChanged = await patch(
  path.join(packageRoot, "opencode/v2/client.js"),
  patchV2ClientSource,
  "V2 OpenCode client",
);

const callbackChanged = await patch(
  path.join(packageRoot, "bot/callbacks/agent-selection-callback-handler.js"),
  patchAgentCallbackSource,
  "agent-selection callback",
);

process.stdout.write(
  "Immediate Plan/Build switching with OpenCode session verification: " +
    (clientChanged || callbackChanged ? "installed.\n" : "already installed.\n"),
);
