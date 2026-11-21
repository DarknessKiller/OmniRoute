/**
 * Claude Code API constraints.
 *
 * Enforces Anthropic API requirements that real Claude Code handles:
 * 1. Sampling params under extended thinking: temperature=1 and top_p>=0.95
 *    (or unset) when thinking is enabled/adaptive
 * 2. Disable thinking when tool_choice forces a specific tool
 * 3. Enforce max 4 cache_control breakpoints
 * 4. Normalize cache_control TTL ordering
 * 5. Keep a Claude Code subagent on Anthropic's 5-minute cache-write tier by
 *    stripping its cache_control.ttl (1h costs 2x per written token)
 */

import { getHeader } from "../utils/headers.ts";

/**
 * Anthropic's extended-thinking contract rejects non-default sampling params:
 * with thinking enabled/adaptive, `temperature` may only be 1 and `top_p` must
 * be >= 0.95 (or unset) — otherwise the Messages API returns HTTP 400
 * ("`temperature` may only be set to 1 ..." / "`top_p` must be greater than or
 * equal to 0.95 ..."). Clients such as the VS Code Copilot "Ollama" provider
 * routinely send other values (e.g. temperature 0.7, top_p 0.9), and thinking
 * can be injected by per-model requestDefaults *after* the request is built, so
 * normalize here: pin temperature to 1 and drop top_p (Anthropic's "unset"
 * branch — which also preserves the "never send both temperature and top_p"
 * invariant).
 */
export function enforceThinkingTemperature(body: Record<string, unknown>): void {
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (thinking?.type === "enabled" || thinking?.type === "adaptive") {
    // #18636: normalize only a sampling attempt the body actually carries. Pinning
    // unconditionally re-adds `temperature` after an operator param filter or
    // built-in strip rule removed it, and temperature-retired models then 400
    // ("temperature is deprecated"); a body with neither sampling param must stay
    // on Anthropic's "unset" branch. A lone top_p is still converted to the
    // pinned branch (established behavior, see claude-code-parity tests).
    if (body.temperature !== undefined || body.top_p !== undefined) {
      body.temperature = 1;
      if (body.top_p !== undefined) {
        delete body.top_p;
      }
    }
  }
}

/** Applies the final Anthropic wire-body invariants before serialization. */
export function finalizeClaudeBodyConstraints(body: Record<string, unknown>): void {
  hoistLeadingSystemMessages(body);
  relocateDirectiveOnlyMessages(body);
  enforceThinkingTemperature(body);
}

function isSystemRole(role: unknown): boolean {
  return (
    typeof role === "string" &&
    (role.toLowerCase() === "system" || role.toLowerCase() === "developer")
  );
}

function hasOutputConfig(message: Record<string, unknown>): boolean {
  return (
    message.output_config != null &&
    typeof message.output_config === "object" &&
    !Array.isArray(message.output_config)
  );
}

function isEmptySystemMessage(message: unknown): message is Record<string, unknown> {
  if (message == null || typeof message !== "object") return false;
  const candidate = message as Record<string, unknown>;
  return (
    isSystemRole(candidate.role) &&
    Array.isArray(candidate.content) &&
    candidate.content.length === 0
  );
}

function isDirectiveOnlyMessage(message: unknown): boolean {
  return isEmptySystemMessage(message) && hasOutputConfig(message);
}

/**
 * Moves a directive-only system message (empty content array + message-level
 * `output_config`) off `messages[0]`, which Anthropic reserves for the initial
 * system-prompt position. Legitimate directives already later in the conversation
 * stay untouched.
 */
export function relocateDirectiveOnlyMessages(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return;
  const messages = payload.messages as Array<Record<string, unknown>>;
  if (!isEmptySystemMessage(messages[0])) return;

  let runEnd = 0;
  while (runEnd < messages.length && isEmptySystemMessage(messages[runEnd])) runEnd++;
  const directives = messages.slice(0, runEnd).filter(isDirectiveOnlyMessage);

  let insertAfter = -1;
  for (let i = runEnd; i < messages.length; i++) {
    const candidate = messages[i];
    if (candidate != null && typeof candidate === "object" && !isSystemRole(candidate.role)) {
      insertAfter = i;
      break;
    }
  }

  if (insertAfter === -1) {
    if (payload.output_config == null && directives.length > 0) {
      payload.output_config = directives[0].output_config;
    }
    payload.messages = messages.slice(runEnd);
    return;
  }

  payload.messages = [
    ...messages.slice(runEnd, insertAfter + 1),
    ...directives,
    ...messages.slice(insertAfter + 1),
  ];
}

/** Extracts non-empty text blocks from string or array message content. */
function textBlocksFromContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block == null || typeof block !== "object") continue;
    const contentBlock = block as Record<string, unknown>;
    if (
      contentBlock.type === "text" &&
      typeof contentBlock.text === "string" &&
      contentBlock.text.length > 0
    ) {
      blocks.push({ ...contentBlock });
    }
  }
  return blocks;
}

/** Merges hoisted blocks into the existing top-level system value. */
function mergeSystemBlocks(
  existing: unknown,
  extra: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (typeof existing === "string" && existing.length > 0) {
    return [{ type: "text", text: existing }, ...extra];
  }
  if (Array.isArray(existing)) {
    return [...(existing as Array<Record<string, unknown>>), ...extra];
  }
  return extra;
}

/**
 * Hoists only the initial system/developer run into Anthropic's top-level `system` field.
 * Directive-only entries remain in `messages` for the positional relocation pass, and
 * mid-conversation system entries remain untouched for the context-1m beta path.
 */
export function hoistLeadingSystemMessages(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return;
  const messages = payload.messages as Array<Record<string, unknown>>;

  let runEnd = 0;
  while (runEnd < messages.length && isSystemRole(messages[runEnd]?.role)) runEnd++;
  if (runEnd === 0) return;

  const extraBlocks: Array<Record<string, unknown>> = [];
  const directives: Array<Record<string, unknown>> = [];
  for (const message of messages.slice(0, runEnd)) {
    if (isDirectiveOnlyMessage(message)) {
      directives.push(message);
      continue;
    }
    extraBlocks.push(...textBlocksFromContent(message.content));
    if (payload.output_config == null && hasOutputConfig(message)) {
      payload.output_config = message.output_config;
    }
  }

  if (extraBlocks.length > 0) {
    payload.system = mergeSystemBlocks(payload.system, extraBlocks);
  }
  payload.messages = [...directives, ...messages.slice(runEnd)];
}

export function disableThinkingIfToolChoiceForced(body: Record<string, unknown>): void {
  const toolChoice = body.tool_choice as Record<string, unknown> | string | undefined;
  if (!toolChoice) return;

  const isForced =
    toolChoice === "any" ||
    (typeof toolChoice === "object" && (toolChoice.type === "any" || toolChoice.type === "tool"));

  if (isForced && body.thinking) {
    delete body.thinking;
    delete body.context_management;
  }
}

const MAX_CACHE_CONTROL_BLOCKS = 4;

export function enforceCacheControlLimit(body: Record<string, unknown>): void {
  let count = 0;

  // Count in system blocks
  const system = body.system as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block.cache_control) count++;
    }
  }

  // Count in messages
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.cache_control) count++;
      }
    }
  }

  // Count in tools
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.cache_control) count++;
    }
  }

  if (count <= MAX_CACHE_CONTROL_BLOCKS) return;

  // Strip excess cache_control blocks from the end (keep first 4)
  let remaining = MAX_CACHE_CONTROL_BLOCKS;

  if (Array.isArray(system)) {
    for (const block of system) {
      if (block.cache_control) {
        if (remaining > 0) {
          remaining--;
        } else {
          delete block.cache_control;
        }
      }
    }
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.cache_control) {
          if (remaining > 0) {
            remaining--;
          } else {
            delete block.cache_control;
          }
        }
      }
    }
  }

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.cache_control) {
        if (remaining > 0) {
          remaining--;
        } else {
          delete tool.cache_control;
        }
      }
    }
  }
}

function cacheBreakpointCandidates(
  body: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
  countTools: boolean
): Array<Record<string, unknown>> {
  const blocks: unknown[] = [];
  if (Array.isArray(body.system)) blocks.push(...body.system);
  if (countTools && Array.isArray(body.tools)) blocks.push(...body.tools);
  for (const message of messages) {
    if (Array.isArray(message.content)) blocks.push(...message.content);
  }
  return blocks as Array<Record<string, unknown>>;
}

/**
 * `countTools` is for dispatches that send tool markers upstream. The native `claude` dispatch
 * deletes them before sending, so only system and message markers survive there.
 */
export function ensureCacheControlOnLastUserMessage(
  body: Record<string, unknown>,
  { countTools = false }: { countTools?: boolean } = {}
): void {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return;

  const candidates = cacheBreakpointCandidates(body, messages, countTools);
  const cacheControlCount = candidates.filter((block) => block.cache_control).length;

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (String(messages[i].role) === "user") {
      const content = messages[i].content;
      if (Array.isArray(content) && content.length > 0) {
        const lastBlock = content[content.length - 1] as Record<string, unknown>;
        if (!lastBlock.cache_control && cacheControlCount < MAX_CACHE_CONTROL_BLOCKS) {
          lastBlock.cache_control = { type: "ephemeral" };
        }
      }
      break;
    }
  }
}

/** Keeps earlier breakpoints at 1h before a later 1h breakpoint. A marker with no ttl
 * is left bare so Anthropic's own 5m default applies — writing "5m" is redundant, and
 * inventing "1h" silently bills the 2x write rate for a ttl the client never sent. */
export function normalizeCacheControlTtl(body: Record<string, unknown>): void {
  const ephemeralCacheControls: Array<Record<string, unknown>> = [];

  const collectCacheControl = (block: Record<string, unknown> | null | undefined) => {
    const cc = block?.cache_control as Record<string, unknown> | undefined;
    if (!cc || cc.type !== "ephemeral") return;

    if (cc.ttl === "1h") {
      for (const earlier of ephemeralCacheControls) earlier.ttl = "1h";
    }
    ephemeralCacheControls.push(cc);
  };

  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) collectCacheControl(tool);
  }

  const system = body.system as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(system)) {
    for (const block of system) collectCacheControl(block);
  }

  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) collectCacheControl(block);
      }
    }
  }
}

/** Every `ephemeral` cache_control in a Messages body, in prompt order. */
function cacheControlObjects(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const visit = (block: unknown) => {
    const cc = (block as Record<string, unknown> | null | undefined)?.cache_control as
      Record<string, unknown> | undefined;
    if (cc?.type === "ephemeral") found.push(cc);
  };
  if (Array.isArray(body.tools)) for (const tool of body.tools) visit(tool);
  if (Array.isArray(body.system)) for (const block of body.system) visit(block);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages as Array<Record<string, unknown>>) {
      if (Array.isArray(message?.content)) for (const block of message.content) visit(block);
    }
  }
  return found;
}

/** Drops every TTL so Anthropic bills its 5-minute default, not the 2x 1h pool. */
export function stripCacheControlTtl(body: Record<string, unknown>): void {
  for (const cc of cacheControlObjects(body)) delete cc.ttl;
}

/** Anthropic's 1h cache beta: how a caller opts even a subagent into the 1h pool. */
export const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

/**
 * A Claude Code subagent. The CLI marks one with an agent-id header, points
 * metadata.user_id at the parent session, or writes cc_is_subagent=true into the
 * billing line in system[0] — so call this before that line is rewritten.
 */
export function isClaudeSubagentRequest(headers: unknown, body: Record<string, unknown>): boolean {
  if (getHeader(headers, "x-claude-code-agent-id")) return true;
  if (getHeader(headers, "x-claude-code-parent-agent-id")) return true;

  const rawUserId = (body.metadata as Record<string, unknown> | undefined)?.user_id;
  if (typeof rawUserId === "string" && rawUserId.includes('"parent_session_id"')) return true;
  if (rawUserId && typeof rawUserId === "object") {
    const parentSession = (rawUserId as Record<string, unknown>).parent_session_id;
    if (typeof parentSession === "string" && parentSession) return true;
  }

  const system = body.system;
  const systemText =
    typeof system === "string"
      ? system
      : Array.isArray(system) && typeof (system[0] as Record<string, unknown>)?.text === "string"
        ? String((system[0] as Record<string, unknown>).text)
        : "";
  return systemText.includes("cc_is_subagent=true");
}

/**
 * A subagent keeps 1h only when the caller negotiated the extended-cache-ttl beta.
 * A `ttl:"1h"` already in the payload is not an opt-in: chatCore's passthrough rescue
 * writes 1h markers itself, so the body cannot tell the caller's ask from our own.
 */
export function claudeSubagentRequests1h(headers: unknown): boolean {
  return String(getHeader(headers, "anthropic-beta") ?? "").includes(EXTENDED_CACHE_TTL_BETA);
}
