import { describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { classifyError, recordHealth, runProvider } from "./providers/orchestrator";
import { addEvidence, listEvidence } from "./services/evidence";
import { nowIso } from "./db";

/**
 * Truthfulness contract tests. These guard the two highest-risk fabrications:
 * 1) a provider failure must never surface as successful data,
 * 2) evidence must never be silently reclassified into another domain, and
 * 3) evidence recorded for one field must never be readable under another.
 */

describe("provider error classification", () => {
  test("auth failures classify as AUTH_REQUIRED, not AVAILABLE", () => {
    expect(classifyError(new Error("HTTP 401 from https://api: unauthorized"))).toBe("AUTH_REQUIRED");
    expect(classifyError(new Error("403 forbidden"))).toBe("AUTH_REQUIRED");
  });
  test("rate limits classify as RATE_LIMITED", () => {
    expect(classifyError(new Error("HTTP 429 Too Many Requests"))).toBe("RATE_LIMITED");
  });
  test("timeouts classify as TIMEOUT", () => {
    expect(classifyError(new Error("fetch failed: timed out"))).toBe("TIMEOUT");
  });
  test("5xx responses classify as DATA_QUALITY_FAILURE — the provider answered but its service is degraded (e.g. ISRIC 503 while SoilGrids is paused)", () => {
    expect(classifyError(new Error("HTTP 500 boom"))).toBe("DATA_QUALITY_FAILURE");
    expect(classifyError(new Error("HTTP 503 from https://rest.isric.org: <html>503 Service Temporarily Unavailable</html>"))).toBe("DATA_QUALITY_FAILURE");
  });
  test("unknown provider errors classify as PROVIDER_ERROR — never AVAILABLE", () => {
    expect(classifyError(new Error("fetch failed: ECONNREFUSED 10.0.0.1:443"))).toBe("PROVIDER_ERROR");
  });
});

describe("provider health recording", () => {
  test("a failing provider records a non-AVAILABLE state with the error", () => {
    const db = openDb(":memory:");
    recordHealth(db, "copernicus", "AUTH_REQUIRED", 120, "token missing");
    const row = db.conn.query("SELECT status, last_error, last_success_at FROM provider_health WHERE provider='copernicus'").get() as {
      status: string;
      last_error: string | null;
      last_success_at: string | null;
    };
    expect(row.status).toBe("AUTH_REQUIRED");
    expect(row.last_error).toContain("token missing");
    expect(row.last_success_at).toBeNull(); // a failure must never look like success
  });

  test("runProvider returns a truthful status when the adapter throws", async () => {
    const db = openDb(":memory:");
    const res = await runProvider(
      { db },
      "openmeteo",
      () => {
        throw new Error("HTTP 401 unauthorized");
      },
      { retries: 0 },
    );
    expect(res.status).toBe("AUTH_REQUIRED");
    expect(res.data).toBeNull();
    expect(res.error).toBeTruthy();
  });

  test("runProvider records AVAILABLE only on real success", async () => {
    const db = openDb(":memory:");
    const res = await runProvider({ db }, "openmeteo", async () => ({ data: { ok: 1 } }), { retries: 0 });
    expect(res.status).toBe("AVAILABLE");
    expect((res.data as { ok: number }).ok).toBe(1);
    const row = db.conn.query("SELECT status FROM provider_health WHERE provider='openmeteo'").get() as { status: string };
    expect(row.status).toBe("AVAILABLE");
  });
});

describe("evidence domain classification", () => {
  test("stored domain always equals the domain the adapter assigned (no generic relabeling)", () => {
    const db = openDb(":memory:");
    const now = nowIso();
    const typedCases: { domain: "soil" | "terrain" | "weather"; sub_type: string; state: "ESTIMATED" | "DERIVED" | "HISTORICAL" }[] = [
      { domain: "soil", sub_type: "phh2o@0-5cm", state: "ESTIMATED" },
      { domain: "terrain", sub_type: "elevation_m", state: "DERIVED" },
      { domain: "weather", sub_type: "precipitation_sum", state: "HISTORICAL" },
    ];
    for (const c of typedCases) {
      const rec = addEvidence(db, {
        userId: "u1",
        farmId: "f1",
        fieldId: "fld1",
        domain: c.domain,
        source: "test",
        source_type: "test",
        sub_type: c.sub_type,
        measurement: null,
        value: 1,
        unit: null,
        state: c.state,
        observed_at: now,
        provenance: { provider: "test" },
      });
      expect(rec.domain).toBe(c.domain);
    }
    // environment rows must never land under terrain
    const terrain = listEvidence(db, "fld1", { domain: "terrain" });
    expect(terrain.every((e) => e.domain === "terrain")).toBe(true);
    const soil = listEvidence(db, "fld1", { domain: "soil" });
    expect(soil.every((e) => e.domain === "soil")).toBe(true);
  });

  test("schema rejects unknown truth states (no silent fabrication of states)", () => {
    const db = openDb(":memory:");
    expect(() =>
      addEvidence(db, {
        userId: "u1",
        farmId: "f1",
        fieldId: "fld1",
        domain: "soil",
        source: "test",
        source_type: "test",
        sub_type: "ph",
        measurement: null,
        value: 6.8,
        unit: "pH",
        state: "OBSERVED" as never, // pH with no source would be fabricated — but schema allows OBSERVED generally
        observed_at: nowIso(),
        provenance: { provider: "test" },
      }),
    ).not.toThrow();
    expect(() =>
      addEvidence(db, {
        userId: "u1",
        farmId: "f1",
        fieldId: "fld1",
        domain: "soil",
        source: "test",
        source_type: "test",
        sub_type: "ph",
        measurement: null,
        value: 6.8,
        unit: "pH",
        state: "MADE_UP" as never,
        observed_at: nowIso(),
        provenance: { provider: "test" },
      }),
    ).toThrow();
  });
});

describe("field isolation", () => {
  test("evidence for field A is never returned for field B", () => {
    const db = openDb(":memory:");
    const now = nowIso();
    addEvidence(db, {
      userId: "uA",
      farmId: "farmA",
      fieldId: "fieldA",
      domain: "weather",
      source: "test",
      source_type: "test",
      sub_type: "temperature_2m",
      measurement: null,
      value: 31,
      unit: "°C",
      state: "HISTORICAL",
      observed_at: now,
      provenance: { provider: "test" },
    });
    addEvidence(db, {
      userId: "uB",
      farmId: "farmB",
      fieldId: "fieldB",
      domain: "weather",
      source: "test",
      source_type: "test",
      sub_type: "temperature_2m",
      measurement: null,
      value: 22,
      unit: "°C",
      state: "HISTORICAL",
      observed_at: now,
      provenance: { provider: "test" },
    });
    const a = listEvidence(db, "fieldA");
    const b = listEvidence(db, "fieldB");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].field_id).toBe("fieldA");
    expect(b[0].field_id).toBe("fieldB");
    expect(a.some((e) => e.value === 22)).toBe(false);
    expect(b.some((e) => e.value === 31)).toBe(false);
  });
});
