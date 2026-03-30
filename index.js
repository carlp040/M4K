const express = require("express");
const fs = require("fs");
const { MongoClient } = require("mongodb");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const CHECKLIST_PATH = path.join(__dirname, "mission_challenges_checklist.txt");
const MONGO_URL = process.env.MONGO_URL || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "m4kdb";
const MONGO_METRICS_COLLECTION = "runtime_metrics";
const MONGO_PROOF_COLLECTION = "proof_counter";

const metrics = {
  totalRequests: 0,
  totalResponseTimeMs: 0,
  routes: {}
};

let mongoClient = null;
let mongoMetricsCollection = null;
let mongoProofCollection = null;
let mongoConnected = false;
let mongoInitStarted = false;
let metricsPersistTimer = null;
let metricsPersistInFlight = false;

function toFixedNumber(value) {
  return Number(value.toFixed(2));
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readChecklistFile() {
  try {
    return fs.readFileSync(CHECKLIST_PATH, "utf8");
  } catch (error) {
    return "Checklist file not found. Add mission_challenges_checklist.txt in repo root.";
  }
}

function routeMetricName(route) {
  const normalized = route.replaceAll("/", "_").replace(/[^a-zA-Z0-9_]/g, "_");
  return normalized.length === 0 ? "root" : normalized;
}

function buildMetricsSnapshot() {
  return {
    totalRequests: metrics.totalRequests,
    totalResponseTimeMs: metrics.totalResponseTimeMs,
    routes: metrics.routes
  };
}

function restoreMetricsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return;
  }

  if (typeof snapshot.totalRequests === "number") {
    metrics.totalRequests = snapshot.totalRequests;
  }
  if (typeof snapshot.totalResponseTimeMs === "number") {
    metrics.totalResponseTimeMs = snapshot.totalResponseTimeMs;
  }
  if (snapshot.routes && typeof snapshot.routes === "object") {
    metrics.routes = snapshot.routes;
  }
}

async function initMongoIfConfigured() {
  if (!MONGO_URL || mongoInitStarted) {
    return;
  }

  mongoInitStarted = true;

  try {
    mongoClient = new MongoClient(MONGO_URL, {
      serverSelectionTimeoutMS: 3000
    });
    await mongoClient.connect();

    const db = mongoClient.db(MONGO_DB_NAME);
    mongoMetricsCollection = db.collection(MONGO_METRICS_COLLECTION);
    mongoProofCollection = db.collection(MONGO_PROOF_COLLECTION);
    mongoConnected = true;

    const persistedMetrics = await mongoMetricsCollection.findOne({ _id: "service-metrics" });
    if (persistedMetrics && persistedMetrics.snapshot) {
      restoreMetricsSnapshot(persistedMetrics.snapshot);
    }

    console.log("MongoDB connected. Metrics persistence is enabled.");
  } catch (error) {
    mongoConnected = false;
    console.warn(`MongoDB connection failed. Running memory-only mode: ${error.message}`);
  }
}

async function persistMetricsSnapshot() {
  if (!mongoMetricsCollection || metricsPersistInFlight) {
    return;
  }

  metricsPersistInFlight = true;
  try {
    await mongoMetricsCollection.replaceOne(
      { _id: "service-metrics" },
      {
        _id: "service-metrics",
        snapshot: buildMetricsSnapshot(),
        updatedAt: new Date()
      },
      { upsert: true }
    );
    mongoConnected = true;
  } catch (error) {
    mongoConnected = false;
    console.warn(`MongoDB metrics persist failed: ${error.message}`);
  } finally {
    metricsPersistInFlight = false;
  }
}

function scheduleMetricsPersistence() {
  if (!mongoMetricsCollection || metricsPersistTimer) {
    return;
  }

  metricsPersistTimer = setTimeout(() => {
    metricsPersistTimer = null;
    void persistMetricsSnapshot();
  }, 1000);
}

function getK8sRuntimeInfo() {
  const inKubernetes = Boolean(process.env.KUBERNETES_SERVICE_HOST);

  return {
    inKubernetes,
    kubernetesServiceHost: process.env.KUBERNETES_SERVICE_HOST || "not-set",
    podName: process.env.POD_NAME || "not-set",
    podNamespace: process.env.POD_NAMESPACE || "not-set",
    nodeName: process.env.NODE_NAME || "not-set"
  };
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;
    const route = req.path || "unknown";

    metrics.totalRequests += 1;
    metrics.totalResponseTimeMs += durationMs;

    if (!metrics.routes[route]) {
      metrics.routes[route] = {
        requests: 0,
        totalResponseTimeMs: 0,
        lastStatusCode: 0
      };
    }

    metrics.routes[route].requests += 1;
    metrics.routes[route].totalResponseTimeMs += durationMs;
    metrics.routes[route].lastStatusCode = res.statusCode;

    scheduleMetricsPersistence();
  });

  next();
});

app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    service: "first-pipeline",
    healthy: true,
    uptimeSeconds: Math.floor(process.uptime()),
    mongoConfigured: Boolean(MONGO_URL),
    mongoConnected
  });
});

app.get("/metrics", (req, res) => {
  const averageResponseMs =
    metrics.totalRequests === 0
      ? 0
      : toFixedNumber(metrics.totalResponseTimeMs / metrics.totalRequests);

  const routeMetrics = {};
  Object.keys(metrics.routes).forEach((route) => {
    const routeData = metrics.routes[route];
    const routeAverage =
      routeData.requests === 0
        ? 0
        : toFixedNumber(routeData.totalResponseTimeMs / routeData.requests);

    routeMetrics[route] = {
      requests: routeData.requests,
      averageResponseMs: routeAverage,
      lastStatusCode: routeData.lastStatusCode
    };
  });

  res.json({
    uptimeSeconds: Math.floor(process.uptime()),
    totalRequests: metrics.totalRequests,
    averageResponseMs,
    routeMetrics,
    persistence: {
      mode: mongoConnected ? "memory+mongo" : "memory-only",
      mongoConfigured: Boolean(MONGO_URL),
      mongoConnected
    }
  });
});

app.get("/metrics/prometheus", (req, res) => {
  const averageResponseMs =
    metrics.totalRequests === 0
      ? 0
      : toFixedNumber(metrics.totalResponseTimeMs / metrics.totalRequests);

  const lines = [
    "# HELP pipeline_total_requests Total HTTP requests handled by the service",
    "# TYPE pipeline_total_requests counter",
    `pipeline_total_requests ${metrics.totalRequests}`,
    "# HELP pipeline_average_response_ms Average response time in milliseconds",
    "# TYPE pipeline_average_response_ms gauge",
    `pipeline_average_response_ms ${averageResponseMs}`,
    "# HELP pipeline_uptime_seconds Service uptime in seconds",
    "# TYPE pipeline_uptime_seconds gauge",
    `pipeline_uptime_seconds ${Math.floor(process.uptime())}`
  ];

  Object.keys(metrics.routes).forEach((route) => {
    const routeData = metrics.routes[route];
    const routeAverage =
      routeData.requests === 0
        ? 0
        : toFixedNumber(routeData.totalResponseTimeMs / routeData.requests);
    const metricLabel = routeMetricName(route);

    lines.push(`# HELP pipeline_route_requests_${metricLabel} Requests for route ${route}`);
    lines.push(`# TYPE pipeline_route_requests_${metricLabel} counter`);
    lines.push(`pipeline_route_requests_${metricLabel} ${routeData.requests}`);
    lines.push(`# HELP pipeline_route_average_response_ms_${metricLabel} Average response time for route ${route}`);
    lines.push(`# TYPE pipeline_route_average_response_ms_${metricLabel} gauge`);
    lines.push(`pipeline_route_average_response_ms_${metricLabel} ${routeAverage}`);
  });

  res
    .status(200)
    .type("text/plain; version=0.0.4; charset=utf-8")
    .send(`${lines.join("\n")}\n`);
});

app.get("/k8s", (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    ...getK8sRuntimeInfo()
  });
});

app.get("/db-status", (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    mongoConfigured: Boolean(MONGO_URL),
    mongoConnected,
    database: MONGO_DB_NAME,
    collections: [MONGO_METRICS_COLLECTION, MONGO_PROOF_COLLECTION]
  });
});

app.get("/mongo-proof", async (req, res) => {
  if (!mongoProofCollection) {
    return res.status(503).json({
      ok: false,
      mongoConfigured: Boolean(MONGO_URL),
      mongoConnected: false,
      message: "MongoDB proof is unavailable (database not connected)."
    });
  }

  try {
    const mode = req.query.mode === "read" ? "read" : "write";

    if (mode === "write") {
      await mongoProofCollection.updateOne(
        { _id: "proof-counter" },
        {
          $inc: { hits: 1 },
          $set: {
            lastPod: process.env.POD_NAME || "not-set",
            lastNamespace: process.env.POD_NAMESPACE || "not-set",
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }

    const proofDoc =
      (await mongoProofCollection.findOne({ _id: "proof-counter" })) || {
        hits: 0,
        lastPod: "not-set",
        lastNamespace: "not-set",
        updatedAt: null
      };
    mongoConnected = true;

    return res.json({
      ok: true,
      mode,
      message: mode === "write" ? "MongoDB write+read succeeded." : "MongoDB read succeeded.",
      proof: {
        hits: proofDoc?.hits || 0,
        lastPod: proofDoc?.lastPod || "not-set",
        lastNamespace: proofDoc?.lastNamespace || "not-set",
        updatedAt: proofDoc?.updatedAt || null
      }
    });
  } catch (error) {
    mongoConnected = false;
    return res.status(500).json({
      ok: false,
      mongoConfigured: Boolean(MONGO_URL),
      mongoConnected,
      message: "MongoDB proof failed.",
      error: error.message
    });
  }
});

app.get("/secret", (req, res) => {
  res.json({
    message: "You found the secret! Here's a cookie.",
    code: "OPERATION-PIPELINE"
  });
});

app.get("/coffee", (req, res) => {
  res.type("text/plain").send(`
    ( (
     ) )
  ........
  |      |]
  \\      /
   \`----'
`);
});

app.get("/", (req, res) => {
  const now = new Date().toISOString();
  const host = req.get("x-forwarded-host") || req.get("host");
  const baseUrl = `${req.protocol}://${host}`;
  const repoUrl = "https://github.com/PalmChas/M4K-Pipeline";
  const actionsUrl = "https://github.com/PalmChas/M4K-Pipeline/actions/workflows/pipeline.yml";
  const deployUrl = "https://m4k-pipeline-production.up.railway.app";
  const checklistUrl = `${repoUrl}/blob/main/mission_challenges_checklist.txt`;
  const checklistText = escapeHtml(readChecklistFile());
  const teamName = "M4K Gang";
  const teamMembers = [
    "Oskar Palm",
    "Carl Persson",
    "Jonny Nguyen",
    "Julia Persson",
    "Mattej Petrovic"
  ];
  const teamMemberList = teamMembers.map((member) => `<li>${member}</li>`).join("");
  const averageResponseMs =
    metrics.totalRequests === 0
      ? 0
      : toFixedNumber(metrics.totalResponseTimeMs / metrics.totalRequests);
  const k8sInfo = getK8sRuntimeInfo();
  const k8sStatus = k8sInfo.inKubernetes ? "Running in Kubernetes" : "Not running in Kubernetes";
  const k8sStatusClass = k8sInfo.inKubernetes ? "ok" : "meta";

  res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>First Pipeline Challenge</title>
        <style>
          :root {
            color-scheme: light;
            --bg-a: #f7fbff;
            --bg-b: #eef5ff;
            --surface: #ffffff;
            --text: #0f172a;
            --muted: #334155;
            --line: #dbe7ff;
            --accent: #1d4ed8;
            --ok-bg: #dcfce7;
            --ok-text: #166534;
            --card-bg: #f8fbff;
          }
          * {
            box-sizing: border-box;
          }
          body {
            margin: 0;
            font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(120deg, var(--bg-a), var(--bg-b));
            color: var(--text);
          }
          .wrap {
            max-width: 1100px;
            margin: 28px auto;
            padding: 20px;
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: 16px;
            box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
          }
          h1 {
            margin: 0 0 10px;
            font-size: 2rem;
          }
          h2 {
            margin: 0 0 10px;
            font-size: 1.15rem;
          }
          p {
            margin-top: 0;
          }
          .ok {
            display: inline-block;
            margin-bottom: 12px;
            padding: 6px 11px;
            border-radius: 999px;
            background: var(--ok-bg);
            color: var(--ok-text);
            font-weight: 700;
          }
          .subtitle {
            color: var(--muted);
            margin-bottom: 18px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
            gap: 12px;
          }
          .card {
            border: 1px solid var(--line);
            border-radius: 12px;
            padding: 14px;
            background: var(--card-bg);
          }
          .badge {
            display: inline-block;
            font-size: 0.82rem;
            color: #1e3a8a;
            background: #dbeafe;
            border-radius: 999px;
            padding: 3px 8px;
            margin-bottom: 10px;
          }
          ul {
            margin: 0;
            padding-left: 18px;
          }
          li {
            margin: 6px 0;
          }
          a {
            color: var(--accent);
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
          .meta {
            color: var(--muted);
          }
          .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px;
            margin-top: 10px;
          }
          .stat {
            padding: 10px;
            border-radius: 10px;
            border: 1px solid var(--line);
            background: #fff;
          }
          .stat strong {
            display: block;
            font-size: 1.1rem;
          }
          .task-list {
            margin-top: 10px;
            list-style: none;
            padding-left: 0;
          }
          .task-list li {
            margin: 8px 0;
          }
          .task {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .task input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #166534;
          }
          .task.done {
            color: #166534;
          }
          pre {
            white-space: pre-wrap;
            word-break: break-word;
            background: #0b1220;
            color: #dbeafe;
            border-radius: 10px;
            padding: 12px;
            overflow-x: auto;
            margin: 0;
          }
          .section {
            margin-top: 12px;
          }
          .small {
            font-size: 0.93rem;
            color: #475569;
          }
          .mono {
            font-family: Consolas, "Courier New", monospace;
            word-break: break-all;
          }
          .live-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px;
            margin-top: 8px;
          }
          .live-pill {
            display: inline-block;
            border-radius: 999px;
            padding: 3px 10px;
            font-size: 0.8rem;
            font-weight: 700;
            margin-bottom: 8px;
          }
          .live-pill.ok {
            background: #dcfce7;
            color: #166534;
          }
          .live-pill.bad {
            background: #fee2e2;
            color: #991b1b;
          }
          .json-box {
            margin-top: 8px;
            background: #0f172a;
            color: #dbeafe;
            border-radius: 8px;
            padding: 10px;
            font-family: Consolas, "Courier New", monospace;
            font-size: 0.82rem;
            overflow-x: auto;
          }
          .proof-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
            gap: 10px;
            margin-top: 8px;
          }
          .proof-badge {
            display: inline-block;
            margin-top: 6px;
            border-radius: 999px;
            padding: 3px 9px;
            font-size: 0.78rem;
            font-weight: 700;
          }
          .proof-badge.ok {
            background: #dcfce7;
            color: #166534;
          }
          .proof-badge.bad {
            background: #fee2e2;
            color: #991b1b;
          }
          .btn {
            margin-top: 10px;
            border: 1px solid #1d4ed8;
            background: #1d4ed8;
            color: #fff;
            border-radius: 8px;
            padding: 8px 12px;
            font-weight: 600;
            cursor: pointer;
          }
          .btn:hover {
            filter: brightness(0.95);
          }
        </style>
      </head>
      <body>
        <main class="wrap">
          <span class="ok">Pipeline app is running</span>
          <h1>First Pipeline Challenge - Mission Control</h1>
          <p class="subtitle">Everything in one place: live status, endpoints, challenge requirements and submission checklist.</p>

          <section class="grid">
            <article class="card">
              <span class="badge">Project Links</span>
              <h2>Core Links</h2>
              <ul>
                <li><a href="${repoUrl}" target="_blank" rel="noreferrer">GitHub repository</a></li>
                <li><a href="${actionsUrl}" target="_blank" rel="noreferrer">GitHub Actions pipeline</a></li>
                <li><a href="${deployUrl}" target="_blank" rel="noreferrer">Railway production URL</a></li>
                <li><a href="${checklistUrl}" target="_blank" rel="noreferrer">Full challenge checklist file</a></li>
              </ul>
            </article>

            <article class="card">
              <span class="badge">Verification</span>
              <h2>API Endpoints</h2>
              <ul>
                <li><a href="${baseUrl}/status">${baseUrl}/status</a></li>
                <li><a href="${baseUrl}/health">${baseUrl}/health</a></li>
                <li><a href="${baseUrl}/metrics">${baseUrl}/metrics</a></li>
                <li><a href="${baseUrl}/metrics/prometheus">${baseUrl}/metrics/prometheus</a></li>
                <li><a href="${baseUrl}/k8s">${baseUrl}/k8s</a></li>
                <li><a href="${baseUrl}/db-status">${baseUrl}/db-status</a></li>
                <li><a href="${baseUrl}/mongo-proof">${baseUrl}/mongo-proof</a></li>
                <li><a href="${baseUrl}/secret">${baseUrl}/secret</a></li>
                <li><a href="${baseUrl}/coffee">${baseUrl}/coffee</a></li>
              </ul>
            </article>

            <article class="card">
              <span class="badge">Team</span>
              <h2>${teamName}</h2>
              <ul>
                ${teamMemberList}
              </ul>
            </article>

            <article class="card">
              <span class="badge">Live Service Stats</span>
              <h2>Runtime Snapshot</h2>
              <div class="status-grid">
                <div class="stat"><strong>${Math.floor(process.uptime())}s</strong>Uptime</div>
                <div class="stat"><strong>${metrics.totalRequests}</strong>Total Requests</div>
                <div class="stat"><strong>${averageResponseMs} ms</strong>Avg Response</div>
                <div class="stat"><strong>${now}</strong>Server Time (UTC)</div>
                <div class="stat"><strong>${mongoConnected ? "Connected" : "Memory only"}</strong>MongoDB persistence</div>
              </div>
            </article>

            <article class="card">
              <span class="badge">Kubernetes Evidence</span>
              <h2 class="${k8sStatusClass}">${k8sStatus}</h2>
              <ul>
                <li><strong>Pod:</strong> <span class="mono">${k8sInfo.podName}</span></li>
                <li><strong>Namespace:</strong> <span class="mono">${k8sInfo.podNamespace}</span></li>
                <li><strong>Node:</strong> <span class="mono">${k8sInfo.nodeName}</span></li>
                <li><strong>K8s API host:</strong> <span class="mono">${k8sInfo.kubernetesServiceHost}</span></li>
              </ul>
              <p class="small">Use <code>/k8s</code> for JSON proof during demo.</p>
            </article>

            <article class="card">
              <span class="badge">Live Checks</span>
              <h2>Status and Health</h2>
              <p class="small">Auto-refresh every 15 seconds. Uses the same host you opened this page from.</p>
              <div class="live-grid">
                <div class="stat">
                  <span id="status-pill" class="live-pill">Checking...</span>
                  <strong id="status-code">-</strong>Status endpoint
                  <div class="json-box" id="status-json">Loading /status...</div>
                </div>
                <div class="stat">
                  <span id="health-pill" class="live-pill">Checking...</span>
                  <strong id="health-code">-</strong>Health endpoint
                  <div class="json-box" id="health-json">Loading /health...</div>
                </div>
              </div>
            </article>

            <article class="card">
              <span class="badge">Teacher Demo</span>
              <h2>K8s + MongoDB Proof</h2>
              <p class="small">One-click demo: verify runtime in Kubernetes and prove MongoDB write/read.</p>
              <div class="proof-row">
                <div class="stat">
                  <strong id="proof-k8s-value">Checking...</strong>
                  Kubernetes runtime
                  <span id="proof-k8s-badge" class="proof-badge">...</span>
                </div>
                <div class="stat">
                  <strong id="proof-db-value">Checking...</strong>
                  MongoDB connection
                  <span id="proof-db-badge" class="proof-badge">...</span>
                </div>
                <div class="stat">
                  <strong id="proof-hits">0</strong>
                  Mongo proof counter
                  <span id="proof-mode" class="proof-badge">read</span>
                </div>
              </div>
              <button id="proof-run" class="btn" type="button">Run Mongo Proof (Write + Read)</button>
              <div class="json-box" id="proof-json">Loading proof data...</div>
            </article>
          </section>

          <section class="card section">
            <span class="badge">Challenge Progress</span>
            <h2>Implemented</h2>
            <ul class="task-list">
              <li><label class="task done"><input type="checkbox" checked disabled />GitHub Actions on push and PR</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Automated tests in CI</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Docker build in CI</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Trivy scan with SARIF upload</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Live deployment on Railway</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Green CI badge in README</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Health endpoint and metrics endpoint</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Prometheus metrics export endpoint</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Secret challenge endpoints and pipeline art</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Slack notifications for success and failure with commit details</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Staging and production deploy workflow</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Chaos restart job for staging</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />MongoDB StatefulSet deployed in Kubernetes</label></li>
              <li><label class="task done"><input type="checkbox" checked disabled />Secret-based configuration for database credentials</label></li>
            </ul>
          </section>

          <section class="grid section">
            <article class="card">
              <span class="badge">Submission</span>
              <h2>Hand-in Checklist</h2>
              <ul class="task-list">
                <li><label class="task done"><input type="checkbox" checked disabled />Team name and members</label></li>
                <li><label class="task done"><input type="checkbox" checked disabled />GitHub repository URL</label></li>
                <li><label class="task done"><input type="checkbox" checked disabled />Deployed application URL</label></li>
                <li><label class="task"><input type="checkbox" disabled />Screenshot of pipeline</label></li>
                <li><label class="task"><input type="checkbox" disabled />Screenshot of deployed app</label></li>
                <li><label class="task"><input type="checkbox" disabled />Optional: Trivy screenshot and architecture diagram</label></li>
              </ul>
            </article>

            <article class="card">
              <span class="badge">Quick Commands</span>
              <h2>Final Verification</h2>
              <pre>npm test
docker build -t first-pipeline:latest .
curl ${baseUrl}/status
curl ${baseUrl}/health
curl ${baseUrl}/metrics
curl ${baseUrl}/metrics/prometheus
curl ${baseUrl}/db-status
curl ${baseUrl}/mongo-proof
curl ${baseUrl}/secret</pre>
              <p class="small">For local Trivy report: <code>trivy-report.txt</code>.</p>
            </article>
          </section>

          <section class="card section">
            <span class="badge">Full Mission File</span>
            <h2>mission_challenges_checklist.txt</h2>
            <pre>${checklistText}</pre>
          </section>
        </main>
        <script>
          async function updateCheck(path, pillId, codeId, jsonId) {
            const pillEl = document.getElementById(pillId);
            const codeEl = document.getElementById(codeId);
            const jsonEl = document.getElementById(jsonId);

            try {
              const response = await fetch(path, { cache: "no-store" });
              const text = await response.text();
              let body = text;

              try {
                body = JSON.stringify(JSON.parse(text), null, 2);
              } catch (error) {}

              codeEl.textContent = "HTTP " + response.status;
              jsonEl.textContent = body;

              if (response.ok) {
                pillEl.textContent = "Healthy";
                pillEl.className = "live-pill ok";
              } else {
                pillEl.textContent = "Error";
                pillEl.className = "live-pill bad";
              }
            } catch (error) {
              codeEl.textContent = "No response";
              jsonEl.textContent = String(error.message || error);
              pillEl.textContent = "Offline";
              pillEl.className = "live-pill bad";
            }
          }

          function setProofBadge(id, ok, text) {
            const el = document.getElementById(id);
            el.textContent = text;
            el.className = ok ? "proof-badge ok" : "proof-badge bad";
          }

          async function refreshProofPanel() {
            const jsonEl = document.getElementById("proof-json");

            try {
              const [k8sRes, dbRes, proofRes] = await Promise.all([
                fetch("/k8s", { cache: "no-store" }),
                fetch("/db-status", { cache: "no-store" }),
                fetch("/mongo-proof?mode=read", { cache: "no-store" })
              ]);

              const k8s = await k8sRes.json();
              const db = await dbRes.json();
              const proof = await proofRes.json();

              document.getElementById("proof-k8s-value").textContent = k8s.inKubernetes ? "Detected" : "Not detected";
              setProofBadge("proof-k8s-badge", Boolean(k8s.inKubernetes), k8s.inKubernetes ? "OK" : "Missing");

              const dbOk = Boolean(db.mongoConfigured && db.mongoConnected);
              document.getElementById("proof-db-value").textContent = dbOk ? "Connected" : "Not connected";
              setProofBadge("proof-db-badge", dbOk, dbOk ? "OK" : "Missing");

              const hits = proof?.proof?.hits ?? 0;
              document.getElementById("proof-hits").textContent = String(hits);
              const mode = proof?.mode || "read";
              document.getElementById("proof-mode").textContent = mode;
              document.getElementById("proof-mode").className = mode === "write" ? "proof-badge ok" : "proof-badge";

              jsonEl.textContent = JSON.stringify({ k8s, db, proof }, null, 2);
            } catch (error) {
              jsonEl.textContent = String(error.message || error);
              setProofBadge("proof-k8s-badge", false, "Error");
              setProofBadge("proof-db-badge", false, "Error");
            }
          }

          async function runMongoProof() {
            const button = document.getElementById("proof-run");
            const jsonEl = document.getElementById("proof-json");

            button.disabled = true;
            button.textContent = "Running proof...";
            try {
              const response = await fetch("/mongo-proof", { cache: "no-store" });
              const proof = await response.json();
              jsonEl.textContent = JSON.stringify(proof, null, 2);
              if (proof?.proof?.hits !== undefined) {
                document.getElementById("proof-hits").textContent = String(proof.proof.hits);
              }
              document.getElementById("proof-mode").textContent = proof?.mode || "write";
              document.getElementById("proof-mode").className = response.ok ? "proof-badge ok" : "proof-badge bad";
            } catch (error) {
              jsonEl.textContent = String(error.message || error);
              document.getElementById("proof-mode").textContent = "error";
              document.getElementById("proof-mode").className = "proof-badge bad";
            } finally {
              button.disabled = false;
              button.textContent = "Run Mongo Proof (Write + Read)";
              refreshProofPanel();
            }
          }

          function refreshLiveChecks() {
            updateCheck("/status", "status-pill", "status-code", "status-json");
            updateCheck("/health", "health-pill", "health-code", "health-json");
          }

          document.getElementById("proof-run").addEventListener("click", runMongoProof);
          refreshLiveChecks();
          refreshProofPanel();
          setInterval(refreshLiveChecks, 15000);
          setInterval(refreshProofPanel, 15000);
        </script>
      </body>
    </html>
  `);
});

if (require.main === module) {
  (async () => {
    await initMongoIfConfigured();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })();
}

module.exports = app;
