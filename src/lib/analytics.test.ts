import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsClient } from "./analytics";

const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

async function freshAnalytics() {
  vi.resetModules();
  return import("./analytics");
}

function analyticsClient(): AnalyticsClient {
  return {
    init: vi.fn(),
    capture: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    has_opted_out_capturing: vi.fn(() => false),
  };
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { userAgent: "Vitest" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telemetry consent", () => {
  it("defaults to off and does not initialise a client", async () => {
    const analytics = await freshAnalytics();
    const client = analyticsClient();

    expect(analytics.analyticsEnabled()).toBe(false);
    expect(analytics.analyticsAvailable()).toBe(false);
    analytics.initAnalytics(client);

    expect(client.init).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("stores the Helmryth opt-in under its own key only", async () => {
    const analytics = await freshAnalytics();

    analytics.setAnalyticsEnabled(true);

    expect(analytics.analyticsEnabled()).toBe(true);
    expect([...store.entries()]).toEqual([["helmryth.analytics.opt-in.v1", "1"]]);
  });

  it("reads a stored opt-in and a later stored opt-out", async () => {
    store.set("helmryth.analytics.opt-in.v1", "1");
    expect((await freshAnalytics()).analyticsEnabled()).toBe(true);

    store.set("helmryth.analytics.opt-in.v1", "0");
    expect((await freshAnalytics()).analyticsEnabled()).toBe(false);
  });

  it("does not treat an unrecognised stored value as consent", async () => {
    store.set("helmryth.analytics.opt-in.v1", "yes");
    const analytics = await freshAnalytics();

    expect(analytics.analyticsEnabled()).toBe(false);
  });

  it("falls back to off when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const analytics = await freshAnalytics();

    expect(analytics.analyticsEnabled()).toBe(false);
    expect(() => analytics.setAnalyticsEnabled(false)).not.toThrow();
  });
});

describe("configured telemetry", () => {
  beforeEach(() => {
    vi.stubGlobal("__HELMRYTH_ANALYTICS__", {
      posthogKey: "phc_helmryth_test",
      posthogHost: "https://telemetry.helmryth.example",
    });
  });

  it("initialises only after explicit opt-in", async () => {
    store.set("helmryth.analytics.opt-in.v1", "1");
    const analytics = await freshAnalytics();
    const client = analyticsClient();

    expect(analytics.analyticsAvailable()).toBe(true);
    analytics.initAnalytics(client);
    expect(client.init).toHaveBeenCalledWith(
      "phc_helmryth_test",
      expect.objectContaining({
        api_host: "https://telemetry.helmryth.example",
        autocapture: false,
        capture_pageview: false,
      }),
    );
    expect(client.capture).toHaveBeenCalledWith("app_first_open", { platform: "browser" });
    expect(client.capture).toHaveBeenCalledWith("app_opened", { platform: "browser" });
  });

  it("stops a running client immediately when consent is withdrawn", async () => {
    store.set("helmryth.analytics.opt-in.v1", "1");
    const analytics = await freshAnalytics();
    const client = analyticsClient();
    analytics.initAnalytics(client);

    analytics.setAnalyticsEnabled(false);

    expect(client.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(store.get("helmryth.analytics.opt-in.v1")).toBe("0");
  });

  it("rejects a non-HTTPS collection endpoint", async () => {
    vi.stubGlobal("__HELMRYTH_ANALYTICS__", {
      posthogKey: "phc_helmryth_test",
      posthogHost: "http://telemetry.helmryth.example",
    });
    store.set("helmryth.analytics.opt-in.v1", "1");
    const analytics = await freshAnalytics();
    const client = analyticsClient();

    analytics.initAnalytics(client);

    expect(analytics.analyticsAvailable()).toBe(false);
    expect(client.init).not.toHaveBeenCalled();
  });

  it("reports first open only once and keeps the recorded install marker", async () => {
    store.set("helmryth.install.first-seen.v1", "2026-01-01T00:00:00.000Z");
    store.set("helmryth.analytics.opt-in.v1", "1");
    const analytics = await freshAnalytics();
    const client = analyticsClient();

    analytics.initAnalytics(client);

    expect(client.capture).not.toHaveBeenCalledWith("app_first_open", expect.anything());
    expect(store.get("helmryth.install.first-seen.v1")).toBe("2026-01-01T00:00:00.000Z");
    expect(client.capture).toHaveBeenCalledWith("app_opened", { platform: "browser" });
  });
});

describe("profile-step persistence", () => {
  it("persists the completed profile step under the Helmryth key", async () => {
    const analytics = await freshAnalytics();

    expect(analytics.emailGateDone()).toBe(false);
    analytics.setEmailGateDone("submitted");

    expect(analytics.emailGateDone()).toBe(true);
    expect([...store.entries()]).toEqual([["helmryth.onboarding.profile-step.v1", "submitted"]]);
  });

  it("treats a previously skipped profile step as done", async () => {
    store.set("helmryth.onboarding.profile-step.v1", "skipped");
    const analytics = await freshAnalytics();

    expect(analytics.emailGateDone()).toBe(true);
  });
});
