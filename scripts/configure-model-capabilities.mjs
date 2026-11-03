#!/usr/bin/env node
// L1: pre-start capability fix for every provider and model in opencode.json.
//
// For each configured model, resolve its models.dev catalog entry and merge in:
//   - capabilities.reasoning (supported/toggle/effort) so OpenCode builds the
//     correct protocol-specific reasoning variants for ANY provider, and
//   - a safe limit (real context minus a reserve, output capped) so OpenCode never
//     requests the provider's whole context window for output and never trips the
//     "Invalid request"/context_length HTTP 400 on long (e.g. Persian) sessions.
//
// Idempotent, atomic 0600 write, never prints or rewrites provider secrets.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SNAPSHOT,
  applyModelPatch,
  fetchCatalog,
  loadCatalog,
  planConfig,
  saveSnapshot,
  trimCatalog,
} from "./model-catalog.mjs";

function usage() {
  return [
    "Usage: node scripts/configure-model-capabilities.mjs [options]",
    "",
    "Options:",
    "  --config <path>         OpenCode config file (default: OPENCODE_CONFIG_FILE or XDG path)",
    "  --snapshot <path>       models.dev snapshot override (default: data/models-dev.snapshot.json.gz)",
    "  --catalog <path>        load a plain (uncompressed) models.dev api.json instead of the snapshot",
    "  --no-fetch              never hit the network; fail if the snapshot/catalog file is missing",
    "  --refresh-snapshot      download models.dev api.json and write the snapshot, then exit",
    "                          (with --from <path>, read a local api.json instead of fetching)",
    "  --from <path>           local api.json source for --refresh-snapshot",
    "  --dry-run               print the planned changes without writing the config",
    "  --check                 exit 1 when changes are pending (CI gate); writes nothing",
    "  --help                  show this help",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseArgs(argv) {
  const options = { dryRun: false, check: false, refreshSnapshot: false, from: null, catalog: null, snapshot: DEFAULT_SNAPSHOT, config: null, noFetch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help": options.help = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--check": options.check = true; break;
      case "--no-fetch": options.noFetch = true; break;
      case "--refresh-snapshot": options.refreshSnapshot = true; break;
      case "--config": options.config = requireValue(argv, ++i, arg); break;
      case "--snapshot": options.snapshot = requireValue(argv, ++i, arg); break;
      case "--catalog": options.catalog = requireValue(argv, ++i, arg); break;
      case "--from": options.from = requireValue(argv, ++i, arg); break;
      default: throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function configFile(explicit) {
  if (explicit) return path.resolve(explicit);
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set.");
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return process.env.OPENCODE_CONFIG_FILE || path.join(configHome, "opencode", "opencode.json");
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

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  if (options.refreshSnapshot) {
    const catalog = options.from
      ? trimCatalog(await readJsonFile(options.from))
      : await fetchCatalog();
    await saveSnapshot(catalog, options.snapshot);
    const providers = Object.keys(catalog).length;
    const models = Object.values(catalog).reduce((sum, p) => sum + Object.keys(p.models ?? {}).length, 0);
    process.stdout.write(`models.dev snapshot written to ${options.snapshot} (${providers} providers, ${models} models).\n`);
    return 0;
  }

  const file = configFile(options.config);
  const config = await readConfig(file);
  if (!Object.keys(config.provider ?? {}).length) {
    process.stdout.write("No providers configured; nothing to do.\n");
    return 0;
  }

  let catalog;
  if (options.catalog) {
    // trimCatalog is idempotent, so both raw api.json and an already-trimmed file work.
    catalog = trimCatalog(await readJsonFile(options.catalog));
  } else {
    catalog = await loadCatalog({ snapshot: options.snapshot, allowFetch: !options.noFetch });
  }

  const { changes, missed } = planConfig(config, catalog);
  const applied = [];
  for (const change of changes) {
    const modelCfg = config.provider[change.providerID]?.models?.[change.modelID];
    if (!modelCfg) continue;
    if (applyModelPatch(modelCfg, change.patch)) applied.push(change);
  }

  // Report provider/model ids and numeric limits only — never config values such as keys.
  for (const change of applied) {
    const parts = [];
    if (change.patch.capabilities) {
      const reasoning = change.patch.capabilities.reasoning;
      parts.push(`capabilities.reasoning(supported=${reasoning.supported}${reasoning.effort ? `,effort=${reasoning.effort.length}` : ""}${reasoning.toggle ? ",toggle" : ""})`);
    }
    if (change.patch.limit) parts.push(`limit(context=${change.patch.limit.context},output=${change.patch.limit.output})`);
    process.stdout.write(`  ${change.providerID}/${change.modelID}: +${parts.join(" +")} [models.dev ${change.catalogID}, match=${change.match}]\n`);
  }
  if (missed.length) {
    process.stdout.write(`  ${missed.length} model(s) not found in models.dev (left unchanged): ${missed.map((m) => `${m.providerID}/${m.modelID}`).join(", ")}\n`);
  }

  if (!applied.length) {
    process.stdout.write("Model capabilities already up to date; no changes.\n");
    return 0;
  }
  process.stdout.write(`${applied.length} model entr${applied.length === 1 ? "y" : "ies"} ${options.dryRun || options.check ? "would be" : ""} updated in ${file}.\n`);

  if (options.dryRun) return 0;
  if (options.check) return 1;
  await writeConfig(file, config);
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) process.stderr.write(`Warning: ${file} mode is ${mode.toString(8)}, expected 600.\n`);
  process.stdout.write(`Wrote ${file} (mode 600). Reload the running server to apply: POST /api/location/reload.\n`);
  return 0;
}

process.exitCode = await main();
