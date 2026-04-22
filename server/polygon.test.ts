import { describe, expect, it } from "vitest";

describe("Polygon.io API Key", () => {
  it("should be set in environment", () => {
    const key = process.env.POLYGON_API_KEY;
    expect(key).toBeDefined();
    expect(key!.length).toBeGreaterThan(10);
  });

  it("should authenticate with Polygon.io API", async () => {
    const key = process.env.POLYGON_API_KEY;
    const res = await fetch(
      `https://api.polygon.io/v3/reference/tickers?ticker=SPY&active=true&limit=1&apiKey=${key}`
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("OK");
    expect(data.results).toBeDefined();
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("should fetch options chain snapshot", async () => {
    const key = process.env.POLYGON_API_KEY;
    const res = await fetch(
      `https://api.polygon.io/v3/snapshot/options/SPY?limit=1&apiKey=${key}`
    );
    // Free tier may return 403 for snapshots, paid tier returns 200
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const data = await res.json();
      expect(data.status).toBe("OK");
    }
  });
});
