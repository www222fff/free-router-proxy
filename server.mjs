#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProviderRegistry,
  isChatModel,
  isZeroCost,
  normalizeModelSlug,
} from './providers.mjs';
import { installUpstreamProxy } from './proxy.mjs';
import { createSecretRedactor } from './redact.mjs';
import { createUsageStore, resolveSince } from './usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || process.env[match[1]]) continue;
    process.env[match[1]] = value;
  }
}

const envCandidates = [
  path.join(HERE, '.env'),
  path.join(os.homedir(), '.hermes', '.env'),
];
for (const file of envCandidates) {
  if (file) loadEnvFile(file);
}

const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || path.join(HERE, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
installUpstreamProxy(
  (message) => {
    console.log(`[${new Date().toISOString()}]`, message);
  },
  { socksFirstHosts: config.socksFirstHosts || [] },
);
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
const PORT = Number(process.env.FREE_ROUTER_PORT || config.port || 8787);
const ATTEMPT_TIMEOUT_MS = Number(
  process.env.FREE_ROUTER_ATTEMPT_TIMEOUT_MS || config.attemptTimeoutMs || 180000,
);
const CATALOG_REFRESH_MS = Number(config.catalogRefreshMs || 900000);
const registry = createProviderRegistry(config, { host: HOST, port: PORT });
const PROVIDERS = registry.providers;
const discoveryConfig = config.discovery || {};
const DISCOVERY_ENABLED = discoveryConfig.enabled !== false;
const DISCOVERY_INTERVAL_MS = Number(discoveryConfig.intervalMs || 7 * 24 * 60 * 60 * 1000);
const DISCOVERY_ROUTE = String(discoveryConfig.route || 'free-best');
const DISCOVERY_STATE_PATH = path.resolve(
  path.dirname(CONFIG_PATH),
  discoveryConfig.stateFile || 'discovered-free-models.json',
);
const evaluationConfig = discoveryConfig.evaluation || {};
const EVALUATION_ENABLED = evaluationConfig.enabled !== false;
const EVALUATION_MAX_TOKENS = Number(evaluationConfig.maxTokens || 4000);
const PINNED_MODELS = new Set(evaluationConfig.pinnedModels || []);
const secretRedactor = config.redactSecrets === false ? null : createSecretRedactor();

// SQLite usage log: one row per successful routed request.
// Off (null) only if config.usage.enabled === false or SQLite is unavailable.
const usageConfig = config.usage || {};
const USAGE_DB_PATH =
  process.env.FREE_ROUTER_USAGE_DB ||
  path.resolve(path.dirname(CONFIG_PATH), usageConfig.dbFile || 'usage.db');
let usageStore = null;
try {
  usageStore = createUsageStore(USAGE_DB_PATH, {
    enabled: usageConfig.enabled !== false,
  });
} catch (error) {
  console.error(`[${new Date().toISOString()}] usage log disabled: ${error.message}`);
}
function recordUsage({ route, provider, model, usage, streaming }) {
  try {
    usageStore?.record({ route, provider, model, usage, streaming });
  } catch (error) {
    log(`usage log write failed: ${error.message}`);
  }
}

const cooldowns = new Map();
let discoveredModelIds = [];
let discoverySeenIds = [];
let discoveryRemovedIds = [];
let discoveryLastCheckedAt = 0;
let discoveryError = '';
let discoveryInFlight = null;
let modelEvaluations = {};
let lastSelection = null;

function log(message, detail = undefined) {
  const prefix = `[${new Date().toISOString()}]`;
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

function normalizeCandidate(entry) {
  if (typeof entry === 'string') return { provider: registry.defaultProvider, model: entry };
  if (entry && typeof entry === 'object') {
    return {
      provider: String(entry.provider || registry.defaultProvider),
      model: String(entry.model || entry.id || ''),
    };
  }
  return { provider: registry.defaultProvider, model: '' };
}

function candidateKey(candidate) {
  return `${candidate.provider}:${candidate.model}`;
}

function keySlug(key) {
  const separator = String(key).indexOf(':');
  return normalizeModelSlug(separator >= 0 ? key.slice(separator + 1) : key);
}

function candidateMetadata(candidate) {
  return registry.metadata(candidate);
}

function candidateIsFree(candidate) {
  return registry.isFree(candidate);
}

function discoveredCandidate(id) {
  return registry.parsePrefixed(id) || { provider: registry.discoveryProvider, model: id };
}

function loadDiscoveryState() {
  if (!DISCOVERY_ENABLED || !fs.existsSync(DISCOVERY_STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(DISCOVERY_STATE_PATH, 'utf8'));
    discoveredModelIds = Array.isArray(state.addedModels)
      ? state.addedModels.filter((id) => typeof id === 'string')
      : [];
    discoverySeenIds = Array.isArray(state.freeModels)
      ? state.freeModels.filter((id) => typeof id === 'string')
      : [];
    discoveryRemovedIds = Array.isArray(state.removedModels)
      ? state.removedModels.filter((id) => typeof id === 'string')
      : [];
    discoveryLastCheckedAt = Date.parse(state.lastCheckedAt || '') || 0;
    modelEvaluations =
      state.evaluations && typeof state.evaluations === 'object' ? state.evaluations : {};
    if (state.lastSelection && typeof state.lastSelection === 'object') {
      lastSelection = state.lastSelection;
    }
  } catch (error) {
    discoveryError = `state load failed: ${error instanceof Error ? error.message : String(error)}`;
    log(discoveryError);
  }
}

function saveDiscoveryState() {
  const payload = {
    lastCheckedAt: new Date(discoveryLastCheckedAt).toISOString(),
    route: DISCOVERY_ROUTE,
    freeModels: discoverySeenIds,
    addedModels: discoveredModelIds,
    removedModels: discoveryRemovedIds,
    evaluations: modelEvaluations,
    lastSelection,
  };
  const temporaryPath = `${DISCOVERY_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, DISCOVERY_STATE_PATH);
}

function rememberSelection(selection) {
  lastSelection = selection;
  try {
    saveDiscoveryState();
  } catch (error) {
    log(`failed to persist lastSelection: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function configuredScore(id, configuredIndex) {
  const separator = id.indexOf(':');
  const modelId = separator >= 0 ? id.slice(separator + 1) : id;
  const explicit = Number(
    evaluationConfig.baselineScores?.[id] ??
      evaluationConfig.baselineScores?.[modelId],
  );
  if (Number.isFinite(explicit)) return explicit;
  return Math.max(30, 94 - Math.max(0, configuredIndex - 1) * 4);
}

function rankedModelScore(key, configured, configuredIndex) {
  const slug = keySlug(key);
  const modelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  if (PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId)) return Number.POSITIVE_INFINITY;
  if (configured.has(key)) return configuredScore(key, configuredIndex.get(key));
  for (const [configuredKey, index] of configuredIndex) {
    if (keySlug(configuredKey) === slug) return configuredScore(configuredKey, index);
  }
  const evaluated = Number(modelEvaluations[modelId]?.score);
  return Number.isFinite(evaluated) ? evaluated : -1;
}

function scoreSourceFor(key, configured) {
  if (configured.has(key)) return 'baseline';
  const slug = keySlug(key);
  for (const configuredKey of configured) {
    if (keySlug(configuredKey) === slug) return 'baseline';
  }
  return 'evaluation';
}

function groupRank(group, configuredSet, configuredIndex) {
  let pinned = false;
  let pinIndex = Number.POSITIVE_INFINITY;
  let configuredIdx = Number.POSITIVE_INFINITY;
  let configuredKey = '';
  let evalScore = -1;
  for (const { candidate, originalIndex } of group.members) {
    const key = candidateKey(candidate);
    if (PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model)) {
      pinned = true;
      pinIndex = Math.min(pinIndex, originalIndex);
    }
    if (configuredSet.has(key) && configuredIndex.get(key) < configuredIdx) {
      configuredIdx = configuredIndex.get(key);
      configuredKey = key;
    }
    const evaluated = Number(modelEvaluations[candidate.model]?.score);
    if (Number.isFinite(evaluated)) evalScore = Math.max(evalScore, evaluated);
  }
  for (const [key, index] of configuredIndex) {
    if (keySlug(key) !== group.slug || index >= configuredIdx) continue;
    configuredIdx = index;
    configuredKey = key;
  }
  const score = pinned
    ? Number.POSITIVE_INFINITY
    : configuredIdx !== Number.POSITIVE_INFINITY
      ? configuredScore(configuredKey, configuredIdx)
      : evalScore;
  return { pinned, score, tie: pinned ? pinIndex : group.firstIndex };
}

function orderByModelThenProvider(candidates, configuredSet, configuredIndex) {
  const groups = new Map();
  candidates.forEach((candidate, originalIndex) => {
    const slug = normalizeModelSlug(candidate.model) || candidateKey(candidate);
    let group = groups.get(slug);
    if (!group) {
      group = { slug, members: [], firstIndex: originalIndex };
      groups.set(slug, group);
    }
    group.members.push({ candidate, originalIndex });
  });
  const ranked = [...groups.values()].sort((left, right) => {
    const a = groupRank(left, configuredSet, configuredIndex);
    const b = groupRank(right, configuredSet, configuredIndex);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return a.tie - b.tie;
    return b.score - a.score || a.tie - b.tie;
  });
  const expanded = [];
  const present = new Set();
  const emit = (candidate) => {
    const key = candidateKey(candidate);
    if (present.has(key)) return;
    present.add(key);
    expanded.push(candidate);
  };
  for (const group of ranked) {
    for (const { candidate } of group.members.sort((a, b) => a.originalIndex - b.originalIndex)) {
      emit(candidate);
    }
    for (const offering of registry.offeringsForSlug(group.slug)) emit(offering);
  }
  return expanded;
}

function routeCandidates(routeName) {
  const configured = config.routes?.[routeName];
  if (!configured) return null;
  const normalizedConfigured = configured.map(normalizeCandidate).filter((candidate) => candidate.model);
  const activeConfigured = normalizedConfigured.filter(candidateIsFree);
  const configuredKeys = normalizedConfigured.map(candidateKey);
  const configuredSet = new Set(configuredKeys);
  const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
  if (!DISCOVERY_ENABLED || routeName !== DISCOVERY_ROUTE) {
    return orderByModelThenProvider(activeConfigured, configuredSet, configuredIndex);
  }

  const candidates = [...activeConfigured];
  const present = new Set(candidates.map(candidateKey));
  for (const id of discoveredModelIds) {
    const candidate = discoveredCandidate(id);
    if (present.has(candidateKey(candidate))) continue;
    const model = candidateMetadata(candidate);
    const provider = PROVIDERS.get(candidate.provider);
    if (provider?.usesCatalog && provider.catalog.size && (!model || !isZeroCost(model))) continue;
    candidates.push(candidate);
    present.add(candidateKey(candidate));
  }
  return orderByModelThenProvider(candidates, configuredSet, configuredIndex);
}

async function refreshCatalog(force = false) {
  await registry.refreshCatalogs(force, CATALOG_REFRESH_MS, log);
}

function evaluationText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('');
}

function parseEvaluationAnswers(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function metadataScore(model) {
  const supported = new Set(model?.supported_parameters || []);
  const contextLength = Number(model?.context_length || 0);
  const createdMs = Number(model?.created || 0) * 1000;
  let score = 0;
  if (supported.has('tools')) score += 6;
  if (supported.has('response_format') || supported.has('structured_outputs')) score += 4;
  score += Math.min(6, Math.max(0, Math.log2(Math.max(4096, contextLength) / 4096)));
  if ((model?.architecture?.input_modalities || ['text']).includes('text')) score += 2;
  if (createdMs && Date.now() - createdMs <= 180 * 24 * 60 * 60 * 1000) score += 2;
  return Math.round(score * 10) / 10;
}

async function evaluateModel(modelId) {
  const startedAt = Date.now();
  const candidate = { provider: registry.discoveryProvider, model: modelId };
  const model = candidateMetadata(candidate);
  const supported = new Set(model?.supported_parameters || []);
  const evaluationBody = {
    messages: [
      {
        role: 'user',
        content:
          'Return ONLY one JSON object with keys token, crt, trace, path, sequence, binary. ' +
          'No markdown and no explanation. token must be "OX-RANK-7". ' +
          'crt: smallest positive integer n where n%7=3, n%11=5, n%13=9. ' +
          'trace: output of JavaScript: let a=[1,2,3,4]; for(let i=0;i<a.length;i++){if(a[i]%2===0)a.splice(i,1)} console.log(a.join("-")). ' +
          'path: shortest distance A to E for undirected edges A-B:4,A-C:2,C-B:1,B-D:5,C-D:8,C-E:10,D-E:2. ' +
          'sequence: next number after 2,6,12,20,30. ' +
          'binary: number of binary strings of length 8 with no consecutive ones.',
      },
    ],
    temperature: 0,
    max_tokens: EVALUATION_MAX_TOKENS,
  };
  if (supported.has('reasoning') || supported.has('reasoning_effort')) {
    evaluationBody.reasoning = { effort: 'low' };
  }
  const result = await attemptJson(candidate, evaluationBody);
  const latencyMs = Date.now() - startedAt;
  if (!result.ok) {
    return {
      status: 'pending',
      attemptedAt: new Date().toISOString(),
      latencyMs,
      error: `${result.status} ${result.reason}`.slice(0, 300),
    };
  }

  const answers = parseEvaluationAnswers(evaluationText(result.payload));
  let benchmarkScore = 0;
  if (answers) benchmarkScore += 5;
  if (answers?.token === 'OX-RANK-7') benchmarkScore += 5;
  if (Number(answers?.crt) === 269) benchmarkScore += 15;
  if (String(answers?.trace) === '1-3') benchmarkScore += 10;
  if (Number(answers?.path) === 10) benchmarkScore += 10;
  if (Number(answers?.sequence) === 42) benchmarkScore += 10;
  if (Number(answers?.binary) === 55) benchmarkScore += 10;

  const modelMetadataScore = metadataScore(candidateMetadata(candidate));
  const latencyScore = latencyMs <= 5000 ? 15 : latencyMs <= 15000 ? 10 : latencyMs <= 30000 ? 5 : 0;
  const score = Math.round((benchmarkScore + modelMetadataScore + latencyScore) * 10) / 10;
  return {
    status: 'scored',
    evaluatedAt: new Date().toISOString(),
    score,
    benchmarkScore,
    metadataScore: modelMetadataScore,
    latencyScore,
    latencyMs,
  };
}

async function performFreeModelDiscovery(forceCatalogRefresh = false) {
  if (!DISCOVERY_ENABLED) return;
  if (
    discoveryLastCheckedAt &&
    Date.now() - discoveryLastCheckedAt < DISCOVERY_INTERVAL_MS
  ) {
    return;
  }

  try {
    if (forceCatalogRefresh || !registry.discoveryCatalog()?.catalog.size) {
      await refreshCatalog(true);
    }
    const catalogProvider = registry.discoveryCatalog();
    const catalog = catalogProvider?.catalog || new Map();
    if (!catalog.size || catalogProvider?.catalogError) {
      throw new Error(catalogProvider?.catalogError || 'catalog is empty');
    }

    const configured = config.routes?.[DISCOVERY_ROUTE];
    if (!Array.isArray(configured)) {
      throw new Error(`discovery route does not exist: ${DISCOVERY_ROUTE}`);
    }
    const configuredCatalogIds = configured
      .map(normalizeCandidate)
      .filter((candidate) => candidate.provider === registry.discoveryProvider)
      .map((candidate) => candidate.model);

    const freeIds = [...catalog.values()]
      .filter((model) => isZeroCost(model) && isChatModel(model))
      .map((model) => model.id)
      .filter((id) => typeof id === 'string' && id)
      .sort();
    const eligible = new Set(freeIds);
    const allRouted = [...new Set([...configuredCatalogIds, ...discoveredModelIds])];
    discoveryRemovedIds = allRouted.filter((id) => !eligible.has(id));
    const removedDiscovered = discoveredModelIds.filter((id) => !eligible.has(id));
    if (removedDiscovered.length) {
      discoveredModelIds = discoveredModelIds.filter((id) => eligible.has(id));
    }
    if (discoveryRemovedIds.length) {
      log(
        `removed ${discoveryRemovedIds.length} non-free or unavailable model(s) from active routes`,
        discoveryRemovedIds,
      );
    }
    const routed = new Set([...configuredCatalogIds, ...discoveredModelIds]);
    const knownSlugs = new Set(
      [
        ...configured.map(normalizeCandidate).map((candidate) => normalizeModelSlug(candidate.model)),
        ...discoveredModelIds.map((id) => normalizeModelSlug(id)),
      ].filter(Boolean),
    );
    const additions = freeIds.filter(
      (id) => !routed.has(id) && !knownSlugs.has(normalizeModelSlug(id)),
    );
    if (additions.length) {
      discoveredModelIds.push(...additions);
      log(`discovered ${additions.length} free model(s); evaluating for ${DISCOVERY_ROUTE}`, additions);
    } else {
      log(`free-model discovery complete: no additions for ${DISCOVERY_ROUTE}`);
    }

    if (EVALUATION_ENABLED && additions.length) {
      for (const id of additions) {
        log(`evaluating newly discovered model ${id}`);
        modelEvaluations[id] = await evaluateModel(id);
        if (modelEvaluations[id].status === 'scored') {
          log(`evaluated ${id}: score ${modelEvaluations[id].score}`);
        } else {
          log(`evaluation deferred for ${id}: ${modelEvaluations[id].error}`);
        }
        saveDiscoveryState();
      }
    }

    discoverySeenIds = freeIds;
    discoveryLastCheckedAt = Date.now();
    discoveryError = '';
    saveDiscoveryState();
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
    log(`free-model discovery failed: ${discoveryError}`);
  }
}

function discoverFreeModels(forceCatalogRefresh = false) {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = performFreeModelDiscovery(forceCatalogRefresh).finally(() => {
    discoveryInFlight = null;
  });
  return discoveryInFlight;
}

function scheduleNextDiscovery() {
  if (!DISCOVERY_ENABLED) return;
  const elapsed = discoveryLastCheckedAt ? Date.now() - discoveryLastCheckedAt : 0;
  const delay = discoveryLastCheckedAt
    ? Math.max(1000, DISCOVERY_INTERVAL_MS - elapsed)
    : Math.min(DISCOVERY_INTERVAL_MS, 60 * 60 * 1000);
  const timer = setTimeout(async () => {
    await discoverFreeModels(true);
    scheduleNextDiscovery();
  }, delay);
  timer.unref();
}

loadDiscoveryState();

function requestNeeds(body) {
  const modalities = new Set();
  let hasImages = false;
  let hasVideo = false;
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') hasImages = true;
      if (part?.type === 'video_url' || part?.type === 'input_video') hasVideo = true;
    }
  }
  if (hasImages) modalities.add('image');
  if (hasVideo) modalities.add('video');
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    responseFormat: Boolean(body.response_format),
    modalities,
  };
}

function supportsRequest(model, needs) {
  if (!model) return true;
  const supported = new Set(model.supported_parameters || []);
  if (needs.tools && !supported.has('tools')) return false;
  if (
    needs.responseFormat &&
    !supported.has('response_format') &&
    !supported.has('structured_outputs')
  ) {
    return false;
  }
  const inputs = new Set(model?.architecture?.input_modalities || ['text']);
  for (const modality of needs.modalities) {
    if (!inputs.has(modality)) return false;
  }
  return true;
}

function cooldownRemaining(candidate) {
  const key = candidateKey(candidate);
  const entry = cooldowns.get(key);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(key);
    return 0;
  }
  return remaining;
}

function setCooldown(candidate, kind, reason) {
  const durations = config.cooldownMs || {};
  const duration = Number(durations[kind] || 0);
  if (!duration) return;
  cooldowns.set(candidateKey(candidate), {
    until: Date.now() + duration,
    kind,
    reason: String(reason || '').slice(0, 300),
  });
}

function candidateModels(requestedModel, body) {
  const configured = routeCandidates(requestedModel);
  return filterCandidates(configured || registry.directCandidates(requestedModel), body, requestedModel);
}

function filterCandidates(configured, body, requestedModel) {
  const needs = requestNeeds(body);
  const active = [];
  const skipped = [];
  for (const candidate of configured) {
    const model = candidateMetadata(candidate);
    if (!candidateIsFree(candidate)) {
      skipped.push({ model: candidateKey(candidate), reason: 'not currently zero-cost or missing key' });
      continue;
    }
    if (!supportsRequest(model, needs)) {
      skipped.push({ model: candidateKey(candidate), reason: 'missing requested capability' });
      continue;
    }
    const remaining = cooldownRemaining(candidate);
    if (remaining > 0) {
      skipped.push({
        model: candidateKey(candidate),
        reason: `cooldown ${Math.ceil(remaining / 1000)}s`,
      });
      continue;
    }
    active.push(candidate);
  }

  // If every compatible model is cooling down, retry them in order instead of
  // turning a temporary cooldown into a hard outage.
  if (!active.length) {
    for (const candidate of configured) {
      if (
        candidateIsFree(candidate) &&
        supportsRequest(candidateMetadata(candidate), needs)
      ) {
        active.push(candidate);
      }
    }
  }

  if (skipped.length) log(`${requestedModel}: skipped ${skipped.length} candidate(s)`, skipped);
  return active;
}

function sanitizeUpstreamBody(body, modelId) {
  const upstream = JSON.parse(
    JSON.stringify({
      ...body,
      model: modelId,
    }),
  );
  delete upstream.models;
  delete upstream.route;
  if (!secretRedactor) return upstream;
  const { value, count } = secretRedactor.redact(upstream);
  if (count) log(`redacted ${count} secret occurrence(s) before upstream`);
  return value;
}

function usefulMessage(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!message) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
  if (typeof message.content === 'string' && message.content.trim()) return true;
  if (Array.isArray(message.content) && message.content.length) {
    return message.content.some((part) => {
      if (typeof part === 'string') return part.trim();
      return typeof part?.text === 'string' && part.text.trim();
    });
  }
  return false;
}

function usefulDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) return false;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return true;
  if (typeof delta.content === 'string' && delta.content.length) return true;
  if (Array.isArray(delta.content) && delta.content.length) return true;
  return false;
}

function classifyFailure(status, message, timedOut = false) {
  if (timedOut) return 'timeout';
  if (status === 429) return 'rateLimit';
  if (status === 404) return 'notFound';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'serverError';
  if (/empty|reasoning only|no useful/i.test(message)) return 'empty';
  return '';
}

function errorSummary(status, raw) {
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed?.error?.metadata?.raw ||
      parsed?.error?.message ||
      parsed?.message ||
      `HTTP ${status}`
    );
  } catch {
    return raw.trim().slice(0, 500) || `HTTP ${status}`;
  }
}

async function fetchModel(candidate, body, clientSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('attempt timeout')), ATTEMPT_TIMEOUT_MS);
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  clientSignal?.addEventListener('abort', abortFromClient, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', abortFromClient);
  };
  try {
    const provider = PROVIDERS.get(candidate.provider);
    if (!provider?.baseUrl || !provider.apiKey) {
      throw new Error(`provider ${candidate.provider} is not configured`);
    }
    const response = await fetch(registry.chatUrl(candidate.provider), {
      method: 'POST',
      headers: registry.headers(candidate.provider),
      body: JSON.stringify(sanitizeUpstreamBody(body, candidate.model)),
      signal: controller.signal,
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function attemptJson(candidate, body, clientSignal) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: false },
      clientSignal,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    cleanup();
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  cleanup();
  if (!response.ok) {
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
    };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, reason: 'invalid JSON response', kind: 'serverError' };
  }
  if (!usefulMessage(payload)) {
    const finish = payload?.choices?.[0]?.finish_reason || 'unknown';
    return {
      ok: false,
      status: 502,
      reason: `no useful content or tool call (finish_reason=${finish})`,
      kind: 'empty',
    };
  }
  return {
    ok: true,
    payload,
    contentType: response.headers.get('content-type') || 'application/json',
  };
}

async function attemptStream(candidate, body, res, clientSignal) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: true },
      clientSignal,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }

  if (!response.ok) {
    let raw;
    try {
      raw = await response.text();
    } finally {
      cleanup();
    }
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
    };
  }
  if (!response.body) {
    cleanup();
    return { ok: false, status: 502, reason: 'empty response body', kind: 'empty' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks = [];
  let parserBuffer = '';
  let committed = false;
  let finishReason = '';
  let streamUsage = null;

  const scanUsage = (payload) => {
    if (payload?.usage && typeof payload.usage === 'object') streamUsage = payload.usage;
  };

  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch (error) {
      cleanup();
      if (committed) {
        res.end();
        return { ok: true, candidate, interrupted: true, usage: streamUsage };
      }
      return { ok: false, status: 502, reason: String(error), kind: 'serverError' };
    }
    if (read.done) break;
    const bytes = Buffer.from(read.value);
    if (committed) {
      res.write(bytes);
      parserBuffer += decoder.decode(read.value, { stream: true });
      const tail = parserBuffer.split('\n');
      parserBuffer = tail.pop() || '';
      for (const line of tail) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          scanUsage(JSON.parse(data));
        } catch {
          // Ignore keepalives and malformed provider-specific event lines.
        }
      }
      continue;
    }

    bufferedChunks.push(bytes);
    parserBuffer += decoder.decode(read.value, { stream: true });
    const lines = parserBuffer.split('\n');
    parserBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        scanUsage(payload);
        const finish = payload?.choices?.[0]?.finish_reason;
        if (finish) finishReason = finish;
        if (usefulDelta(payload)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
          for (const chunk of bufferedChunks) res.write(chunk);
          bufferedChunks.length = 0;
          committed = true;
          log(`selected ${candidateKey(candidate)} (stream)`);
          break;
        }
      } catch {
        // Ignore keepalives and malformed provider-specific event lines.
      }
    }
  }

  if (committed) {
    cleanup();
    res.end();
    return { ok: true, candidate, usage: streamUsage };
  }
  cleanup();
  return {
    ok: false,
    status: 502,
    reason: `reasoning only or empty stream (finish_reason=${finishReason || 'unknown'})`,
    kind: 'empty',
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function routeStatus() {
  const now = Date.now();
  const routes = {};
  for (const name of Object.keys(config.routes || {})) {
    const candidates = routeCandidates(name) || [];
    const configured = (config.routes[name] || []).map(normalizeCandidate);
    const configuredKeys = configured.map(candidateKey);
    const configuredSet = new Set(configuredKeys);
    const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
    routes[name] = candidates.map((candidate, priority) => {
      const key = candidateKey(candidate);
      const model = candidateMetadata(candidate);
      const cooldown = cooldowns.get(key);
      const pinned = PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model);
      return {
        priority: priority + 1,
        provider: candidate.provider,
        id: candidate.model,
        pinned,
        score: pinned
          ? null
          : rankedModelScore(key, configuredSet, configuredIndex),
        scoreSource: scoreSourceFor(key, configuredSet),
        zeroCost: PROVIDERS.get(candidate.provider)?.usesCatalog
          ? model
            ? isZeroCost(model)
            : null
          : true,
        supportsTools: model ? (model.supported_parameters || []).includes('tools') : null,
        cooldownSeconds:
          cooldown && cooldown.until > now ? Math.ceil((cooldown.until - now) / 1000) : 0,
        cooldownReason: cooldown?.reason,
      };
    });
  }
  return routes;
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const requestedModel = String(body.model || 'free-best');
  await refreshCatalog();
  const candidates = candidateModels(requestedModel, body);
  if (!candidates.length) {
    return sendJson(res, 503, {
      error: {
        message: `No currently free model supports this request for route ${requestedModel}`,
        type: 'no_compatible_free_model',
      },
    });
  }

  const failures = [];
  const failedProviders = new Set();
  const clientController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientController.abort();
  });

  for (const candidate of candidates) {
    if (clientController.signal.aborted) return;
    if (failedProviders.has(candidate.provider)) continue;
    log(`trying ${candidateKey(candidate)} for ${requestedModel}`);
    const result = body.stream
      ? await attemptStream(candidate, body, res, clientController.signal)
      : await attemptJson(candidate, body, clientController.signal);

    if (result.ok) {
      rememberSelection({
        route: requestedModel,
        provider: candidate.provider,
        model: candidate.model,
        selectedAt: new Date().toISOString(),
      });
      recordUsage({
        route: requestedModel,
        provider: candidate.provider,
        model: candidate.model,
        usage: body.stream ? result.usage : result.payload?.usage,
        streaming: Boolean(body.stream),
      });
      if (!body.stream) {
        log(`selected ${candidateKey(candidate)}`);
        return sendJson(res, 200, result.payload, {
          'X-Free-Router-Model': candidate.model,
          'X-Free-Router-Provider': candidate.provider,
        });
      }
      return;
    }

    failures.push({
      provider: candidate.provider,
      model: candidate.model,
      status: result.status,
      reason: result.reason,
    });
    if (result.kind) setCooldown(candidate, result.kind, result.reason);
    log(`failed ${candidateKey(candidate)}: ${result.status} ${result.reason}`);
    if (result.fatal) failedProviders.add(candidate.provider);
  }

  if (!res.headersSent) {
    sendJson(res, 502, {
      error: {
        message: `All models failed for route ${requestedModel}`,
        type: 'free_router_exhausted',
        failures,
      },
    });
  }
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'free-router',
      defaultProvider: registry.defaultProvider,
      catalogModels: registry.discoveryCatalog()?.catalog.size || 0,
      catalogFetchedAt: registry.discoveryCatalog()?.catalogFetchedAt
        ? new Date(registry.discoveryCatalog().catalogFetchedAt).toISOString()
        : null,
      catalogError: registry.discoveryCatalog()?.catalogError || null,
      providers: registry.health(),
      discovery: {
        enabled: DISCOVERY_ENABLED,
        provider: registry.discoveryProvider,
        route: DISCOVERY_ROUTE,
        intervalMs: DISCOVERY_INTERVAL_MS,
        lastCheckedAt: discoveryLastCheckedAt
          ? new Date(discoveryLastCheckedAt).toISOString()
          : null,
        freeModelsSeen: discoverySeenIds.length,
        addedModels: discoveredModelIds,
        removedModels: discoveryRemovedIds,
        evaluations: modelEvaluations,
        error: discoveryError || null,
      },
      lastSelection,
      routes: routeStatus(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    await refreshCatalog();
    const routeModels = Object.keys(config.routes || {}).map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'free-router',
    }));
    const listed = registry.listListedModels();
    const catalogModels = registry.listCatalogModels(listed.ids).map((model) => ({
      id: model.id,
      object: model.object,
      created: model.created,
      owned_by: model.owned_by,
      context_length: model.context_length,
    }));
    return sendJson(res, 200, {
      object: 'list',
      data: [...routeModels, ...listed.models, ...catalogModels],
    });
  }
  if (req.method === 'GET' && (url.pathname === '/v1/usage' || url.pathname === '/v1/usage/summary')) {
    if (!usageStore) {
      return sendJson(res, 503, {
        error: {
          message: 'Usage log is disabled (config.usage.enabled=false or SQLite unavailable)',
          type: 'usage_log_disabled',
        },
      });
    }
    const filters = {
      since: url.searchParams.get('since') || '',
      provider: url.searchParams.get('provider') || '',
      model: url.searchParams.get('model') || '',
      route: url.searchParams.get('route') || '',
      limit: url.searchParams.get('limit') || '',
      offset: url.searchParams.get('offset') || '',
    };
    if (url.pathname === '/v1/usage/summary') {
      return sendJson(res, 200, usageStore.summary(filters));
    }
    return sendJson(res, 200, usageStore.list(filters));
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }
  return sendJson(res, 404, {
    error: { message: `Unknown endpoint: ${req.method} ${url.pathname}`, type: 'not_found' },
  });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    log('unhandled request error', error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: 'Internal router error', type: 'router_internal_error' },
      });
    } else {
      res.end();
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, async () => {
  log(`Free Router listening on http://${HOST}:${PORT}/v1`);
  for (const provider of PROVIDERS.values()) {
    if (!provider.apiKey) log(`warning: ${provider.keyEnv} is missing`);
  }
  await refreshCatalog(true);
  await discoverFreeModels();
  scheduleNextDiscovery();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}; shutting down`);
    server.close(() => process.exit(0));
  });
}
