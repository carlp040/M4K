const http = require("http");
const app = require("./index.js");

function requestStatus() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: 3000,
        path: "/status",
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
    const { statusCode, data } = await requestStatus();
    const json = JSON.parse(data);

    if (statusCode !== 200) {
      throw new Error(`Expected HTTP 200, got ${statusCode}`);
    }
    if (json.status !== "ok") {
      throw new Error("Status endpoint returned wrong payload");
    }
    if (!json.timestamp) {
      throw new Error("Missing timestamp in response");
    }

    console.log("PASS: Status endpoint test passed");
    server.close(() => process.exit(0));
  } catch (error) {
    console.error(`FAIL: Test failed: ${error.message}`);
    server.close(() => process.exit(1));
  }
}

run();
