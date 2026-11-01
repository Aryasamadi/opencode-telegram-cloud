import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("upstream Telegram patch installs /addmodel and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-patch-test-"));
  const routerDir = path.join(root, "bot", "routers");
  const commandDir = path.join(root, "bot", "commands");
  await mkdir(routerDir, { recursive: true });
  await mkdir(commandDir, { recursive: true });
  const router = [
    'import { mcpsCommand } from "../commands/mcp-catalog-command.js";',
    'bot.command("opencode_start", (ctx) => opencodeStartCommand(ctx, container));',
    'bot.command("opencode_stop", (ctx) => opencodeStopCommand(ctx, container));',
    'bot.command("mcps", (ctx) => mcpsCommand(ctx, container));',
  ].join("\n");
  const definitions = [
    "export const BOT_COMMANDS = getLocalizedBotCommands();",
    "export const BUILT_IN_COMMAND_NAMES = [",
    '  "start",',
    "];",
  ].join("\n");
  await writeFile(path.join(routerDir, "command-router.js"), router);
  await writeFile(path.join(commandDir, "definitions.js"), definitions);
  const env = { ...process.env, OPENCODE_TELEGRAM_DIST: root };
  try {
    const first = spawnSync(process.execPath, ["scripts/patch-telegram-bot.mjs"], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const patchedRouter = await readFile(path.join(routerDir, "command-router.js"), "utf8");
    const patchedDefinitions = await readFile(path.join(commandDir, "definitions.js"), "utf8");
    assert.match(patchedRouter, /addModelCommand/);
    assert.match(patchedRouter, /bot\.command\("addmodel"/);
    assert.match(patchedRouter, /bot\.command\("opencode_start", \(ctx\) => ctx\.reply\(/);
    assert.match(patchedRouter, /bot\.command\("opencode_stop", \(ctx\) => ctx\.reply\(/);
    assert.doesNotMatch(patchedRouter, /opencodeStopCommand\(ctx, container\)/);
    assert.match(patchedDefinitions, /command: "addmodel"/);
    assert.match(patchedDefinitions, /"addmodel",/);
    const second = spawnSync(process.execPath, ["scripts/patch-telegram-bot.mjs"], { env, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(path.join(routerDir, "command-router.js"), "utf8"), patchedRouter);
    assert.equal(await readFile(path.join(commandDir, "definitions.js"), "utf8"), patchedDefinitions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
