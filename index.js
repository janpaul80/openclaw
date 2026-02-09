import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "openclaw",
    uptime: process.uptime()
  });
});

app.post("/agents/invoke", (req, res) => {
  res.status(501).json({
    error: "OpenClaw orchestrator not implemented yet"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🧠 OpenClaw running on port ${PORT}`);
});
