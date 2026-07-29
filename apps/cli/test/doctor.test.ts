import { routerConfigSchema } from "@vartma/config";
import { describe, expect, it, vi } from "vitest";

import {
  formatDiagnosticReport,
  formatDoctorReport,
  runDoctor,
  runProviderDiagnostics,
} from "../src/doctor.js";

describe("vartma doctor", () => {
  it("checks credentials, provider models, gateway readiness, and PostgreSQL without leaking keys", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/readyz")) {
        return Promise.resolve(new Response('{"status":"ready"}', { status: 200 }));
      }
      if (url.endsWith("/v1/models/gpt-test")) {
        return Promise.resolve(new Response('{"id":"gpt-test"}', { status: 200 }));
      }
      throw new Error(`Unexpected diagnostic URL: ${url}`);
    });
    const databaseCheck = vi.fn(() => Promise.resolve());

    const report = await runDoctor(
      doctorConfig(),
      { timeoutMs: 1_000 },
      {
        environment: { DOCTOR_OPENAI_KEY: "super-secret-provider-key" },
        fetchImplementation: fetchMock,
        databaseCheck,
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(true);
    expect(report.generatedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "configuration", status: "pass" }),
        expect.objectContaining({ id: "credential:openai", status: "pass" }),
        expect.objectContaining({ id: "provider:fake:fake-default", status: "pass" }),
        expect.objectContaining({ id: "provider:openai:gpt-test", status: "pass" }),
        expect.objectContaining({ id: "gateway", status: "pass" }),
        expect.objectContaining({ id: "database", status: "pass" }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(databaseCheck).toHaveBeenCalledWith(
      "postgresql://vartma:database-secret@localhost:5432/vartma",
    );
    expect(JSON.stringify(report)).not.toContain("super-secret-provider-key");
    expect(JSON.stringify(report)).not.toContain("database-secret");
    expect(formatDoctorReport(report)).toContain("Doctor result: PASS");
  });

  it("reports missing credentials and downstream failures instead of throwing", async () => {
    const report = await runDoctor(
      doctorConfig(),
      { timeoutMs: 1_000 },
      {
        environment: {},
        fetchImplementation: (input) =>
          Promise.resolve(
            new Response("not ready", {
              status: requestUrl(input).endsWith("/readyz") ? 503 : 500,
              statusText: "Unavailable",
            }),
          ),
        databaseCheck: () => Promise.reject(new Error("connection refused")),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "credential:openai",
          status: "fail",
          message: "Missing credential environment variable DOCTOR_OPENAI_KEY.",
        }),
        expect.objectContaining({
          id: "provider:openai:gpt-test",
          status: "skip",
        }),
        expect.objectContaining({ id: "gateway", status: "fail" }),
        expect.objectContaining({
          id: "database",
          status: "fail",
          message: "PostgreSQL check failed: connection refused.",
        }),
      ]),
    );
    expect(formatDoctorReport(report)).toContain("Doctor result: FAIL");
  });

  it("fails an OpenAI-compatible probe when the configured model is absent", async () => {
    const config = doctorConfig();
    config.providers.push({
      ...config.providers[1]!,
      id: "local",
      type: "openai-compatible",
      baseUrl: "http://localhost:8000",
      apiKeyEnv: "LOCAL_KEY",
      models: [model("local", "local/default", "expected-local-model")],
    });

    const checks = await runProviderDiagnostics(
      config,
      { timeoutMs: 1_000, providerId: "local" },
      {
        environment: { LOCAL_KEY: "local-secret-value" },
        fetchImplementation: () =>
          Promise.resolve(new Response('{"data":[{"id":"different-model"}]}', { status: 200 })),
      },
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "provider:local:expected-local-model",
          status: "fail",
          message: "Model list responded with HTTP 200, but expected-local-model was not present.",
        }),
      ]),
    );
    expect(JSON.stringify(checks)).not.toContain("local-secret-value");
    expect(formatDiagnosticReport(diagnosticReport(checks), "Provider")).toContain(
      "Provider result: FAIL",
    );
  });
});

function doctorConfig() {
  return routerConfigSchema.parse({
    environment: "test",
    server: {
      host: "0.0.0.0",
      port: 8080,
      trustProxy: false,
      requestBodyLimitBytes: 1_048_576,
    },
    auth: { enabled: false, apiKeys: [] },
    database: {
      url: "postgresql://vartma:database-secret@localhost:5432/vartma",
      requiredForReadiness: true,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: "fake/default",
      routerVersion: "doctor-test",
    },
    providers: [
      {
        id: "fake",
        type: "fake",
        enabled: true,
        models: [model("fake", "fake/default", "fake-default")],
      },
      {
        id: "openai",
        type: "openai",
        enabled: true,
        apiKeyEnv: "DOCTOR_OPENAI_KEY",
        models: [model("openai", "openai/default", "gpt-test")],
      },
    ],
    telemetry: {
      serviceName: "doctor-test",
      logLevel: "error",
      langSmith: {
        enabled: false,
        apiKeyEnv: "LANGSMITH_API_KEY",
        project: "test",
        exportContent: false,
      },
    },
  });
}

function model(provider: string, id: string, upstreamModel: string) {
  return {
    id,
    provider,
    upstreamModel,
    enabled: true,
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      tools: false,
      structuredOutput: false,
      reasoning: false,
    },
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    qualityTier: 3,
    expectedLatencyTier: 2,
    pricing: {
      currency: "USD" as const,
      effectiveFrom: "2026-07-28",
      verifiedAt: "2026-07-28",
      source: "doctor test",
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
    },
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function diagnosticReport(checks: Awaited<ReturnType<typeof runProviderDiagnostics>>) {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    generatedAt: "2026-07-28T00:00:00.000Z",
    checks,
  };
}
