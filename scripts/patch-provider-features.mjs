import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.OPENCODE_TELEGRAM_DIST
  ? path.resolve(process.env.OPENCODE_TELEGRAM_DIST)
  : (() => {
      const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("Could not locate global npm package directory.");
      return path.join(result.stdout.trim(), "@grinev", "opencode-telegram-bot", "dist");
    })();

async function patch(file, transform, label) {
  let source;
  try { source = await readFile(file, "utf8"); }
  catch { throw new Error("Could not find upstream " + label + "; package layout changed."); }
  const next = transform(source);
  if (next !== source) await writeFile(file, next, { mode: 0o644 });
  return next !== source;
}

const removeUrl = pathToFileURL(path.resolve("scripts/removeprovider-command.mjs")).href;
const router = await patch(path.join(packageRoot, "bot/routers/command-router.js"), (source) => {
  if (!source.includes("removeProviderCommand")) {
    const importAnchor = 'import { mcpsCommand } from "../commands/mcp-catalog-command.js";';
    const routeAnchor = 'bot.command("mcps", (ctx) => mcpsCommand(ctx, container));';
    if (!source.includes(importAnchor) || !source.includes(routeAnchor)) {
      throw new Error("Upstream command router anchors changed.");
    }
    source = source.replace(importAnchor, importAnchor + "\nimport { removeProviderCommand } from " + JSON.stringify(removeUrl) + ";");
    source = source.replace(routeAnchor, routeAnchor + '\nbot.command("removeprovider", (ctx) => removeProviderCommand(ctx));');
  }
  return source;
}, "command router");

const definitions = await patch(path.join(packageRoot, "bot/commands/definitions.js"), (source) => {
  if (source.includes('command: "removeprovider"')) return source;
  const commandsAnchor = "export const BOT_COMMANDS = getLocalizedBotCommands();";
  const builtinsAnchor = "export const BUILT_IN_COMMAND_NAMES = [";
  if (!source.includes(commandsAnchor) || !source.includes(builtinsAnchor)) {
    throw new Error("Upstream command definitions anchors changed.");
  }
  return source
    .replace(commandsAnchor, commandsAnchor + '\nBOT_COMMANDS.push({ command: "removeprovider", description: "Remove a provider by ID" });')
    .replace(builtinsAnchor, builtinsAnchor + '\n  "removeprovider",');
}, "command definitions");

const callback = await patch(path.join(packageRoot, "bot/callbacks/model-selection-callback-handler.js"), (source) => {
  if (!source.includes("reconcileStoredModelSelection")) {
    source = 'import { reconcileStoredModelSelection } from "../../app/services/model-selection-service.js";\n' + source;
  }
  const providersAnchor = "  const providers = await getProviders();";
  const refreshed = "  if (page === 0) {\n    await reconcileStoredModelSelection({ forceCatalogRefresh: true });\n  }\n" + providersAnchor;
  if (source.includes(providersAnchor) && !source.includes(refreshed)) {
    source = source.replace(providersAnchor, refreshed);
  }
  if (!source.includes(refreshed)) throw new Error("Provider menu refresh anchor changed.");
  return source;
}, "model selection callback");

// Do not turn the deployment's bootstrap model into a permanent Favorite. Favorites
// must come from OpenCode's own model.json; the active selection is shown by the
// persistent keyboard and must remain independent of this bootstrap default.
const modelSelection = await patch(
  path.join(packageRoot, "app/services/model-selection-service.js"),
  (source) => {
    const favoriteAnchor = "const favorites = dedupeModels([...validatedFavorites, ...offeredDefaultModels]);";
    const fixedFavorite = "const favorites = validatedFavorites;";
    const fallbackAnchor = "favorites: filterModelsByCatalog([envDefaultModel], await getValidModelKeys()),";
    const fixedFallback = "favorites: [],";
    if (!source.includes(favoriteAnchor) && !source.includes(fixedFavorite)) {
      throw new Error("Upstream favorite-list construction changed; refusing to patch.");
    }
    if (!source.includes(fallbackAnchor) && !source.includes(fixedFallback)) {
      throw new Error("Upstream missing-state fallback changed; refusing to patch.");
    }
    return source
      .replace(favoriteAnchor, fixedFavorite)
      .replace(fallbackAnchor, fixedFallback);
  },
  "model selection service",
);

// Safe, explicit session deletion UI. This patches only the disposable installed dist package.
const sessionMenu = await patch(
  path.join(packageRoot, "bot/menus/session-selection-menu.js"),
  (source) => {
    const anchor = "keyboard.text(label, `${SESSION_CALLBACK_PREFIX}${session.id}`).row();";
    const replacement = "keyboard.text(label, `${SESSION_CALLBACK_PREFIX}${session.id}`);\n    keyboard.text(\"🗑\", `session:delete:${session.id}`).row();";
    if (source.includes(replacement)) return source;
    if (!source.includes(anchor)) throw new Error("Session menu anchor changed; refusing to patch.");
    return source.replace(anchor, replacement);
  },
  "session selection menu",
);

const deleteHelperPath = path.join(packageRoot, "bot/callbacks/safe-session-delete.js");
const deleteHelper = `import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession, clearSession } from "../../app/services/session-service.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { loadSessionPage, buildSessionSelectionMenuView } from "../menus/session-selection-menu.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
const PREFIX = "session:delete:";
const CONFIRM = "session:delete-confirm:";
const CANCEL = "session:delete-cancel:";
export async function handleSafeSessionDelete(ctx, deps) {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(PREFIX) && !data.startsWith(CONFIRM) && !data.startsWith(CANCEL)) return false;
  if (isForegroundBusy(deps)) { await ctx.answerCallbackQuery({ text: "Finish the running task before deleting a session.", show_alert: true }); return true; }
  const prefix = data.startsWith(CONFIRM) ? CONFIRM : data.startsWith(CANCEL) ? CANCEL : PREFIX;
  const sessionID = data.slice(prefix.length);
  if (!sessionID || sessionID.length > 128) { await ctx.answerCallbackQuery({ text: "Invalid session.", show_alert: true }); return true; }
  const project = getCurrentProject();
  if (!project) { await ctx.answerCallbackQuery({ text: "Select a project first.", show_alert: true }); return true; }
  if (prefix === PREFIX) {
    await ctx.answerCallbackQuery({ text: "Confirm deletion below." });
    await ctx.editMessageText("⚠️ Delete this session permanently? OpenCode will also delete its child sessions. This cannot be undone.", { reply_markup: { inline_keyboard: [[{ text: "🗑 Delete permanently", callback_data: CONFIRM + sessionID }], [{ text: "Cancel", callback_data: CANCEL + sessionID }]] } });
    return true;
  }
  if (prefix === CANCEL) {
    const page = await loadSessionPage(project.worktree, 0, config.bot.sessionsListLimit);
    const view = buildSessionSelectionMenuView(page, config.bot.sessionsListLimit);
    await ctx.answerCallbackQuery({ text: "Deletion cancelled." });
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
    return true;
  }
  try {
    const { data: target, error: getError } = await opencodeClient.session.get({ sessionID, directory: project.worktree });
    if (getError || !target || target.directory !== project.worktree) throw getError || new Error("Session not found in selected project.");
    const current = getCurrentSession();
    const { error } = await opencodeClient.session.delete({ sessionID, directory: project.worktree });
    if (error) throw error;
    if (current?.id === sessionID) clearSession();
    const page = await loadSessionPage(project.worktree, 0, config.bot.sessionsListLimit);
    const view = buildSessionSelectionMenuView(page, config.bot.sessionsListLimit);
    await ctx.answerCallbackQuery({ text: "Session deleted." });
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  } catch (error) { logger.error("[Sessions] Safe deletion failed:", error); await ctx.answerCallbackQuery({ text: "Could not delete session. It may already be gone.", show_alert: true }); }
  return true;
}
`;
await writeFile(deleteHelperPath, deleteHelper, { mode: 0o644 });

const sessionHandler = await patch(
  path.join(packageRoot, "bot/callbacks/session-callback-handler.js"),
  (source) => {
    const importAnchor = 'import { loadSessionPage } from "../menus/session-selection-menu.js";';
    if (!source.includes("handleSafeSessionDelete")) {
      if (!source.includes(importAnchor)) throw new Error("Session callback import anchor changed.");
      source = source.replace(importAnchor, importAnchor + '\nimport { handleSafeSessionDelete } from "./safe-session-delete.js";');
    }
    const handlerAnchor = "export async function handleSessionSelect(ctx, deps) {";
    const handlerReplacement = handlerAnchor + "\n  if (await handleSafeSessionDelete(ctx, deps)) return true;";
    if (!source.includes(handlerReplacement)) {
      if (!source.includes(handlerAnchor)) throw new Error("Session callback handler anchor changed.");
      source = source.replace(handlerAnchor, handlerReplacement);
    }
    return source;
  },
  "session callback handler",
);

process.stdout.write(
  "Provider removal, provider-menu refresh, and truthful Favorites list: " +
    (router || definitions || callback || modelSelection ? "installed.\\n" : "already installed.\\n"),
);
