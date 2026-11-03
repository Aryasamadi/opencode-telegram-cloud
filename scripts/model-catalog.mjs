// Shared models.dev catalog helpers.
//
// The OpenCode 2.2.5 variant generator only knows effort/reasoning options for
// models listed in its models.dev catalog under the *same* provider id, and its
// NVIDIA protocol special-cases minimax/glm into a plain thinking toggle. Custom
// providers (or renamed models) therefore lose their reasoning variants and get
// the hardcoded default limit {context: 200000, output: 32000} instead of the
// model's real context window. These helpers resolve any configured
// provider/model against the full models.dev catalog (committed gzip snapshot,
// live fetch fallback) so every provider and model can be fixed generically.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const CATALOG_URL = "https://models.dev/api.json";
export const DEFAULT_SNAPSHOT = fileURLToPath(new URL("../data/models-dev.snapshot.json.gz", import.meta.url));

const MODEL_FIELDS = ["name", "family", "canonical_model_id", "reasoning", "reasoning_options", "limit"];

/** Keep only the fields the capability planner needs; drops descriptions/cost/modalities. */
export function trimCatalog(raw) {
  const out = {};
  for (const [providerID, provider] of Object.entries(raw ?? {})) {
    const models = {};
    for (const [modelID, model] of Object.entries(provider?.models ?? {})) {
      const entry = {};
      for (const field of MODEL_FIELDS) {
        if (model?.[field] !== undefined) entry[field] = model[field];
      }
      if (Object.keys(entry).length > 0) models[modelID] = entry;
    }
    if (Object.keys(models).length > 0) out[providerID] = { models };
  }
  return out;
}

export async function loadSnapshot(file = DEFAULT_SNAPSHOT) {
  const buffer = await readFile(file);
  return JSON.parse(gunzipSync(buffer).toString("utf8"));
}

export async function saveSnapshot(catalog, file = DEFAULT_SNAPSHOT) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, gzipSync(JSON.stringify(catalog), { level: 9 }));
}

export async function fetchCatalog(url = CATALOG_URL, timeoutMs = 30_000) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`models.dev catalog fetch failed with HTTP ${response.status}`);
  return trimCatalog(await response.json());
}

/** Snapshot first (offline-safe), live fetch as fallback unless allowFetch is false. */
export async function loadCatalog({ snapshot = DEFAULT_SNAPSHOT, url = CATALOG_URL, allowFetch = true } = {}) {
  try {
    return await loadSnapshot(snapshot);
  } catch (error) {
    if (!allowFetch) throw new Error(`Could not load catalog snapshot ${snapshot}: ${error.message}`);
    return fetchCatalog(url);
  }
}

/** Normalize a model/provider id for fuzzy matching: lowercase, separators collapsed. */
export function normId(id) {
  return String(id ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Drop a vendor prefix ("minimaxai/minimax-m3.1-flash" -> "minimax-m3.1-flash"). */
export function stripVendor(id) {
  const text = String(id ?? "");
  const slash = text.lastIndexOf("/");
  return slash >= 0 ? text.slice(slash + 1) : text;
}

export function buildIndex(catalog) {
  const byProviderModel = new Map();
  const byModelNorm = new Map();
  const byCanonicalNorm = new Map();
  const byFamilyNorm = new Map();
  const push = (map, key, entry) => {
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  };
  for (const [providerID, provider] of Object.entries(catalog ?? {})) {
    for (const [modelID, raw] of Object.entries(provider?.models ?? {})) {
      const entry = {
        providerID,
        modelID,
        name: raw.name,
        family: raw.family,
        canonical: raw.canonical_model_id,
        reasoning: raw.reasoning,
        reasoningOptions: Array.isArray(raw.reasoning_options) ? raw.reasoning_options : [],
        limit: raw.limit ?? null,
      };
      byProviderModel.set(`${normId(providerID)}/${normId(modelID)}`, entry);
      push(byModelNorm, normId(modelID), entry);
      push(byModelNorm, normId(stripVendor(modelID)), entry);
      if (entry.canonical) {
        push(byCanonicalNorm, normId(entry.canonical), entry);
        push(byCanonicalNorm, normId(stripVendor(entry.canonical)), entry);
      }
      if (entry.family) push(byFamilyNorm, normId(entry.family), entry);
    }
  }
  return { byProviderModel, byModelNorm, byCanonicalNorm, byFamilyNorm };
}

function pick(candidates, providerID) {
  if (!candidates?.length) return null;
  // Prefer an exact provider match, then the upstream owner (the provider whose id
  // matches the head of its own canonical_model_id, e.g. google for gemini models).
  const score = (entry) => {
    let value = 0;
    if (entry.providerID === providerID) value += 2;
    // The canonical id is "<owner>/<model>"; the upstream owner provider wins ties.
    const owner = String(entry.canonical ?? "").split("/")[0];
    if (owner && normId(owner) === normId(entry.providerID)) value += 1;
    return value;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Resolve a configured provider/model to a models.dev entry.
 * Match order: exact provider+model -> same provider with vendor prefix stripped ->
 * model id anywhere in the catalog (preferring the same provider) -> canonical id -> family.
 */
export function findModelEntry(index, providerID, modelID) {
  const direct = index.byProviderModel.get(`${normId(providerID)}/${normId(modelID)}`);
  if (direct) return { ...direct, match: "provider+model" };
  const stripped = stripVendor(modelID);
  const strippedDirect = index.byProviderModel.get(`${normId(providerID)}/${normId(stripped)}`);
  if (strippedDirect) return { ...strippedDirect, match: "provider+stripped-model" };
  const byModel = pick(index.byModelNorm.get(normId(modelID)), providerID)
    ?? pick(index.byModelNorm.get(normId(stripped)), providerID)
    ?? pick(index.byCanonicalNorm.get(normId(modelID)), providerID)
    ?? pick(index.byCanonicalNorm.get(normId(stripped)), providerID);
  if (byModel) return { ...byModel, match: "model-id" };
  const byCanonical = pick(index.byCanonicalNorm.get(normId(modelID)), providerID)
    ?? pick(index.byCanonicalNorm.get(normId(stripped)), providerID);
  if (byCanonical) return { ...byCanonical, match: "canonical" };
  const byFamily = pick(index.byFamilyNorm.get(normId(stripped)), providerID);
  if (byFamily) return { ...byFamily, match: "family" };
  return null;
}

/** models.dev reasoning support: { supported, toggle, effort: string[] }. */
export function reasoningSupport(entry) {
  if (!entry || entry.reasoning === undefined) return null;
  const options = Array.isArray(entry.reasoningOptions) ? entry.reasoningOptions : [];
  const effortOption = options.find((option) => option?.type === "effort" && Array.isArray(option.values));
  const effort = (effortOption?.values ?? []).filter((value) => typeof value === "string" && value.trim());
  const toggle = options.some((option) => option?.type === "toggle");
  return { supported: entry.reasoning === true, toggle, effort };
}

/** Effort variant ids the catalog declares for this model (may be empty).
 *  "none" is excluded: OpenCode already provides the `none` toggle variant and
 *  providers may reject reasoning_effort="none". */
export function expectedEffortIds(entry) {
  return (reasoningSupport(entry)?.effort ?? []).filter((id) => id !== "none");
}

/**
 * Safe limit policy. OpenCode estimates tokens as chars/4, which under-counts
 * Persian/CJK text by ~2x against NVIDIA, and for models whose output limit equals
 * the context limit it requests the whole window for output — any underestimate
 * then becomes an HTTP 400 "Invalid request" that kills the session. Reserving
 * headroom makes the configured limit strictly smaller than the provider's so the
 * request always fits.
 */
export function safeLimits(limit) {
  const context = Number(limit?.context);
  const output = Number(limit?.output);
  if (!Number.isFinite(context) || context <= 0) return null;
  const trueOutput = Number.isFinite(output) && output > 0 ? output : context;
  const reserve = Math.max(8192, Math.ceil(context * 0.15));
  const contextCfg = Math.max(1024, context - reserve);
  const outputCfg = Math.max(1024, Math.min(trueOutput, 32_768, Math.floor(context * 0.12)));
  return { context: contextCfg, output: outputCfg, trueContext: context, trueOutput };
}

/** Config fragment (capabilities + safe limit) derived from a catalog entry. */
export function planModelPatch(entry) {
  if (!entry) return null;
  const patch = {};
  const support = reasoningSupport(entry);
  if (support) {
    if (support.supported) {
      patch.capabilities = {
        reasoning: {
          supported: true,
          ...(support.toggle ? { toggle: true } : {}),
          ...(support.effort.length ? { effort: [...support.effort] } : {}),
        },
      };
    } else {
      patch.capabilities = { reasoning: { supported: false } };
    }
  }
  const limits = safeLimits(entry.limit);
  if (limits) patch.limit = { context: limits.context, output: limits.output };
  return Object.keys(patch).length ? patch : null;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge a planned patch into one model config entry. Returns true when it changed. */
export function applyModelPatch(modelCfg, patch) {
  if (!patch || typeof modelCfg !== "object" || modelCfg === null) return false;
  let changed = false;
  if (patch.capabilities?.reasoning && !deepEqual(modelCfg.capabilities?.reasoning, patch.capabilities.reasoning)) {
    modelCfg.capabilities = { ...(modelCfg.capabilities ?? {}), reasoning: patch.capabilities.reasoning };
    changed = true;
  }
  if (patch.limit && !deepEqual(modelCfg.limit, patch.limit)) {
    modelCfg.limit = { ...patch.limit };
    changed = true;
  }
  return changed;
}

/** Plan capability/limit patches for every model of every provider in an OpenCode config. */
export function planConfig(config, catalog) {
  const index = buildIndex(catalog);
  const changes = [];
  const missed = [];
  for (const [providerID, provider] of Object.entries(config?.provider ?? {})) {
    for (const modelID of Object.keys(provider?.models ?? {})) {
      const entry = findModelEntry(index, providerID, modelID);
      if (!entry) {
        missed.push({ providerID, modelID });
        continue;
      }
      const patch = planModelPatch(entry);
      if (patch) changes.push({ providerID, modelID, patch, catalogID: `${entry.providerID}/${entry.modelID}`, match: entry.match });
    }
  }
  return { changes, missed };
}

/**
 * Compare live /api/model entries with the catalog: effort variants the provider
 * protocol dropped (e.g. NVIDIA minimax/glm) and default limits smaller than the
 * model's real window. Returns per-model patches to merge into the config.
 */
export function planVariantConfig(config, liveModels, catalog) {
  const index = buildIndex(catalog);
  const plans = [];
  for (const live of liveModels ?? []) {
    const providerID = live?.providerID;
    const modelID = live?.id ?? live?.modelID;
    if (!providerID || !modelID) continue;
    const entry = findModelEntry(index, providerID, modelID);
    if (!entry) continue;
    const liveVariantIds = new Set((live.variants ?? []).map((variant) => (typeof variant === "string" ? variant : variant?.id)));
    // Config `variants` fully replaces the protocol-generated variants, so the
    // planner must carry the complete catalog effort set — not just the ids the
    // live server currently lacks — otherwise a reload would drop the rest.
    const efforts = expectedEffortIds(entry);
    const missing = efforts.filter((id) => !liveVariantIds.has(id));
    const limits = safeLimits(entry.limit);
    const liveContext = Number(live?.limit?.context);
    const needsLimit = limits && Number.isFinite(liveContext) && liveContext < limits.context;
    if (!efforts.length && !needsLimit) continue;
    if (!missing.length && !needsLimit) continue;
    const modelCfg = config?.provider?.[providerID]?.models?.[modelID];
    plans.push({
      providerID,
      modelID,
      efforts,
      missing,
      limit: needsLimit ? { context: limits.context, output: limits.output } : null,
      hasConfigEntry: Boolean(modelCfg),
    });
  }
  return plans;
}

/**
 * Merge missing effort variants into a model config entry. Config `variants` must
 * be a V1 object map ({ id: { reasoningEffort: id } }); an array form is rejected by
 * OpenCode's config normalization, so arrays are converted. Returns true on change.
 */
export function applyVariantPatch(modelCfg, missingIds) {
  if (!modelCfg || !missingIds?.length) return false;
  const existing = modelCfg.variants;
  let variants;
  if (Array.isArray(existing)) {
    variants = {};
    for (const item of existing) {
      if (typeof item === "string") variants[item] = {};
      else if (item && typeof item === "object" && item.id) variants[item.id] = { ...item };
      delete variants[item?.id]?.id;
    }
  } else if (existing && typeof existing === "object") {
    variants = { ...existing };
  } else {
    variants = {};
  }
  let changed = Array.isArray(existing);
  for (const id of missingIds) {
    if (!variants[id] || !deepEqual(variants[id], { reasoningEffort: id })) {
      variants[id] = { reasoningEffort: id };
      changed = true;
    }
  }
  if (changed) modelCfg.variants = variants;
  return changed;
}
