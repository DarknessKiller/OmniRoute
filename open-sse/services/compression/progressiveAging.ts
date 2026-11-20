import type { AgingThresholds, Summarizer } from "./types.ts";
import { DEFAULT_AGGRESSIVE_CONFIG } from "./types.ts";
import { applyLiteCompression } from "./lite.ts";
import { cavemanCompress } from "./caveman.ts";
import { extractTextContent, replaceTextContent, type ChatMessageLike } from "./messageContent.ts";

const COMPRESSED_MARKER_RE = /^\[COMPRESSED:/;
const JSON_PREFIX_RE = /^\s*[{[]/;
const FENCE_RE = /^\s*```/;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Structured content that an inline `[COMPRESSED:...]` prefix would corrupt:
 * a pure-JSON payload (parses as JSON) or a fenced code block (B-AGG-JSONTAG).
 */
type StructuredKind = "json" | "fenced" | null;

function structuredKind(text: string): StructuredKind {
  const trimmed = text.trim();
  if (FENCE_RE.test(trimmed) && trimmed.endsWith("```")) return "fenced";
  if (JSON_PREFIX_RE.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return null;
    }
  }
  return null;
}

/** Aging tiers are irreversible: changing a message's tier rewrites bytes already sent. */
type AgingTier = "verbatim" | "light" | "moderate" | "fullSummary";

const MAX_FROZEN_SESSIONS = 256;
const MAX_FROZEN_MESSAGES = 2000;

/**
 * Tier freeze keyed by conversation + thresholds. Without it a message's tier follows its
 * distance from the end of the conversation, so every later turn rewrites history the
 * provider already cached and the cache read collapses to the system prompt.
 * `verbatim` is never frozen: freezing the fresh tail would stop aging entirely.
 */
const frozenAgingTiers = new Map<string, Map<string, AgingTier>>();

function evictOldest(map: Map<string, unknown>, cap: number): void {
  while (map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function freezeAgingTier(key: string, digest: string, tier: AgingTier): AgingTier {
  let bucket = frozenAgingTiers.get(key);
  if (!bucket) {
    evictOldest(frozenAgingTiers, MAX_FROZEN_SESSIONS);
    bucket = new Map();
    frozenAgingTiers.set(key, bucket);
  }
  const frozen = bucket.get(digest);
  if (frozen) return frozen;
  evictOldest(bucket, MAX_FROZEN_MESSAGES);
  bucket.set(digest, tier);
  return tier;
}

export function resetAgingTierFreeze(): void {
  frozenAgingTiers.clear();
}

function tierForDistance(distanceFromEnd: number, t: AgingThresholds): AgingTier {
  if (distanceFromEnd <= t.verbatim) return "verbatim";
  if (distanceFromEnd <= t.light) return "light";
  if (distanceFromEnd <= t.moderate) return "moderate";
  return "fullSummary";
}

function resolveAgingTier(
  freezeKey: string | undefined,
  role: string,
  text: string,
  distanceFromEnd: number,
  t: AgingThresholds
): AgingTier {
  const tier = tierForDistance(distanceFromEnd, t);
  if (!freezeKey || tier === "verbatim") return tier;
  return freezeAgingTier(freezeKey, `${role}\u0000${text}`, tier);
}

/**
 * Build the aged content for a message, keeping structured payloads intact:
 * - pure JSON: leave verbatim and untagged (stays JSON.parse-able). Aging engines
 *   (lite/caveman) do not shrink JSON anyway, so nothing is lost; tracked in stats
 *   via the unchanged content. The recursion guard relies on structuredKind() on the
 *   next pass, so re-running aging is a no-op (idempotent).
 * - fenced code block: place the tag on its own line BEFORE the fence so the block
 *   stays valid and the content still starts with `[COMPRESSED:` (recursion guard).
 * - everything else: inline-prepend the tag as before.
 */
function tagAged(tier: string, originalText: string, compressed: string): string {
  const kind = structuredKind(originalText);
  if (kind === "json") {
    return originalText;
  }
  if (kind === "fenced") {
    return `[COMPRESSED:aging:${tier}]\n${originalText}`;
  }
  return `[COMPRESSED:aging:${tier}] ${compressed}`;
}

type ChatMessage = ChatMessageLike;

type CompressedResult = {
  body?: { messages?: Array<{ content?: ChatMessageLike["content"] }> };
};

function setContent(msg: ChatMessage, newContent: string): ChatMessage {
  return replaceTextContent(msg, newContent) as ChatMessage;
}

export function applyAging(
  messages: unknown[],
  thresholds?: AgingThresholds,
  summarizer?: Summarizer,
  preserveSystemPrompt = true,
  spareUserIndex?: number,
  freezeKey?: string
): { messages: unknown[]; saved: number } {
  const t = thresholds ?? DEFAULT_AGGRESSIVE_CONFIG.thresholds;
  const sum = summarizer ?? {
    summarize: (msgs: unknown[]) => {
      const typed = msgs as ChatMessage[];
      const last = typed.filter((m) => m.role === "assistant").pop();
      return last ? extractTextContent(last.content).slice(0, 200) : "";
    },
  };

  const typed = messages as ChatMessage[];
  if (typed.length === 0) return { messages: [], saved: 0 };

  const lastUserIdx =
    spareUserIndex !== undefined ? spareUserIndex : typed.findLastIndex((m) => m.role === "user");

  const totalMessages = typed.length;
  const result: ChatMessage[] = [];
  let saved = 0;

  for (let i = 0; i < typed.length; i++) {
    const msg = typed[i];
    const text = extractTextContent(msg.content);

    if (
      (preserveSystemPrompt && msg.role === "system") ||
      COMPRESSED_MARKER_RE.test(text) ||
      i === lastUserIdx
    ) {
      result.push(msg);
      continue;
    }

    const distanceFromEnd = totalMessages - 1 - i;

    const tier = resolveAgingTier(freezeKey, msg.role, text, distanceFromEnd, t);

    if (tier === "verbatim") {
      result.push(msg);
    } else if (tier === "light") {
      const compressed = applyLiteCompression({ messages: [msg] }) as CompressedResult;
      if (compressed?.body?.messages?.[0]?.content) {
        const newContent =
          typeof compressed.body.messages[0].content === "string"
            ? compressed.body.messages[0].content
            : extractTextContent(compressed.body.messages[0].content);
        const tagged = tagAged("light", text, newContent);
        saved += estimateTokens(text) - estimateTokens(tagged);
        result.push(setContent(msg, tagged));
      } else {
        result.push(msg);
      }
    } else if (tier === "moderate") {
      const compressed = cavemanCompress({
        messages: [msg] as unknown as Parameters<typeof cavemanCompress>[0]["messages"],
      }) as CompressedResult;
      if (compressed?.body?.messages?.[0]?.content) {
        const newContent =
          typeof compressed.body.messages[0].content === "string"
            ? compressed.body.messages[0].content
            : extractTextContent(compressed.body.messages[0].content);
        const tagged = tagAged("moderate", text, newContent);
        saved += estimateTokens(text) - estimateTokens(tagged);
        result.push(setContent(msg, tagged));
      } else {
        result.push(msg);
      }
    } else {
      if (msg.role === "assistant") {
        const summary = sum.summarize([msg]);
        const tagged = tagAged("fullSummary", text, summary);
        saved += estimateTokens(text) - estimateTokens(tagged);
        result.push(setContent(msg, tagged));
      } else if (msg.role === "user") {
        const firstLine = text.split("\n")[0]?.slice(0, 120) ?? "";
        const tagged = tagAged("fullSummary", text, firstLine);
        saved += estimateTokens(text) - estimateTokens(tagged);
        result.push(setContent(msg, tagged));
      } else {
        result.push(msg);
      }
    }
  }

  return { messages: result, saved: Math.max(0, saved) };
}
