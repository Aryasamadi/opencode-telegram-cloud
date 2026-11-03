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
import { ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
const PREFIX = "session:delete:";
const CONFIRM = "session:delete-confirm:";
const CANCEL = "session:delete-cancel:";

async function closeEmptySessionMenu(ctx, deps) {
  // Clear the interaction slot before Telegram API calls so a failed message edit
  // can never leave the bot waiting for a button that no longer exists.
  deps.interactionManager.clearKind("inline", "manual");
  let deleted = false;
  try {
    await ctx.deleteMessage();
    deleted = true;
  } catch (deleteError) {
    logger.warn("[Sessions] Could not delete empty session menu; removing its keyboard instead:", deleteError);
  }
  if (deleted) {
    try {
      await ctx.reply(t("sessions.empty"));
    } catch (replyError) {
      logger.error("[Sessions] Could not send the empty-session prompt:", replyError);
    }
    return;
  }
  try {
    await ctx.editMessageText(t("sessions.empty"), { reply_markup: { inline_keyboard: [] } });
  } catch (editError) {
    logger.error("[Sessions] Could not close empty session menu:", editError);
    try {
      await ctx.reply(t("sessions.empty"));
    } catch (replyError) {
      logger.error("[Sessions] Could not send the empty-session prompt:", replyError);
    }
  }
}

async function refreshSessionMenu(ctx, deps, project) {
  const page = await loadSessionPage(project.worktree, 0, config.bot.sessionsListLimit);
  if (page.sessions.length === 0) {
    await closeEmptySessionMenu(ctx, deps);
    return;
  }
  const view = buildSessionSelectionMenuView(page, config.bot.sessionsListLimit);
  await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
}

export async function handleSafeSessionDelete(ctx, deps) {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(PREFIX) && !data.startsWith(CONFIRM) && !data.startsWith(CANCEL)) return false;
  if (!(await ensureActiveInlineMenu(ctx, "session", deps))) return true;
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
    await ctx.answerCallbackQuery({ text: "Deletion cancelled." });
    await refreshSessionMenu(ctx, deps, project);
    return true;
  }
  try {
    const { data: target, error: getError } = await opencodeClient.session.get({ sessionID, directory: project.worktree });
    if (getError || !target || target.directory !== project.worktree) throw getError || new Error("Session not found in selected project.");
    const current = getCurrentSession();
    const { error } = await opencodeClient.session.delete({ sessionID, directory: project.worktree });
    if (error) throw error;
    if (current?.id === sessionID) clearSession();
    await ctx.answerCallbackQuery({ text: "Session deleted." });
    await refreshSessionMenu(ctx, deps, project);
  } catch (error) { logger.error("[Sessions] Safe deletion failed:", error); await ctx.answerCallbackQuery({ text: "Could not delete session. It may already be gone.", show_alert: true }).catch(() => {}); }
  return true;
}
`;
await writeFile(deleteHelperPath, deleteHelper, { mode: 0o644 });

const sessionHandler = await patch(
  path.join(packageRoot, "bot/callbacks/session-callback-handler.js"),
  (source) => {
    if (!source.includes("handleSafeSessionDelete")) {
      const firstLineEnd = source.indexOf("\n");
      if (firstLineEnd < 0) throw new Error("Session callback module header changed.");
      source = source.slice(0, firstLineEnd + 1) + 'import { handleSafeSessionDelete } from "./safe-session-delete.js";\n' + source.slice(firstLineEnd + 1);
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

// Generic context-overflow recovery (all providers, all models, all sessions).
// OpenCode 2.2.5 only auto-compacts when the provider error message matches a fixed
// regex list; NVIDIA answers HTTP 400 with {"message":"Invalid request","details":
// {"type":"context_length","limit":...,"actual":...}}, which matches none of them,
// so the session used to die permanently. This helper recognizes the overflow shape
// (details.type/details.limit+actual, or overflow phrasing in the message), compacts
// the session via session.summarize (session.compact) and resends the last user
// prompt exactly once. The resend rides the normal SSE flow, so the answer streams
// back into Telegram as usual.
const recoveryHelperPath = path.join(packageRoot, "app/services/overflow-recovery-service.js");
const recoveryHelper = `import { opencodeClient } from "../../opencode/client.js";
import { getStoredModel } from "./model-selection-service.js";
import { getStoredAgent, resolveProjectAgent } from "./agent-selection-service.js";
import { logger } from "../../utils/logger.js";

const OVERFLOW_PATTERNS = [
    /context[_ -]?length/,
    /context window/,
    /maximum context/,
    /max (?:model )?context/,
    /prompt is too long/,
    /input is too long/,
    /too (?:large|long) for (?:the )?(?:model|request)/,
    /exceeds? (?:the )?(?:model'?s )?(?:maximum |max )?(?:context|token|input)/,
    /tokens? (?:in request )?(?:more than|exceed)/,
    /reduce the length/,
    /invalid request[^}]{0,160}(context|token|length|limit)/,
    /(context|token|length|limit)[^}]{0,160}invalid request/,
];
const recoveredAt = new Map();
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;

export function isContextOverflowError(error) {
    if (!error) return false;
    const details = error.details ?? error.error?.details ?? error.data?.details ?? error.body?.details ?? error.response?.details;
    const dtype = String(details?.type ?? "").toLowerCase();
    if (dtype.includes("context") || dtype.includes("length")) return true;
    if (typeof details?.limit === "number" && typeof details?.actual === "number" && details.actual > details.limit) return true;
    const message = String(error.message ?? error.error?.message ?? error.msg ?? error).toLowerCase();
    return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

export async function recoverSessionFromOverflow(sessionID) {
    if (!sessionID) return false;
    const now = Date.now();
    if (now - (recoveredAt.get(sessionID) ?? 0) < RECOVERY_WINDOW_MS) return false;
    recoveredAt.set(sessionID, now);
    try {
        const { data: session, error: getError } = await opencodeClient.session.get({ sessionID });
        if (getError || !session) throw getError || new Error("session not found");
        logger.warn("[OverflowRecovery] context overflow on session " + sessionID + "; compacting");
        const { error: compactError } = await opencodeClient.session.summarize({ sessionID });
        if (compactError) throw compactError;
        const { data: messages, error: messagesError } = await opencodeClient.session.messages({ sessionID, limit: 100 });
        if (messagesError) throw messagesError;
        const list = Array.isArray(messages) ? messages : (messages?.data ?? []);
        let lastUserText = null;
        for (let i = list.length - 1; i >= 0; i--) {
            const info = list[i]?.info ?? list[i];
            if (info?.role !== "user") continue;
            const texts = (list[i]?.parts ?? [])
                .filter((part) => part?.type === "text" && typeof part?.text === "string" && part.text.trim())
                .map((part) => part.text);
            if (texts.length) {
                lastUserText = texts.join("\\n\\n");
                break;
            }
        }
        if (!lastUserText) {
            logger.warn("[OverflowRecovery] no user text to resend for session " + sessionID);
            return true;
        }
        const model = getStoredModel();
        const agent = await resolveProjectAgent(getStoredAgent()).catch(() => getStoredAgent());
        const prompt = {
            sessionID,
            ...(session.directory ? { directory: session.directory } : {}),
            parts: [{ type: "text", text: lastUserText }],
            ...(agent ? { agent } : {}),
            ...(model?.providerID && model?.modelID
                ? { model: { providerID: model.providerID, modelID: model.modelID }, ...(model.variant ? { variant: model.variant } : {}) }
                : {}),
        };
        const { error: promptError } = await opencodeClient.session.promptAsync(prompt);
        if (promptError) throw promptError;
        logger.warn("[OverflowRecovery] resent the last user prompt to session " + sessionID + " after compaction");
        return true;
    }
    catch (err) {
        logger.error("[OverflowRecovery] recovery failed for session " + sessionID + ":", err);
        return false;
    }
}
`;
await writeFile(recoveryHelperPath, recoveryHelper, { mode: 0o644 });

const aggregator = await patch(
  path.join(packageRoot, "app/managers/summary-aggregation-manager.js"),
  (source) => {
    const importAnchor = 'import { getCurrentProject } from "../stores/settings-store.js";';
    const importReplacement = importAnchor +
      '\nimport { isContextOverflowError, recoverSessionFromOverflow } from "../services/overflow-recovery-service.js";';
    if (!source.includes(importAnchor)) throw new Error("Upstream aggregator import anchor changed.");
    if (!source.includes("overflow-recovery-service.js")) {
      source = source.replace(importAnchor, importReplacement);
    }
    const errorAnchor = "logger.warn(`[Aggregator] Session error: ${sessionID}: ${message}`);";
    const errorReplacement = errorAnchor + `
        if (isContextOverflowError(error)) {
            logger.warn(\`[Aggregator] Context overflow on session \${sessionID}; compacting and retrying the last prompt once\`);
            void recoverSessionFromOverflow(sessionID);
        }`;
    if (source.includes(errorReplacement)) return source;
    if (!source.includes(errorAnchor)) throw new Error("Upstream session-error anchor changed.");
    return source.replace(errorAnchor, errorReplacement);
  },
  "summary aggregation manager",
);

// Say plainly when a model has no reasoning variants instead of a bare "empty menu".
const variantMenu = await patch(
  path.join(packageRoot, "bot/menus/variant-selection-menu.js"),
  (source) => {
    const anchor = 'await ctx.reply(t("variant.menu.empty"));';
    const replacement = 'await ctx.reply(`${t("variant.menu.empty")} — ${currentModel.providerID}/${currentModel.modelID} has no reasoning variants.`);';
    if (source.includes(replacement)) return source;
    if (!source.includes(anchor)) throw new Error("Variant menu empty-state anchor changed.");
    return source.replace(anchor, replacement);
  },
  "variant selection menu",
);

process.stdout.write(
  "Provider removal, provider-menu refresh, truthful Favorites list, " +
    "context-overflow recovery, and clear no-variants notice: " +
    (router || definitions || callback || modelSelection || sessionMenu || sessionHandler || aggregator || variantMenu
      ? "installed.\n"
      : "already installed.\n"),
);
