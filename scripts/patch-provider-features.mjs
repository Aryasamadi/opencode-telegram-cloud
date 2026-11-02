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

process.stdout.write(
  "Provider removal, provider-menu refresh, and truthful Favorites list: " +
    (router || definitions || callback || modelSelection ? "installed.\\n" : "already installed.\\n"),
);
