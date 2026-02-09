import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Microsoft Copilot Studio configuration
// SECRET_KEY: The bot secret from Copilot Studio > Settings > Security > Web channel security
// This secret is used directly with the Direct Line API (no token endpoint needed)
const MICROSOFT_STUDIO_SECRET_KEY = process.env.MICROSOFT_STUDIO_SECRET_KEY || "";
const DIRECT_LINE_BASE = "https://directline.botframework.com/v3/directline";

// Startup logging
console.log("========================================");
console.log("OpenClaw Orchestrator v2.0.0 Starting...");
console.log("========================================");
console.log(`PORT: ${PORT}`);
console.log(`HOST: ${HOST}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || "development"}`);
console.log(`Microsoft Studio Secret: ${MICROSOFT_STUDIO_SECRET_KEY ? `SET ✓ (${MICROSOFT_STUDIO_SECRET_KEY.length} chars)` : "NOT SET ✗"}`);
console.log(`Direct Line Base: ${DIRECT_LINE_BASE}`);
console.log("========================================");

app.use(express.json());

// In-memory conversation cache (for session continuity)
const conversationCache = new Map();

/**
 * Determine if Copilot Studio is configured
 * Only the secret is required - it authenticates directly with Direct Line
 */
function isCopilotConfigured() {
  return !!MICROSOFT_STUDIO_SECRET_KEY;
}

/**
 * Create a new Direct Line conversation using the bot secret
 */
async function createConversation() {
  console.log(`[OpenClaw] Creating new Direct Line conversation...`);

  const response = await fetch(`${DIRECT_LINE_BASE}/conversations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MICROSOFT_STUDIO_SECRET_KEY}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create conversation: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  console.log(`[OpenClaw] Conversation created: ${data.conversationId}`);
  return data;
}

/**
 * Get or create a Direct Line conversation for a session
 */
async function getOrCreateConversation(sessionId) {
  // Check cache first
  if (conversationCache.has(sessionId)) {
    const cached = conversationCache.get(sessionId);
    // Check if conversation is still valid (less than 25 minutes old - tokens expire at 30 min)
    if (Date.now() - cached.createdAt < 25 * 60 * 1000) {
      console.log(`[OpenClaw] Reusing cached conversation: ${cached.conversationId} for session: ${sessionId}`);
      return cached;
    }
    // Expired, remove from cache
    conversationCache.delete(sessionId);
    console.log(`[OpenClaw] Conversation expired for session: ${sessionId}`);
  }

  // Create a new conversation
  const convData = await createConversation();

  const conversation = {
    conversationId: convData.conversationId,
    token: convData.token,
    createdAt: Date.now(),
    watermark: null
  };

  // Cache the conversation
  conversationCache.set(sessionId, conversation);
  console.log(`[OpenClaw] Conversation cached: ${conversation.conversationId} for session: ${sessionId}`);

  return conversation;
}

/**
 * Send a message to the bot and poll for the response
 */
async function sendMessageAndGetResponse(conversation, message) {
  const { conversationId, token } = conversation;

  // Build the activity
  const activity = {
    type: "message",
    from: { id: "openclaw-user", name: "HeftCoder User" },
    text: message
  };

  // Send the message using the conversation token
  const sendResponse = await fetch(`${DIRECT_LINE_BASE}/conversations/${conversationId}/activities`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(activity)
  });

  if (!sendResponse.ok) {
    const errorText = await sendResponse.text();
    throw new Error(`Failed to send message: ${sendResponse.status} - ${errorText}`);
  }

  const sendResult = await sendResponse.json();
  console.log(`[OpenClaw] Sent message, activity ID: ${sendResult.id}`);

  // Poll for bot response (with timeout)
  const startTime = Date.now();
  const timeout = 60000; // 60 seconds timeout
  let watermark = conversation.watermark;
  let pollCount = 0;

  while (Date.now() - startTime < timeout) {
    // Wait before polling (start with 1s, increase to 2s after 5 polls)
    const pollDelay = pollCount < 5 ? 1000 : 2000;
    await new Promise(resolve => setTimeout(resolve, pollDelay));
    pollCount++;

    // Get activities since last watermark
    const activitiesUrl = watermark
      ? `${DIRECT_LINE_BASE}/conversations/${conversationId}/activities?watermark=${watermark}`
      : `${DIRECT_LINE_BASE}/conversations/${conversationId}/activities`;

    const activitiesResponse = await fetch(activitiesUrl, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    if (!activitiesResponse.ok) {
      console.error(`[OpenClaw] Failed to get activities: ${activitiesResponse.status}`);
      continue;
    }

    const activitiesData = await activitiesResponse.json();
    watermark = activitiesData.watermark;
    conversation.watermark = watermark;

    // Find bot responses (activities NOT from our user, with text content)
    const botActivities = activitiesData.activities.filter(
      a => a.from.id !== "openclaw-user" && a.type === "message" && a.text
    );

    if (botActivities.length > 0) {
      // Return the last bot response
      const lastResponse = botActivities[botActivities.length - 1];
      console.log(`[OpenClaw] Bot response received from: ${lastResponse.from.name || lastResponse.from.id} (poll #${pollCount})`);
      return {
        content: lastResponse.text,
        activityId: lastResponse.id,
        timestamp: lastResponse.timestamp,
        from: lastResponse.from,
        textFormat: lastResponse.textFormat || "plain"
      };
    }
  }

  throw new Error("Timeout waiting for bot response (60s)");
}

// ============================================================
// ROUTES
// ============================================================

// Health endpoint - CRITICAL for Coolify health checks
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "openclaw",
    version: "2.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    microsoftStudio: {
      configured: isCopilotConfigured(),
      secretSet: !!MICROSOFT_STUDIO_SECRET_KEY,
      directLineBase: DIRECT_LINE_BASE,
      status: isCopilotConfigured() ? "ready" : "missing_secret"
    },
    activeSessions: conversationCache.size
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "openclaw",
    status: "running",
    version: "2.0.0",
    endpoints: ["/health", "/agents/invoke", "/config/status"],
    microsoftStudio: {
      configured: isCopilotConfigured()
    }
  });
});

// Configuration status endpoint (for debugging)
app.get("/config/status", (req, res) => {
  res.json({
    service: "openclaw",
    version: "2.0.0",
    config: {
      MICROSOFT_STUDIO_SECRET_KEY: MICROSOFT_STUDIO_SECRET_KEY ? `SET (${MICROSOFT_STUDIO_SECRET_KEY.length} chars)` : "NOT SET",
      DIRECT_LINE_BASE: DIRECT_LINE_BASE,
      PORT: PORT,
      NODE_ENV: process.env.NODE_ENV || "development"
    },
    requirements: {
      "MICROSOFT_STUDIO_SECRET_KEY": !!MICROSOFT_STUDIO_SECRET_KEY ? "✓ SET" : "✗ REQUIRED - Get from Copilot Studio > Settings > Security > Web channel security"
    },
    activeSessions: conversationCache.size
  });
});

// Agent invocation endpoint - the core orchestrator function
app.post("/agents/invoke", async (req, res) => {
  const startTime = Date.now();

  try {
    // Check if Copilot Studio is configured
    if (!isCopilotConfigured()) {
      return res.status(503).json({
        error: "Microsoft Copilot Studio not configured",
        message: "Missing MICROSOFT_STUDIO_SECRET_KEY environment variable",
        help: "Set MICROSOFT_STUDIO_SECRET_KEY to the bot secret from Copilot Studio > Settings > Security > Web channel security",
        configured: false
      });
    }

    const { prompt, sessionId, platform, mode, conversationHistory } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: "Missing required field: prompt",
        usage: {
          method: "POST",
          body: {
            prompt: "Your message (required)",
            sessionId: "Optional session ID for conversation continuity",
            platform: "web | ios | android (optional, default: web)",
            mode: "Agents | Plan (optional, default: Agents)"
          }
        }
      });
    }

    // Use sessionId or generate one
    const session = sessionId || `session-${Date.now()}`;

    console.log(`[OpenClaw] === Invoke Request ===`);
    console.log(`[OpenClaw] Session: ${session}`);
    console.log(`[OpenClaw] Platform: ${platform || "web"}, Mode: ${mode || "Agents"}`);
    console.log(`[OpenClaw] Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}`);

    // Get or create conversation
    const conversation = await getOrCreateConversation(session);

    // Send message and get response
    const response = await sendMessageAndGetResponse(conversation, prompt);

    const duration = Date.now() - startTime;
    console.log(`[OpenClaw] === Response in ${duration}ms ===`);

    res.json({
      success: true,
      content: response.content,
      textFormat: response.textFormat,
      sessionId: session,
      conversationId: conversation.conversationId,
      metadata: {
        platform: platform || "web",
        mode: mode || "Agents",
        duration: duration,
        activityId: response.activityId,
        timestamp: response.timestamp,
        botName: response.from?.name || "Copilot Studio Agent",
        botId: response.from?.id
      }
    });

  } catch (error) {
    console.error(`[OpenClaw] Error invoking agent:`, error.message);

    const duration = Date.now() - startTime;

    res.status(500).json({
      success: false,
      error: error.message,
      duration: duration
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const server = app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(`✅ OpenClaw v2.0.0 running on http://${HOST}:${PORT}`);
  console.log(`✅ Health check: http://${HOST}:${PORT}/health`);
  console.log(`✅ Copilot Studio: ${isCopilotConfigured() ? "CONFIGURED ✓" : "NOT CONFIGURED ✗"}`);
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
