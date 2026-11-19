/**
 * Cache-stable message freeze — the compression invariant that makes prompt caching work.
 *
 * A provider prompt cache keys on an EXACT byte prefix. So a compressor is only cache-friendly
 * if the bytes it emits for a message are decided exactly ONCE: on the turn that message first
 * arrives. Every later turn must replay those same bytes. Engines break this on their own — a
 * budget recomputed from a longer history, an LLM-backed summarizer, or a setting changed
 * mid-conversation re-decides an already-sent turn, and the provider re-bills the whole prefix
 * as cache *creation* instead of a cache *read*.
 *
 * This layer replays the first transformation verbatim: messages are content-addressed, so a
 * message that comes back byte-identical in a later turn receives the exact compressed bytes it
 * was given when it first arrived, whichever engine produced them.
 *
 * Fail-open by construction: when the request and result item lists are not positionally
 * aligned (an engine that drops or merges messages), nothing is replayed or stored and the
 * result passes through untouched. Bounded LRU, in-memory only. The scope (mode + config +
 * model + principal + wire format) keeps an entry from crossing engine settings, models or
 * tenants — provider caches are per model/account too.
 */
import type { CompressionConfig, CompressionResult } from "./types.ts";
import { estimateCompressionTokens } from "./stats.ts";
import { jsonSha256 } from "../../utils/jsonHash.ts";

/** Upper bound on frozen messages (oldest evicted first); bounds memory against long sessions. */
export const MAX_FROZEN_MESSAGES = 10_000;

/** Everything that changes what an engine emits for the same message. */
export interface MessageFreezeScope {
  mode: string;
  config?: CompressionConfig;
  model?: string;
  supportsVision?: boolean | null;
  principalId?: string;
  targetFormat?: string;
  compressionStage?: string;
  // Transport-sensitive engines (omniglyph) are a no-op off their transport: a body frozen
  // for a direct provider must never be replayed onto an aggregator (or vice versa).
  providerTransport?: string;
  imageTransportFidelity?: string;
}

const frozen = new Map<string, string>();
let replayCount = 0;
let storeCount = 0;

const SEQUENCE_FIELDS = ["messages", "input"] as const;
// Fields that must survive an in-place rewrite unchanged. A mismatch means the engine reordered
// or synthesized items, so positional pairing is not trustworthy and the request fails open.
const IDENTITY_FIELDS = ["role", "type", "tool_call_id", "call_id", "tool_use_id", "name"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value: unknown): string | null {
  try {
    return jsonSha256(value);
  } catch {
    return null;
  }
}

function identityKey(item: unknown): string | null {
  if (!isRecord(item)) return null;
  return IDENTITY_FIELDS.map((field) => {
    const value = item[field];
    return value === undefined || value === null ? "" : String(value);
  }).join("\u0000");
}

function scopeFingerprint(scope: MessageFreezeScope): string | null {
  return digest({
    mode: scope.mode,
    config: scope.config ?? null,
    model: scope.model ?? null,
    supportsVision: scope.supportsVision ?? null,
    principal: scope.principalId ?? null,
    targetFormat: scope.targetFormat ?? null,
    compressionStage: scope.compressionStage ?? null,
    providerTransport: scope.providerTransport ?? null,
    imageTransportFidelity: scope.imageTransportFidelity ?? null,
  });
}

function remember(key: string, item: unknown): void {
  let bytes: string;
  try {
    bytes = JSON.stringify(item);
  } catch {
    return;
  }
  if (bytes === undefined) return;
  if (!frozen.has(key) && frozen.size >= MAX_FROZEN_MESSAGES) {
    const oldest = frozen.keys().next().value;
    if (oldest !== undefined) frozen.delete(oldest);
  }
  frozen.set(key, bytes);
  storeCount++;
}

/**
 * Replays the frozen bytes of every already-seen message and records the bytes of every new one.
 * Returns `result` unchanged when nothing could be replayed.
 */
export function applyMessageFreeze(
  body: Record<string, unknown>,
  result: CompressionResult,
  scope: MessageFreezeScope
): CompressionResult {
  if (!result.stats || !isRecord(result.body)) return result;
  const field = SEQUENCE_FIELDS.find(
    (candidate) => Array.isArray(body?.[candidate]) && Array.isArray(result.body[candidate])
  );
  if (!field) return result;
  const original = body[field] as unknown[];
  const transformed = result.body[field] as unknown[];
  if (original.length === 0 || original.length !== transformed.length) return result;

  const prefix = scopeFingerprint(scope);
  if (prefix === null) return result;

  const keys: string[] = [];
  for (let index = 0; index < original.length; index++) {
    const identity = identityKey(original[index]);
    const messageDigest = digest(original[index]);
    if (identity === null || messageDigest === null) return result;
    if (identity !== identityKey(transformed[index])) return result;
    keys.push(`${prefix}:${messageDigest}`);
  }

  let changed = false;
  const next = new Array<unknown>(transformed.length);
  for (let index = 0; index < transformed.length; index++) {
    const key = keys[index];
    const bytes = frozen.get(key);
    let current: string | undefined;
    try {
      current = JSON.stringify(transformed[index]);
    } catch {
      current = undefined;
    }
    if (bytes !== undefined) {
      let revived: unknown;
      try {
        revived = JSON.parse(bytes);
      } catch {
        revived = undefined;
      }
      if (revived !== undefined) {
        next[index] = revived;
        if (bytes === current) continue;
        changed = true;
        replayCount++;
        // Refresh LRU position so an active conversation is never evicted mid-flight.
        frozen.delete(key);
        frozen.set(key, bytes);
        continue;
      }
    }
    next[index] = transformed[index];
    if (!frozen.has(key)) remember(key, transformed[index]);
  }
  // A replay that reproduces the exact bytes already in the pipeline changes nothing.
  if (!changed) return result;

  const frozenBody: Record<string, unknown> = { ...result.body, [field]: next };
  const compressedTokens = estimateCompressionTokens(frozenBody);
  const originalTokens = result.stats.originalTokens;
  const stats = {
    ...result.stats,
    compressedTokens,
    savingsPercent:
      originalTokens > 0
        ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 10000) / 100
        : 0,
    techniquesUsed: [...new Set([...(result.stats.techniquesUsed ?? []), "message-freeze-replay"])],
  };
  return { ...result, compressed: true, body: frozenBody, stats };
}

/** For tests / diagnostics — clears the in-process store. */
export function resetMessageFreeze(): void {
  frozen.clear();
  replayCount = 0;
  storeCount = 0;
}

export function getMessageFreezeStats(): { size: number; replayed: number; stored: number } {
  return { size: frozen.size, replayed: replayCount, stored: storeCount };
}
