const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

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
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/", (req, res) => {
  res.send("First Pipeline Challenge - Week 4");
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
