// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { isAbsolute } from "node:path";

import type { HostMessageEntry } from "./host-types.js";

const MAX_MESSAGES = 10_000;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;
type SdkMethod = (options?: UnknownRecord) => Promise<unknown>;

interface SessionClient {
  get: SdkMethod;
  messages: SdkMethod;
  status?: SdkMethod;
}

interface ConfigClient {
  get?: SdkMethod;
  providers?: SdkMethod;
}

interface ProviderClient {
  list?: SdkMethod;
}

interface ModelRef {
  providerId: string;
  modelId: string;
}

/** Read-only OpenCode APIs needed to import a session into a handoff bundle. */
export interface HandoffHostReader {
  readonly projectRoot: string;
  /** Returns validated stored history before OpenCode's compaction projection. */
  readAllHistory(sessionId: string): Promise<HostMessageEntry[]>;
  /** Returns the history OpenCode currently projects after compaction filtering. */
  readHistory(sessionId: string): Promise<HostMessageEntry[]>;
  /**
   * Uses OpenCode's authoritative status map when available. Idle sessions are
   * absent from that map. On older hosts without `session.status`, this only
   * proves that one persisted-history snapshot has no pending/running tool,
   * unmatched latest user message, or incomplete latest assistant response;
   * neither path prevents activity beginning after the check.
   */
  assertIdle(sessionId: string): Promise<void>;
  /**
   * Resolves the persisted session/latest-user model, or the configured default,
   * against OpenCode's provider metadata. Returns undefined when the host cannot
   * identify that model or does not expose its limit; API failures and malformed
   * responses still throw.
   */
  getModelContext(sessionId: string): Promise<{
    providerId: string;
    modelId: string;
    contextLimit: number;
  } | undefined>;
  /** Compatibility accessor delegating to getModelContext. */
  getContextLimit(sessionId: string): Promise<number | undefined>;
}

/**
 * Build a strictly read-only reader over the V1 PluginInput SDK client.
 *
 * The V1 methods use `{ path: { id }, query: { directory } }` and return the
 * default Hey API `{ data, error, request, response }` envelope. In particular,
 * `session.messages` is intentionally called without `limit`: the server's
 * no-limit branch walks every page, while any positive limit is a tail page.
 */
export function createHandoffHostReader(input: unknown): HandoffHostReader {
  const pluginInput = requireRecord(input, "PluginInput");
  const projectRoot = selectProjectRoot(pluginInput);
  const client = requireRecord(pluginInput.client, "PluginInput.client");
  const sessionValue = requireRecord(client.session, "PluginInput.client.session");
  const session: SessionClient = {
    get: requireMethod(sessionValue, "get", "client.session.get"),
    messages: requireMethod(sessionValue, "messages", "client.session.messages"),
    status: optionalMethod(sessionValue, "status", "client.session.status"),
  };
  const config = optionalClient(client, "config", ["get", "providers"]) as ConfigClient | undefined;
  const provider = optionalClient(client, "provider", ["list"]) as ProviderClient | undefined;

  async function loadSession(sessionId: string): Promise<UnknownRecord> {
    validateSessionId(sessionId);
    const data = await callSdk("session.get", () => session.get({
      path: { id: sessionId },
      query: { directory: projectRoot },
      throwOnError: true,
    }));
    const info = requireRecord(data, "session.get data");
    if (info.id !== sessionId) {
      throw incompatible(`session.get returned id ${describe(info.id)} for requested session ${JSON.stringify(sessionId)}`);
    }
    return info;
  }

  async function loadRawHistory(sessionId: string): Promise<{ sessionInfo: UnknownRecord; entries: HostMessageEntry[] }> {
    const sessionInfo = await loadSession(sessionId);
    const data = await callSdk("session.messages", () => session.messages({
      path: { id: sessionId },
      query: { directory: projectRoot },
      throwOnError: true,
    }));
    if (!Array.isArray(data)) throw incompatible("session.messages data is not an array");
    if (data.length > MAX_MESSAGES) {
      throw incompatible(`session.messages returned ${data.length} messages; maximum is ${MAX_MESSAGES}`);
    }
    const bytes = jsonByteSize(data, MAX_HISTORY_BYTES);
    if (bytes > MAX_HISTORY_BYTES) {
      throw incompatible(`session.messages returned more than ${MAX_HISTORY_BYTES} bytes of observed JSON data`);
    }
    return { sessionInfo, entries: validateHistory(data, sessionId) };
  }

  async function readHistory(sessionId: string): Promise<HostMessageEntry[]> {
    const { entries } = await loadRawHistory(sessionId);
    return filterCompacted(entries);
  }

  async function readAllHistory(sessionId: string): Promise<HostMessageEntry[]> {
    const { entries } = await loadRawHistory(sessionId);
    return entries;
  }

  async function assertIdle(sessionId: string): Promise<void> {
    await loadSession(sessionId);
    if (session.status) {
      const data = await callSdk("session.status", () => session.status!({
        query: { directory: projectRoot },
        throwOnError: true,
      }));
      const statuses = requireRecord(data, "session.status data");
      const status = statuses[sessionId];
      if (status === undefined) return;
      const statusInfo = requireRecord(status, `session.status entry for ${JSON.stringify(sessionId)}`);
      if (statusInfo.type === "idle") return;
      if (statusInfo.type === "busy" || statusInfo.type === "retry") {
        throw new Error(`handoff host unavailable: session ${JSON.stringify(sessionId)} is ${statusInfo.type}`);
      }
      throw incompatible(`session.status has unknown status type ${describe(statusInfo.type)} for ${JSON.stringify(sessionId)}`);
    }

    const { entries } = await loadRawHistory(sessionId);
    assertPersistedSnapshotIdle(filterCompacted(entries), sessionId);
  }

  async function getModelContext(sessionId: string): Promise<{
    providerId: string;
    modelId: string;
    contextLimit: number;
  } | undefined> {
    const { sessionInfo, entries } = await loadRawHistory(sessionId);
    const model = modelFromSession(sessionInfo) ?? latestUserModel(entries) ?? await configuredModel();
    if (!model) return undefined;

    if (config?.providers) {
      const data = await callSdk("config.providers", () => config.providers!({
        query: { directory: projectRoot },
        throwOnError: true,
      }));
      const body = requireRecord(data, "config.providers data");
      if (!Array.isArray(body.providers)) throw incompatible("config.providers data.providers is not an array");
      const limit = findContextLimit(body.providers, model, "config.providers");
      if (limit !== undefined) return { ...model, contextLimit: limit };
    }

    if (provider?.list) {
      const data = await callSdk("provider.list", () => provider.list!({
        query: { directory: projectRoot },
        throwOnError: true,
      }));
      const body = requireRecord(data, "provider.list data");
      if (!Array.isArray(body.all)) throw incompatible("provider.list data.all is not an array");
      const contextLimit = findContextLimit(body.all, model, "provider.list");
      return contextLimit === undefined ? undefined : { ...model, contextLimit };
    }
    return undefined;
  }

  async function getContextLimit(sessionId: string): Promise<number | undefined> {
    return (await getModelContext(sessionId))?.contextLimit;
  }

  async function configuredModel(): Promise<ModelRef | undefined> {
    if (!config?.get) return undefined;
    const data = await callSdk("config.get", () => config.get!({
      query: { directory: projectRoot },
      throwOnError: true,
    }));
    const body = requireRecord(data, "config.get data");
    if (body.model === undefined) return undefined;
    if (typeof body.model !== "string") throw incompatible("config.get data.model is not a string");
    return parseConfiguredModel(body.model);
  }

  return { projectRoot, readAllHistory, readHistory, assertIdle, getModelContext, getContextLimit };
}

function selectProjectRoot(input: UnknownRecord): string {
  const preferred = typeof input.worktree === "string" && input.worktree.trim() !== ""
    ? input.worktree
    : input.directory;
  if (typeof preferred !== "string" || preferred.trim() === "") {
    throw incompatible("PluginInput.worktree and PluginInput.directory are unavailable");
  }
  if (!isAbsolute(preferred)) throw incompatible(`project root is not absolute: ${JSON.stringify(preferred)}`);
  return preferred;
}

function optionalClient(client: UnknownRecord, key: string, methods: string[]): UnknownRecord | undefined {
  const value = client[key];
  if (value === undefined) return undefined;
  const result = requireRecord(value, `PluginInput.client.${key}`);
  for (const method of methods) optionalMethod(result, method, `client.${key}.${method}`);
  return result;
}

function requireMethod(value: UnknownRecord, key: string, label: string): SdkMethod {
  const method = value[key];
  if (typeof method !== "function") throw unavailable(`${label} is not exposed by this OpenCode client`);
  return method.bind(value) as SdkMethod;
}

function optionalMethod(value: UnknownRecord, key: string, label: string): SdkMethod | undefined {
  const method = value[key];
  if (method === undefined) return undefined;
  if (typeof method !== "function") throw incompatible(`${label} is present but is not a function`);
  return method.bind(value) as SdkMethod;
}

async function callSdk(label: string, invoke: () => Promise<unknown>): Promise<unknown> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error) {
    throw unavailable(`${label} failed: ${errorText(error)}`);
  }
  const envelope = requireRecord(response, `${label} response`);
  if (envelope.error !== undefined) throw unavailable(`${label} failed: ${errorText(envelope.error)}`);
  if (!Object.prototype.hasOwnProperty.call(envelope, "data") || envelope.data === undefined) {
    throw incompatible(`${label} response has no data`);
  }
  return envelope.data;
}

function validateHistory(data: unknown[], sessionId: string): HostMessageEntry[] {
  const messageIds = new Set<string>();
  const partIds = new Set<string>();
  for (let index = 0; index < data.length; index++) {
    const entry = requireRecord(data[index], `session.messages data[${index}]`);
    const info = requireRecord(entry.info, `session.messages data[${index}].info`);
    const id = requireId(info.id, `session.messages data[${index}].info.id`);
    if (messageIds.has(id)) throw incompatible(`session.messages contains duplicate message id ${JSON.stringify(id)}`);
    messageIds.add(id);
    if (info.sessionID !== sessionId) {
      throw incompatible(`message ${JSON.stringify(id)} belongs to session ${describe(info.sessionID)}, not ${JSON.stringify(sessionId)}`);
    }
    if (info.role !== "user" && info.role !== "assistant") {
      throw incompatible(`message ${JSON.stringify(id)} has invalid role ${describe(info.role)}`);
    }
    const time = requireRecord(info.time, `message ${JSON.stringify(id)}.time`);
    requireNonNegativeNumber(time.created, `message ${JSON.stringify(id)}.time.created`);
    if (!Array.isArray(entry.parts)) throw incompatible(`message ${JSON.stringify(id)}.parts is not an array`);
    for (let partIndex = 0; partIndex < entry.parts.length; partIndex++) {
      const part = requireRecord(entry.parts[partIndex], `message ${JSON.stringify(id)}.parts[${partIndex}]`);
      const partId = requireId(part.id, `message ${JSON.stringify(id)}.parts[${partIndex}].id`);
      if (partIds.has(partId)) throw incompatible(`session.messages contains duplicate part id ${JSON.stringify(partId)}`);
      partIds.add(partId);
      if (part.sessionID !== sessionId || part.messageID !== id) {
        throw incompatible(`part ${JSON.stringify(partId)} has inconsistent sessionID or messageID`);
      }
      if (typeof part.type !== "string" || part.type.length === 0) {
        throw incompatible(`part ${JSON.stringify(partId)} has an invalid type`);
      }
      if (part.type === "compaction" && part.tail_start_id !== undefined) {
        requireId(part.tail_start_id, `compaction part ${JSON.stringify(partId)}.tail_start_id`);
      }
    }
  }
  return data as HostMessageEntry[];
}

/** Mirrors MessageV2.filterCompacted over Session.messages' chronological output. */
function filterCompacted(messages: HostMessageEntry[]): HostMessageEntry[] {
  const result: HostMessageEntry[] = [];
  const completed = new Set<string>();
  let retain: string | undefined;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    result.push(message);
    if (retain) {
      if (message.info.id === retain) break;
      continue;
    }
    if (message.info.role === "user" && completed.has(message.info.id)) {
      const part = compactionPart(message);
      if (!part) continue;
      const tail = typeof part.tail_start_id === "string" ? part.tail_start_id : undefined;
      if (!tail) break;
      retain = tail;
      if (message.info.id === retain) break;
      continue;
    }
    if (
      message.info.role === "assistant"
      && message.info.summary === true
      && typeof message.info.finish === "string"
      && message.info.finish.length > 0
      && message.info.error === undefined
    ) {
      completed.add(message.info.parentID);
    }
  }

  result.reverse();
  let compactionIndex = -1;
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index];
    if (message.info.role === "user" && compactionTailPart(message)) {
      compactionIndex = index;
      break;
    }
  }
  const compaction = result[compactionIndex];
  const part = compaction ? compactionTailPart(compaction) : undefined;
  const summaryIndex = compaction
    ? result.findIndex((message, index) => index > compactionIndex
      && message.info.role === "assistant"
      && message.info.summary === true
      && message.info.parentID === compaction.info.id)
    : -1;
  const tailIndex = part
    ? result.findIndex(message => message.info.id === part.tail_start_id)
    : -1;
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ];
  }
  return result;
}

function compactionPart(message: HostMessageEntry): UnknownRecord | undefined {
  return message.parts.find(part => part.type === "compaction") as UnknownRecord | undefined;
}

function compactionTailPart(message: HostMessageEntry): (UnknownRecord & { tail_start_id: string }) | undefined {
  const part = message.parts.find(item => item.type === "compaction" && "tail_start_id" in item);
  return part as unknown as (UnknownRecord & { tail_start_id: string }) | undefined;
}

function assertPersistedSnapshotIdle(entries: HostMessageEntry[], sessionId: string): void {
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.type !== "tool") continue;
      const state = requireRecord(part.state, `tool part ${JSON.stringify(part.id)}.state`);
      if (state.status === "pending" || state.status === "running") {
        throw unavailable(`session ${JSON.stringify(sessionId)} has a ${state.status} tool call`);
      }
    }
  }

  const latest = latestChronological(entries);
  if (!latest) return;
  if (latest.info.role === "user") {
    throw unavailable(`session ${JSON.stringify(sessionId)} ends with a user message and cannot be proven idle`);
  }
  const completed = latest.info.time.completed;
  const settled = (typeof latest.info.finish === "string" && latest.info.finish.length > 0)
    || latest.info.error !== undefined;
  if (!Number.isFinite(completed) || !settled) {
    throw unavailable(`session ${JSON.stringify(sessionId)} has an incomplete latest assistant response`);
  }
}

function latestChronological(entries: HostMessageEntry[]): HostMessageEntry | undefined {
  let latest: HostMessageEntry | undefined;
  for (const entry of entries) {
    if (!latest
      || entry.info.time.created > latest.info.time.created
      || (entry.info.time.created === latest.info.time.created && entry.info.id > latest.info.id)) {
      latest = entry;
    }
  }
  return latest;
}

function modelFromSession(session: UnknownRecord): ModelRef | undefined {
  if (session.model === undefined) return undefined;
  const model = requireRecord(session.model, "session.get data.model");
  const providerId = model.providerID;
  const modelId = model.id ?? model.modelID;
  if (providerId === undefined && modelId === undefined) return undefined;
  return {
    providerId: requireId(providerId, "session.get data.model.providerID"),
    modelId: requireId(modelId, "session.get data.model.id"),
  };
}

function latestUserModel(entries: HostMessageEntry[]): ModelRef | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const info = entries[index].info;
    if (info.role !== "user") continue;
    return { providerId: info.model.providerID, modelId: info.model.modelID };
  }
  return undefined;
}

function parseConfiguredModel(value: string): ModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function findContextLimit(providers: unknown[], model: ModelRef, source: string): number | undefined {
  const matches = providers.filter((value) => isRecord(value) && value.id === model.providerId);
  if (matches.length > 1) throw incompatible(`${source} returned duplicate provider id ${JSON.stringify(model.providerId)}`);
  if (matches.length === 0) return undefined;
  const provider = requireRecord(matches[0], `${source} provider ${JSON.stringify(model.providerId)}`);
  const models = requireRecord(provider.models, `${source} provider ${JSON.stringify(model.providerId)}.models`);
  let candidate = models[model.modelId];
  if (candidate === undefined) {
    const byId = Object.values(models).filter(value => isRecord(value) && value.id === model.modelId);
    if (byId.length > 1) throw incompatible(`${source} returned duplicate model id ${JSON.stringify(model.modelId)}`);
    candidate = byId[0];
  }
  if (candidate === undefined) return undefined;
  const modelInfo = requireRecord(candidate, `${source} model ${JSON.stringify(model.modelId)}`);
  if (modelInfo.limit === undefined) return undefined;
  const limit = requireRecord(modelInfo.limit, `${source} model ${JSON.stringify(model.modelId)}.limit`).context;
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0) return undefined;
  return limit as number;
}

function jsonByteSize(value: unknown, stopAfter: number): number {
  const ancestors = new Set<object>();
  const objectCache = new WeakMap<object, number>();
  const stringCache = new Map<string, number>();

  const size = (item: unknown, arrayElement = false): number => {
    if (item === null) return 4;
    if (typeof item === "string") {
      const cached = stringCache.get(item);
      if (cached !== undefined) return cached;
      const measured = jsonStringByteSize(item);
      stringCache.set(item, measured);
      return measured;
    }
    if (typeof item === "boolean") return item ? 4 : 5;
    if (typeof item === "number") return Number.isFinite(item) ? String(item).length : 4;
    if (typeof item === "undefined" && arrayElement) return 4;
    if (typeof item !== "object") throw incompatible(`session.messages contains non-JSON ${typeof item} data`);

    const object = item as object;
    if (ancestors.has(object)) throw incompatible("session.messages contains cyclic data");
    const cached = objectCache.get(object);
    if (cached !== undefined) return cached;
    ancestors.add(object);
    let total = 2;
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (index > 0) total++;
        total += size(item[index], true);
        if (total > stopAfter) break;
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw incompatible("session.messages contains non-plain object data");
      }
      let written = 0;
      for (const key of Object.keys(item)) {
        const child = (item as UnknownRecord)[key];
        if (child === undefined || typeof child === "function" || typeof child === "symbol") {
          continue;
        }
        if (written++ > 0) total++;
        total += jsonStringByteSize(key) + 1 + size(child);
        if (total > stopAfter) break;
      }
    }
    ancestors.delete(object);
    objectCache.set(object, total);
    return total;
  };

  return size(value);
}

function jsonStringByteSize(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes++;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function validateSessionId(value: string): void {
  requireId(value, "session id");
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw incompatible(`${label} is not a non-empty string`);
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw incompatible(`${label} is not a finite non-negative number`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw incompatible(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    if (isRecord(error.data) && typeof error.data.message === "string") return error.data.message;
  }
  try {
    const text = JSON.stringify(error);
    return text === undefined ? String(error) : text.slice(0, 500);
  } catch {
    return String(error);
  }
}

function describe(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function unavailable(message: string): Error {
  return new Error(`handoff host unavailable: ${message}`);
}

function incompatible(message: string): Error {
  return new Error(`handoff host incompatible: ${message}`);
}
