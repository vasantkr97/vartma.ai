# React operator console

The production console is built with React and served by the Express gateway at `/console/`. It is
a same-origin application, so no permissive CORS policy or separate dashboard service is required.

The console shows:

- gateway, database, provider, and model readiness;
- enabled providers, compatibility profiles, declared model capabilities, context limits, and
  audited price snapshots;
- actual retry-inclusive spend, failed-attempt cost, baseline cost, and savings;
- model routing distribution;
- redacted recent routing decisions with task class, selected route, explanation, attempts, and
  fallbacks;
- redacted failure and cancellation diagnostics;
- metadata-only recent sessions, task classes, and automatic/manual escalation levels;
- persisted evaluation runs plus the active calibration version and sample coverage by model/task.

The HTML, JavaScript, and CSS assets do not require authentication. Operational endpoints under
`/vartma/v1` retain the gateway API-key middleware. The key entered in the console is kept in
browser `sessionStorage`, which clears with the tab session; it is never placed in a URL or sent to
third-party infrastructure.

Build and run:

```sh
npm run build
npm run dev:gateway
```

Then open `http://127.0.0.1:8080/console/`. Usage panels explicitly show an unavailable state when
PostgreSQL analytics are not configured; they do not substitute estimated or fabricated data.
Routing, failure, and evaluation panels use metadata-only persisted records and never expose prompt
or response content.
