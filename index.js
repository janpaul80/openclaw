import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Startup logging
console.log("========================================");
console.log("OpenClaw Orchestrator Starting...");
console.log("========================================");
console.log(`PORT: ${PORT}`);
console.log(`HOST: ${HOST}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || "development"}`);
console.log("========================================");

app.use(express.json());

// Health endpoint - CRITICAL for Coolify
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "openclaw",
    version: "0.1.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "openclaw",
    status: "running",
    endpoints: ["/health", "/agents/invoke"]
  });
});

// Placeholder for agent invocation (to be implemented later)
app.post("/agents/invoke", (req, res) => {
  res.status(501).json({
    error: "OpenClaw orchestrator not implemented yet",
    message: "This endpoint will be wired to Microsoft Copilot Studio"
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const server = app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(`✅ OpenClaw running on http://${HOST}:${PORT}`);
  console.log(`✅ Health check: http://${HOST}:${PORT}/health`);
  console.log("========================================");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
