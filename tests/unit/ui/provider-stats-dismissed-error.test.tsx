// @vitest-environment jsdom
/**
 * Provider stats: a load error that arrives while the last good snapshot is on screen stays
 * visible until dismissed, stays hidden through later polling, and reopens on the header
 * refresh. The data view never disappears because of a background refresh failure.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en.json";

vi.mock("next-intl", () => {
  // Stable per namespace, like the real hook: the page's polling effect depends on the
  // translator identity, so a fresh function per render would loop.
  const stable = new Map<string, unknown>();
  return {
    useTranslations: (ns: string = "common") => {
      if (!stable.has(ns)) {
        const bag = ((enMessages as Record<string, unknown>)[ns] || {}) as Record<string, string>;
        const translate = (key: string, params?: Record<string, unknown>) => {
          let str = bag[key] ?? key;
          if (params) {
            for (const [pKey, pVal] of Object.entries(params)) {
              str = str.replace(new RegExp(`\\{${pKey}\\}`, "g"), String(pVal));
            }
          }
          return str;
        };
        stable.set(ns, Object.assign(translate, { has: (key: string) => key in bag }));
      }
      return stable.get(ns);
    },
  };
});

vi.mock("@/lib/display/useProviderNodeMap", () => ({
  useProviderNodeMap: () => new Map<string, unknown>(),
  resolveProviderName: (id: string | null | undefined) => id ?? "",
}));

import ProviderStatsPage from "@/app/(dashboard)/dashboard/provider-stats/page";

const payload = {
  windowSince: "2026-10-12T10:00:00.000Z",
  providers: [
    {
      provider: "openai",
      totalRequests: 4,
      successRate: 100,
      avgLatencyMs: 120,
      models: [],
    },
  ],
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ProviderStatsPage — dismissed load error", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root!.render(<ProviderStatsPage />);
    });
    await flush();
  }

  const errorBanner = () => container.querySelector('[role="alert"]');
  const dismissButton = () =>
    errorBanner()?.querySelector("button") as HTMLButtonElement | null;
  const refreshButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[title="' + (enMessages as never as Record<string, Record<string, string>>).providerStats.refresh + '"]'
    );

  it("hides a dismissed error through polling and reopens it on an explicit refresh", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse(payload))
      .mockImplementation(() => jsonResponse({ error: "boom" }, false));

    await render();
    expect(errorBanner()).toBeNull();

    // First background poll fails: the snapshot stays and the failure is reported.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flush();
    expect(container.textContent).toContain("openai");
    expect(errorBanner()).not.toBeNull();

    // Dismissing keeps it hidden for the next poll.
    await act(async () => {
      dismissButton()!.click();
    });
    expect(errorBanner()).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flush();
    expect(errorBanner()).toBeNull();

    // The header refresh is an explicit retry: the error is allowed back on screen.
    await act(async () => {
      refreshButton()!.click();
    });
    await flush();
    expect(errorBanner()).not.toBeNull();

    fetchMock.mockRestore();
  });
});
