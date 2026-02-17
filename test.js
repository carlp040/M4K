const http = require("http");
const app = require("./index.js");

function requestPath(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: 3000,
        path,
        method: "GET"
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, data }));
      }
    );

    req.on("error", reject);
    req.end();
  });
}

async function run() {
  console.log("Running tests...");

  const server = app.listen(3000);

  try {
    const { statusCode, data } = await requestPath("/status");
    const statusJson = JSON.parse(data);

    if (statusCode !== 200) {
      throw new Error(`Expected HTTP 200, got ${statusCode}`);
    }
    if (statusJson.status !== "ok") {
      throw new Error("Status endpoint returned wrong payload");
    }
    if (!statusJson.timestamp) {
      throw new Error("Missing timestamp in response");
    }

    const metricsResponse = await requestPath("/metrics");
    const metricsJson = JSON.parse(metricsResponse.data);

    if (metricsResponse.statusCode !== 200) {
      throw new Error(`Expected /metrics HTTP 200, got ${metricsResponse.statusCode}`);
    }
    if (typeof metricsJson.totalRequests !== "number" || metricsJson.totalRequests < 1) {
      throw new Error("Metrics endpoint missing valid totalRequests");
    }
    if (typeof metricsJson.averageResponseMs !== "number") {
      throw new Error("Metrics endpoint missing averageResponseMs");
    }
    if (
      !metricsJson.routeMetrics ||
      !metricsJson.routeMetrics["/status"] ||
      metricsJson.routeMetrics["/status"].requests < 1
    ) {
      throw new Error("Metrics endpoint missing /status route metrics");
    }

    const prometheusResponse = await requestPath("/metrics/prometheus");
    if (prometheusResponse.statusCode !== 200) {
      throw new Error(`Expected /metrics/prometheus HTTP 200, got ${prometheusResponse.statusCode}`);
    }
    if (!prometheusResponse.data.includes("pipeline_total_requests")) {
      throw new Error("Prometheus metrics missing pipeline_total_requests");
    }
    if (!prometheusResponse.data.includes("pipeline_average_response_ms")) {
      throw new Error("Prometheus metrics missing pipeline_average_response_ms");
    }

    console.log("PASS: Status endpoint test passed");
    console.log("PASS: Metrics endpoint test passed");
    console.log("PASS: Prometheus metrics endpoint test passed");
    server.close(() => process.exit(0));
  } catch (error) {
    console.error(`FAIL: Test failed: ${error.message}`);
    server.close(() => process.exit(1));
  }
}

run();
