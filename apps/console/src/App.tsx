import { useCallback, useEffect, useState, type ReactNode } from "react";

import { loadSnapshot, type ConsoleSnapshot } from "./api.js";

type View =
  | "overview"
  | "providers"
  | "models"
  | "routing"
  | "sessions"
  | "spend"
  | "evaluations"
  | "failures";

const VIEWS: View[] = [
  "overview",
  "providers",
  "models",
  "routing",
  "sessions",
  "spend",
  "evaluations",
  "failures",
];

export function App() {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("vartma-api-key") ?? "");
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("overview");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await loadSnapshot(apiKey));
      if (apiKey) sessionStorage.setItem("vartma-api-key", apiKey);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load router state.");
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">V</span>
          <span>vartma.ai</span>
        </div>
        <div className="eyebrow">MODEL ROUTER</div>
        <nav>
          {VIEWS.map((item) => (
            <button
              className={view === item ? "navActive" : ""}
              key={item}
              onClick={() => setView(item)}
            >
              <span className="navDot" />
              {title(item)}
            </button>
          ))}
        </nav>
        <div className="sidebarFoot">
          <span className={`statusDot ${snapshot?.ready.status === "ready" ? "online" : ""}`} />
          {snapshot?.ready.status === "ready" ? "Gateway ready" : "Gateway unavailable"}
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="eyebrow">ROUTING CONTROL PLANE</div>
            <h1>{title(view)}</h1>
          </div>
          <div className="controls">
            <input
              aria-label="Router API key"
              type="password"
              placeholder="Router API key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button className="refresh" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="notice error">
            <strong>Connection failed.</strong> {error}
          </div>
        ) : null}
        {!error && loading && !snapshot ? (
          <div className="loading">Reading router telemetry…</div>
        ) : null}
        {snapshot ? <ViewContent view={view} snapshot={snapshot} /> : null}
      </main>
    </div>
  );
}

function ViewContent({ view, snapshot }: { view: View; snapshot: ConsoleSnapshot }) {
  if (view === "providers") return <Providers snapshot={snapshot} />;
  if (view === "models") return <Models snapshot={snapshot} />;
  if (view === "routing") return <Routing snapshot={snapshot} />;
  if (view === "sessions") return <Sessions snapshot={snapshot} />;
  if (view === "spend") return <Spend snapshot={snapshot} />;
  if (view === "evaluations") return <Evaluations snapshot={snapshot} />;
  if (view === "failures") return <Failures snapshot={snapshot} />;
  return <Overview snapshot={snapshot} />;
}

function Overview({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const usage = snapshot.usage;
  const savings = usage?.totals.savingsPercent;
  return (
    <>
      <section className="heroPanel">
        <div>
          <span className="livePill">{snapshot.ready.status}</span>
          <h2>{snapshot.config.defaultMode} routing</h2>
          <p>
            Default <strong>{snapshot.config.defaultModel}</strong> · Baseline{" "}
            <strong>{snapshot.config.baselineModel ?? "not set"}</strong>
          </p>
        </div>
        <div className="heroMetric">
          <span>Router</span>
          <strong>{snapshot.config.routerVersion}</strong>
          <small>{snapshot.config.environment}</small>
        </div>
      </section>
      <section className="metricGrid">
        <Metric
          label="Requests"
          value={usage ? String(usage.totals.requestCount) : "—"}
          note="last 30 days"
        />
        <Metric
          label="Actual spend"
          value={usage ? money(usage.totals.actualAttemptCostUsd) : "—"}
          note="all attempts"
        />
        <Metric
          label="Savings"
          value={savings ? `${savings}%` : "—"}
          note={usage ? money(usage.totals.savingsUsd) : "baseline unavailable"}
          positive
        />
        <Metric
          label="Failed cost"
          value={usage ? money(usage.totals.failedAttemptCostUsd) : "—"}
          note={`${String(usage?.totals.failedRequestCount ?? 0)} failed requests`}
        />
      </section>
      {snapshot.usageUnavailableReason ? (
        <div className="notice">Usage analytics: {snapshot.usageUnavailableReason}</div>
      ) : null}
      <section className="twoColumn">
        <Panel title="Routing distribution" subtitle="Requests by selected model">
          {usage?.distribution.length ? (
            usage.distribution.map((row) => (
              <Distribution
                key={row.key}
                row={row}
                maximum={Math.max(...usage.distribution.map((item) => item.requestCount))}
              />
            ))
          ) : (
            <Empty text="No routed requests in this period." />
          )}
        </Panel>
        <Panel title="Provider health" subtitle="Current configured upstream checks">
          <div className="healthList">
            {snapshot.ready.providers.map((provider) => (
              <div className="healthRow" key={`${provider.provider}/${provider.model}`}>
                <span className={`statusDot ${provider.healthy ? "online" : ""}`} />
                <div>
                  <strong>{provider.model}</strong>
                  <small>{provider.provider}</small>
                </div>
                <span>{provider.healthy ? "healthy" : (provider.reason ?? "down")}</span>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </>
  );
}

function Providers({ snapshot }: { snapshot: ConsoleSnapshot }) {
  return (
    <Panel
      title="Provider registry"
      subtitle="Configured adapters, credential readiness, and current upstream health"
    >
      <div className="providerGrid">
        {snapshot.config.providers.map((provider) => {
          const health = snapshot.ready.providers.filter((item) => item.provider === provider.id);
          const healthyModels = health.filter((item) => item.healthy).length;
          const active = provider.enabled && provider.credentialPresent && healthyModels > 0;
          return (
            <article className="providerCard" key={provider.id}>
              <div className="modelTop">
                <span className="providerBadge">{provider.profile ?? provider.type}</span>
                <span className={`statusDot ${active ? "online" : ""}`} />
              </div>
              <h3>{provider.id}</h3>
              <p>
                {provider.enabled ? "enabled" : "disabled"} · {String(provider.models.length)} model
                {provider.models.length === 1 ? "" : "s"}
              </p>
              <dl>
                <div>
                  <dt>Credential</dt>
                  <dd>{provider.credentialPresent ? "available" : "missing"}</dd>
                </div>
                <div>
                  <dt>Healthy</dt>
                  <dd>
                    {healthyModels}/{health.length}
                  </dd>
                </div>
              </dl>
              {health.some((item) => !item.healthy) ? (
                <small className="dangerText">
                  {health.find((item) => !item.healthy)?.reason ?? "Provider health check failed"}
                </small>
              ) : null}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function Routing({ snapshot }: { snapshot: ConsoleSnapshot }) {
  return (
    <>
      {snapshot.requestsUnavailableReason ? (
        <div className="notice">Routing history: {snapshot.requestsUnavailableReason}</div>
      ) : null}
      <Panel
        title="Recent routing decisions"
        subtitle="Selected model, task classification, attempts, fallbacks, and explanation"
      >
        <RequestTable requests={snapshot.requests} showErrors={false} />
      </Panel>
    </>
  );
}

function Spend({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const usage = snapshot.usage;
  if (!usage) {
    return <div className="notice">Spend analytics: {snapshot.usageUnavailableReason}</div>;
  }
  return (
    <>
      <section className="metricGrid">
        <Metric
          label="Actual provider cost"
          value={money(usage.totals.actualAttemptCostUsd)}
          note={`${String(usage.totals.attemptCount)} attempts`}
        />
        <Metric
          label="Baseline cost"
          value={money(usage.totals.baselineCostUsd)}
          note="comparable requests"
        />
        <Metric
          label="Savings"
          value={money(usage.totals.savingsUsd)}
          note={usage.totals.savingsPercent ? `${usage.totals.savingsPercent}%` : "not comparable"}
          positive
        />
        <Metric
          label="Failed attempt cost"
          value={money(usage.totals.failedAttemptCostUsd)}
          note={`${String(usage.totals.failedRequestCount)} failed requests`}
        />
      </section>
      <Panel
        title="Cost by model"
        subtitle="Retry-inclusive provider usage for the selected period"
      >
        {usage.distribution.length ? (
          usage.distribution.map((row) => (
            <Distribution
              key={row.key}
              row={row}
              maximum={Math.max(...usage.distribution.map((item) => item.requestCount))}
            />
          ))
        ) : (
          <Empty text="No billable usage in this period." />
        )}
      </Panel>
    </>
  );
}

function Failures({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const failures = snapshot.requests.filter(
    (request) => request.status === "FAILED" || request.status === "CANCELLED",
  );
  return (
    <>
      {snapshot.requestsUnavailableReason ? (
        <div className="notice">Failure history: {snapshot.requestsUnavailableReason}</div>
      ) : null}
      <Panel
        title="Recent failures"
        subtitle="Redacted error diagnostics with route and fallback context"
      >
        <RequestTable requests={failures} showErrors />
      </Panel>
    </>
  );
}

function Models({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const models = snapshot.config.providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  return (
    <Panel
      title="Model registry"
      subtitle={`${String(models.length)} configured models across ${String(snapshot.config.providers.length)} providers`}
    >
      <div className="modelGrid">
        {models.map(({ provider, model }) => (
          <article className="modelCard" key={model.id}>
            <div className="modelTop">
              <span className={`providerBadge provider-${provider.type}`}>
                {provider.profile ?? provider.type}
              </span>
              <span
                className={`statusDot ${provider.enabled && model.enabled && provider.credentialPresent ? "online" : ""}`}
              />
            </div>
            <h3>{model.id}</h3>
            <p>{model.upstreamModel}</p>
            <div className="capabilities">
              {Object.entries(model.capabilities)
                .filter(([, enabled]) => enabled)
                .map(([capability]) => (
                  <span key={capability}>{capability}</span>
                ))}
            </div>
            <dl>
              <div>
                <dt>Quality</dt>
                <dd>{String(model.qualityTier)}/5</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{compact(model.contextWindow)}</dd>
              </div>
              <div>
                <dt>Input</dt>
                <dd>${model.pricing.inputPerMillion}/M</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>${model.pricing.outputPerMillion}/M</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </Panel>
  );
}

function Sessions({ snapshot }: { snapshot: ConsoleSnapshot }) {
  return (
    <Panel title="Recent sessions" subtitle="Metadata only; prompts and outputs are not exposed">
      {snapshot.sessions.length ? (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Mode</th>
                <th>Current model</th>
                <th>Turns</th>
                <th>Task</th>
                <th>Escalation</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <code>{shortId(session.id)}</code>
                  </td>
                  <td>
                    <span className="modePill">{session.routingMode}</span>
                  </td>
                  <td>{session.currentModel ?? "—"}</td>
                  <td>{session.turnCount}</td>
                  <td>{session.lastTaskClass ?? "—"}</td>
                  <td>
                    <span className={session.escalationLevel ? "dangerText" : ""}>
                      {session.escalationLevel}
                    </span>
                    {session.automaticEscalationLevel ? <small> auto</small> : null}
                  </td>
                  <td>{relativeTime(session.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="No sessions recorded yet." />
      )}
    </Panel>
  );
}

function Evaluations({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const entries = Object.entries(snapshot.config.calibration.models);
  return (
    <>
      <section className="heroPanel compactHero">
        <div>
          <span className="livePill">
            {snapshot.config.calibration.enabled ? "active" : "disabled"}
          </span>
          <h2>{snapshot.config.calibration.version}</h2>
          <p>Bayesian prior strength: {snapshot.config.calibration.priorSampleSize} samples</p>
        </div>
        <div className="heroMetric">
          <span>Calibrated models</span>
          <strong>{entries.length}</strong>
          <small>fixed-model evidence only</small>
        </div>
      </section>
      {snapshot.evaluationsUnavailableReason ? (
        <div className="notice">Evaluation history: {snapshot.evaluationsUnavailableReason}</div>
      ) : null}
      <Panel title="Evaluation runs" subtitle="Persisted fixed-model and routed benchmark evidence">
        {snapshot.evaluationRuns.length ? (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Dataset</th>
                  <th>Target</th>
                  <th>Solved</th>
                  <th>Attempts</th>
                  <th>Actual cost</th>
                  <th>p95</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.evaluationRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <code title={run.id}>{shortId(run.id)}</code>
                    </td>
                    <td>
                      <span title={run.datasetDigest}>
                        {run.dataset}@{run.datasetVersion}{" "}
                        <code>{run.datasetDigest.slice(7, 19)}</code>
                      </span>
                    </td>
                    <td>{run.target}</td>
                    <td>
                      {run.solved}/{run.tasks} ({(run.passRate * 100).toFixed(1)}%)
                    </td>
                    <td>{run.attempts}</td>
                    <td>{money(run.actualCostUsd)}</td>
                    <td>{run.p95LatencyMs}ms</td>
                    <td>{relativeTime(run.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="No persisted evaluation runs yet." />
        )}
      </Panel>
      <Panel
        title="Evaluation coverage"
        subtitle="Task-specific sample counts used by the live router"
      >
        {entries.length ? (
          <div className="evaluationList">
            {entries.map(([model, profile]) => (
              <article key={model}>
                <div>
                  <strong>{model}</strong>
                  <small>default samples: {profile.defaultSampleSize}</small>
                </div>
                <div className="capabilities">
                  {Object.entries(profile.taskSamples).map(([task, count]) => (
                    <span key={task}>
                      {task}: {count}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty text="No measured calibration is applied. Routing currently uses task-aware quality priors." />
        )}
      </Panel>
    </>
  );
}

function RequestTable({
  requests,
  showErrors,
}: {
  requests: ConsoleSnapshot["requests"];
  showErrors: boolean;
}) {
  if (!requests.length) {
    return (
      <Empty text={showErrors ? "No recent failures." : "No persisted route decisions yet."} />
    );
  }
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Request</th>
            <th>Status</th>
            <th>Mode</th>
            <th>Task</th>
            <th>Selected route</th>
            <th>Attempts</th>
            <th>{showErrors ? "Error" : "Why"}</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>
                <code title={request.id}>{shortId(request.id)}</code>
              </td>
              <td>
                <span className={request.status === "COMPLETED" ? "positive" : "dangerText"}>
                  {request.status.toLowerCase()}
                </span>
              </td>
              <td>
                <span className="modePill">{request.routingMode}</span>
              </td>
              <td>{request.taskClass ?? "—"}</td>
              <td>
                {request.selectedProvider && request.selectedModel
                  ? `${request.selectedProvider} / ${request.selectedModel}`
                  : "—"}
              </td>
              <td>
                {request.attemptCount}
                {request.fallbackCount ? ` (${String(request.fallbackCount)} fallback)` : ""}
              </td>
              <td className="explanationCell">
                {showErrors
                  ? [request.errorType, request.errorMessage].filter(Boolean).join(": ") || "—"
                  : request.explanation || request.selectedReasons[0] || "—"}
              </td>
              <td>{relativeTime(request.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  positive = false,
}: {
  label: string;
  value: string;
  note: string;
  positive?: boolean;
}) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong className={positive ? "positive" : ""}>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function Panel({
  title: heading,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panelHead">
        <div>
          <h2>{heading}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
function Distribution({
  row,
  maximum,
}: {
  row: NonNullable<ConsoleSnapshot["usage"]>["distribution"][number];
  maximum: number;
}) {
  return (
    <div className="distribution">
      <div>
        <strong>{row.key}</strong>
        <span>
          {row.requestCount} requests · {money(row.actualAttemptCostUsd)}
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.max(4, (row.requestCount / maximum) * 100)}%` }} />
      </div>
    </div>
  );
}
function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function money(value: string) {
  return `$${Number(value).toFixed(2)}`;
}
function compact(value: number) {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}K`
      : String(value);
}
function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
function relativeTime(value: string) {
  const delta = Date.now() - Date.parse(value);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}
