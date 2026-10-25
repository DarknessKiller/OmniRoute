// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => {
  const detailLabels: Record<string, string> = {
    systemPromptHidden: "System prompt hidden",
    expand: "Expand",
    collapse: "Collapse",
  };
  return {
    useLocale: () => "en",
    useTranslations: (namespace?: string) => (key: string) =>
      namespace === "requestLogger.detail" ? (detailLabels[key] ?? key) : key,
  };
});

vi.mock("@/store/emailPrivacyStore", () => ({
  default: () => ({ emailsVisible: true }),
}));

vi.mock("@/store/jsonTreeExpandStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useJsonTreeExpandLevel: () => 1,
}));

const { ConversationContextSection } =
  await import("@/shared/components/RequestLoggerDetail.sections");

let container: HTMLElement;
let root: Root;

const clientBody = {
  model: "gpt-x",
  messages: [{ role: "user", content: "hi" }],
};
const providerBody = {
  model: "gpt-x",
  instructions: "You are terse. (globally injected)",
  input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
};

const baseLog = { id: "log-1" };
const detail = (payloads: Record<string, unknown>) => ({
  id: "log-1",
  active: false,
  pipelinePayloads: payloads,
});

const textOf = (el: HTMLElement) => el.textContent ?? "";

async function renderSection(payloads: Record<string, unknown>) {
  await act(async () => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(
      React.createElement(ConversationContextSection, { log: baseLog, detail: detail(payloads) })
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("ConversationContextSection — injected system prompt surface (#PR backport)", () => {
  it("shows the provider-injected system turn when the client sent none", async () => {
    await renderSection({ clientRequest: clientBody, providerRequest: providerBody });
    const html = textOf(container);
    expect(html).toContain("You are terse. (globally injected)");
    expect(html).toContain("hi");
  });

  it("does not duplicate the client's own system turn", async () => {
    const withSystem = {
      ...clientBody,
      messages: [{ role: "system", content: "client system" }, ...clientBody.messages],
    };
    await renderSection({ clientRequest: withSystem, providerRequest: providerBody });
    const html = textOf(container);
    expect(html.indexOf("client system")).toBeGreaterThanOrEqual(0);
    expect((html.match(/client system/g) ?? []).length).toBe(1);
  });

  it("renders unchanged when there is no provider snapshot", async () => {
    await renderSection({ clientRequest: clientBody });
    expect(textOf(container)).toContain("hi");
    expect(textOf(container)).not.toContain("globally injected");
  });
});
