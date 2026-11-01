import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.OPENCODE_TELEGRAM_DIST
  ? path.resolve(process.env.OPENCODE_TELEGRAM_DIST)
  : (() => {
      const rootResult = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
      if (rootResult.status !== 0) throw new Error("Could not locate global npm package directory.");
      return path.join(rootResult.stdout.trim(), "@grinev", "opencode-telegram-bot", "dist");
    })();
const routerPath = path.join(packageRoot, "bot", "routers", "command-router.js");
const definitionsPath = path.join(packageRoot, "bot", "commands", "definitions.js");

async function patchFile(file, transform, label) {
  let source;
  try { source = await readFile(file, "utf8"); }
  catch { throw new Error(`Could not find upstream ${label}. The installed bot package layout may have changed.`); }
  const updated = transform(source);
  if (updated === source) return false;
  await writeFile(file, updated, { mode: 0o644 });
  return true;
}

const handlerUrl = pathToFileURL(path.resolve("scripts/addmodel-command.mjs")).href;
const routerChanged = await patchFile(routerPath, (source) => {
  let updated = source;
  if (!updated.includes("addModelCommand")) {
    const anchor = 'bot.command("mcps", (ctx) => mcpsCommand(ctx, container));';
    if (!updated.includes(anchor)) throw new Error("Upstream command-router registration anchor changed; refusing to patch.");
    const importAnchor = 'import { mcpsCommand } from "../commands/mcp-catalog-command.js";';
    if (!updated.includes(importAnchor)) throw new Error("Upstream command-router import anchor changed; refusing to patch.");
    updated = updated
      .replace(importAnchor, importAnchor + "\nimport { addModelCommand } from " + JSON.stringify(handlerUrl) + ";")
      .replace(anchor, anchor + '\nbot.command("addmodel", (ctx) => addModelCommand(ctx));');
  }

  const lifecycleMessage = "The OpenCode server is managed by this GitHub Actions run. Do not start or stop it from Telegram; end the workflow to shut it down safely.";
  const startAnchor = 'bot.command("opencode_start", (ctx) => opencodeStartCommand(ctx, container));';
  const stopAnchor = 'bot.command("opencode_stop", (ctx) => opencodeStopCommand(ctx, container));';
  const guardedStart = 'bot.command("opencode_start", (ctx) => ctx.reply(' + JSON.stringify(lifecycleMessage) + '));';
  const guardedStop = 'bot.command("opencode_stop", (ctx) => ctx.reply(' + JSON.stringify(lifecycleMessage) + '));';

  if (updated.includes(startAnchor)) updated = updated.replace(startAnchor, guardedStart);
  else if (!updated.includes(guardedStart)) throw new Error("Upstream /opencode_start route changed; refusing to patch lifecycle guard.");

  if (updated.includes(stopAnchor)) updated = updated.replace(stopAnchor, guardedStop);
  else if (!updated.includes(guardedStop)) throw new Error("Upstream /opencode_stop route changed; refusing to patch lifecycle guard.");

  return updated;
}, "command router");

const definitionsChanged = await patchFile(definitionsPath, (source) => {
  if (source.includes('command: "addmodel"')) return source;
  const botCommandsAnchor = "export const BOT_COMMANDS = getLocalizedBotCommands();";
  const builtinsAnchor = "export const BUILT_IN_COMMAND_NAMES = [";
  if (!source.includes(botCommandsAnchor) || !source.includes(builtinsAnchor)) {
    throw new Error("Upstream command definitions layout changed; refusing to patch.");
  }
  return source
    .replace(botCommandsAnchor, botCommandsAnchor + '\nBOT_COMMANDS.push({ command: "addmodel", description: "Add an OpenAI-compatible provider" });')
    .replace(builtinsAnchor, builtinsAnchor + '\n  "addmodel",');
}, "command definitions");

if (!routerChanged && !definitionsChanged) {
  process.stdout.write("Telegram addmodel integration is already installed.\n");
} else {
  process.stdout.write("Installed /addmodel into the upstream Telegram command router and command list.\n");
}
