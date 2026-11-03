import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL as toFileUrl } from "node:url";

// Fixture mirrors the upstream dist files that scripts/patch-provider-features.mjs
// anchors on. The real package is smoke-tested in CI; here we verify the patch
// transforms, is idempotent, and installs the context-overflow recovery layer.
async function makeFixture(root) {
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-bot", type: "module" }));
  const files = {
    "bot/routers/command-router.js": [
      'import { mcpsCommand } from "../commands/mcp-catalog-command.js";',
      'bot.command("opencode_start", (ctx) => opencodeStartCommand(ctx, container));',
      'bot.command("mcps", (ctx) => mcpsCommand(ctx, container));',
    ].join("\n"),
    "bot/commands/definitions.js": [
      "export const BOT_COMMANDS = getLocalizedBotCommands();",
      "export const BUILT_IN_COMMAND_NAMES = [",
      '  "start",',
      "];",
    ].join("\n"),
    "bot/callbacks/model-selection-callback-handler.js": [
      "export async function handler(ctx) {",
      "  const providers = await getProviders();",
      "}",
    ].join("\n"),
    "app/services/model-selection-service.js": [
      "var validatedFavorites = [], offeredDefaultModels = [], envDefaultModel = [];",
      "function dedupeModels(x) { return x; }",
      "function filterModelsByCatalog() { return []; }",
      "async function getValidModelKeys() { return []; }",
      "export function getStoredModel() { return { providerID: \"p\", modelID: \"m\" }; }",
      "const favorites = dedupeModels([...validatedFavorites, ...offeredDefaultModels]);",
      "favorites: filterModelsByCatalog([envDefaultModel], await getValidModelKeys()), 0;",
    ].join("\n"),
    "app/services/agent-selection-service.js": [
      "export function getStoredAgent() { return undefined; }",
      "export async function resolveProjectAgent(preferred) { return preferred; }",
    ].join("\n"),
    "opencode/client.js": [
      "export const opencodeClient = {};",
    ].join("\n"),
    "utils/logger.js": [
      "export const logger = { warn() {}, error() {}, info() {}, debug() {} };",
    ].join("\n"),
    "bot/menus/session-selection-menu.js": [
      "const keyboard = new InlineKeyboard();",
      "keyboard.text(label, `${SESSION_CALLBACK_PREFIX}${session.id}`).row();",
    ].join("\n"),
    "bot/callbacks/session-callback-handler.js": [
      'import { handleSessionSelect as upstream } from "./upstream.js";',
      "export async function handleSessionSelect(ctx, deps) {",
      "}",
    ].join("\n"),
    "app/managers/summary-aggregation-manager.js": [
      'import { getCurrentProject } from "../stores/settings-store.js";',
      "class Aggregator {",
      "    handleSessionError(event) {",
      "        const { sessionID, error } = event.properties;",
      "        logger.warn(`[Aggregator] Session error: ${sessionID}: ${message}`);",
      "    }",
      "}",
    ].join("\n"),
    "bot/menus/variant-selection-menu.js": [
      "export async function showVariantSelectionMenu(ctx, deps) {",
      "    const currentModel = getStoredModel();",
      '    await ctx.reply(t("variant.menu.empty"));',
      "}",
    ].join("\n"),
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

test("provider-features patch installs overflow recovery and no-variants notice, idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-features-"));
  try {
    await makeFixture(root);
    const env = { ...process.env, OPENCODE_TELEGRAM_DIST: root };
    const run = () => spawnSync(process.execPath, ["scripts/patch-provider-features.mjs"], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), env, encoding: "utf8" });

    const first = run();
    assert.equal(first.status, 0, first.stderr);

    const helper = await readFile(path.join(root, "app/services/overflow-recovery-service.js"), "utf8");
    assert.match(helper, /export function isContextOverflowError/);
    assert.match(helper, /export async function recoverSessionFromOverflow/);
    assert.match(helper, /session\.summarize/); // maps to session.compact in the v2 client
    assert.match(helper, /session\.promptAsync/);
    assert.match(helper, /details\?\.type/);
    assert.match(helper, /context\[_ -\]\?length/);

    const aggregator = await readFile(path.join(root, "app/managers/summary-aggregation-manager.js"), "utf8");
    assert.match(aggregator, /import \{ isContextOverflowError, recoverSessionFromOverflow \} from "\.\.\/services\/overflow-recovery-service\.js";/);
    assert.match(aggregator, /if \(isContextOverflowError\(error\)\) \{/);
    assert.match(aggregator, /void recoverSessionFromOverflow\(sessionID\);/);

    const menu = await readFile(path.join(root, "bot/menus/variant-selection-menu.js"), "utf8");
    assert.match(menu, /has no reasoning variants/);

    // Pre-existing patches still land on the fixture.
    const router = await readFile(path.join(root, "bot/routers/command-router.js"), "utf8");
    assert.match(router, /bot\.command\("removeprovider"/);

    const snapshot = {};
    for (const relative of ["app/managers/summary-aggregation-manager.js", "bot/menus/variant-selection-menu.js", "bot/routers/command-router.js", "app/services/overflow-recovery-service.js"]) {
      snapshot[relative] = await readFile(path.join(root, relative), "utf8");
    }
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already installed/);
    for (const [relative, content] of Object.entries(snapshot)) {
      assert.equal(await readFile(path.join(root, relative), "utf8"), content, `${relative} must be stable across runs`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isContextOverflowError logic: patterns compiled from the helper match NVIDIA's shape", async () => {
  // Extract and evaluate the helper's detector against the real NVIDIA 400 payload
  // and against unrelated errors that must NOT trigger recovery.
  const root = await mkdtemp(path.join(os.tmpdir(), "overflow-detector-"));
  try {
    await makeFixture(root);
    const env = { ...process.env, OPENCODE_TELEGRAM_DIST: root };
    const result = spawnSync(process.execPath, ["scripts/patch-provider-features.mjs"], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const helperPath = path.join(root, "app/services/overflow-recovery-service.js");
    const mod = await import(toFileUrl(helperPath).href);
    assert.equal(typeof mod.isContextOverflowError, "function");

    const nvidiaOverflow = { message: "Invalid request", details: { type: "context_length", limit: 262144, actual: 262569 } };
    assert.equal(mod.isContextOverflowError(nvidiaOverflow), true);
    assert.equal(mod.isContextOverflowError({ message: "Invalid request", details: { type: "context_length", limit: 100, actual: 50 } }), true); // type match even when not over
    assert.equal(mod.isContextOverflowError({ message: "prompt is too long for model" }), true);
    assert.equal(mod.isContextOverflowError({ message: "reduce the length of the message" }), true);
    assert.equal(mod.isContextOverflowError({ error: { message: "maximum context length exceeded (131072)" } }), true);
    // Non-overflow errors must not trigger compaction.
    assert.equal(mod.isContextOverflowError({ message: "Invalid request" }), false);
    assert.equal(mod.isContextOverflowError({ message: "invalid api key", details: { type: "auth" } }), false);
    assert.equal(mod.isContextOverflowError({ message: "rate limit exceeded" }), false);
    assert.equal(mod.isContextOverflowError(undefined), false);
    assert.equal(mod.isContextOverflowError(null), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
