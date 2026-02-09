import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Microsoft Copilot Studio Direct Line configuration
const MICROSOFT_STUDIO_SECRET_KEY = process.env.MICROSOFT_STUDIO_SECRET_KEY || "";
const DIRECTLINE_BASE_URL = "https://directline.botframework.com/v3/directline";

// Startup logging
console.log("========================================");
console.log("OpenClaw Orchestrator Starting...");
console.log("========================================");
console.log(`PORT: ${PORT}`);
console.log(`HOST: ${HOST}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || "development"}`);
console.log(`Microsoft Studio Secret: ${MICROSOFT_STUDIO_SECRET_KEY ? "SET ✓" : "NOT SET ✗"}`);
console.log("========================================");

app.use(express.json());

// In-memory conversation cache (for session continuity)
const conversationCache = new Map();

/**
 * Get or create a Direct Line conversation
 */
async function getOrCreateConversation(sessionId) {
  // Check cache first
  if (conversationCache.has(sessionId)) {
    const cached = conversationCache.get(sessionId);
    // Check if conversation is still valid (less than 30 minutes old)
    if (Date.now() - cached.createdAt < 30 * 60 * 1000) {
      return cached;
    }
    // Expired, remove from cache
    conversationCache.delete(sessionId);
  }

  // Create new conversation
  const response = await fetch(`${DIRECTLINE_BASE_URL}/conversations`, {
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
  const conversation = {
    conversationId: data.conversationId,
    token: data.token,
    streamUrl: data.streamUrl,
    createdAt: Date.now(),
    watermark: null
  };

  // Cache the conversation
  conversationCache.set(sessionId, conversation);
  console.log(`[OpenClaw] Created new conversation: ${data.conversationId} for session: ${sessionId}`);

  return conversation;
}

/**
 * Send a message to the bot and get the response
 */
async function sendMessageAndGetResponse(conversation, message, platform = "web", mode = "Agents") {
  const { conversationId, token } = conversation;

  // Build the activity with context
  const activity = {
    type: "message",
    from: { id: "user", name: "HeftCoder User" },
    text: message,
    channelData: {
      platform: platform,
      mode: mode,
      source: "openclaw-orchestrator"
    }
  };

  // Send the message
  const sendResponse = await fetch(`${DIRECTLINE_BASE_URL}/conversations/${conversationId}/activities`, {
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

  // Poll for response (with timeout)
  const startTime = Date.now();
  const timeout = 60000; // 60 seconds timeout
  let watermark = conversation.watermark;

  while (Date.now() - startTime < timeout) {
    // Wait a bit before polling
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Get activities
    const activitiesUrl = watermark 
      ? `${DIRECTLINE_BASE_URL}/conversations/${conversationId}/activities?watermark=${watermark}`
      : `${DIRECTLINE_BASE_URL}/conversations/${conversationId}/activities`;

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

    // Find bot responses (activities from the bot, not the user)
    const botActivities = activitiesData.activities.filter(
      a => a.from.id !== "user" && a.type === "message" && a.text
    );

    if (botActivities.length > 0) {
      // Return the last bot response
      const lastResponse = botActivities[botActivities.length - 1];
      console.log(`[OpenClaw] Received response from bot`);
      return {
        content: lastResponse.text,
        activityId: lastResponse.id,
        timestamp: lastResponse.timestamp
      };
    }
  }

  throw new Error("Timeout waiting for bot response");
}

// Health endpoint - CRITICAL for Coolify
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "openclaw",
    version: "1.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    microsoftStudio: {
      configured: !!MICROSOFT_STUDIO_SECRET_KEY,
      status: MICROSOFT_STUDIO_SECRET_KEY ? "ready" : "not_configured"
    }
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "openclaw",
    status: "running",
    version: "1.0.0",
    endpoints: ["/health", "/agents/invoke"],
    microsoftStudio: {
      configured: !!MICROSOFT_STUDIO_SECRET_KEY
    }
  });
});

// Agent invocation endpoint
app.post("/agents/invoke", async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Check if Microsoft Studio is configured
    if (!MICROSOFT_STUDIO_SECRET_KEY) {
      return res.status(503).json({
        error: "Microsoft Copilot Studio not configured",
        message: "Please set MICROSOFT_STUDIO_SECRET_KEY environment variable",
        configured: false
      });
    }

    const { prompt, sessionId, platform, mode, conversationHistory } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: "Missing required field: prompt"
      });
    }

    // Use sessionId or generate one
    const session = sessionId || `session-${Date.now()}`;
    
    console.log(`[OpenClaw] Invoking agent for session: ${session}`);
    console.log(`[OpenClaw] Platform: ${platform || "web"}, Mode: ${mode || "Agents"}`);
    console.log(`[OpenClaw] Prompt: ${prompt.substring(0, 100)}...`);

    // Get or create conversation
    const conversation = await getOrCreateConversation(session);

    // Build the full message with context
    let fullMessage = prompt;
    
    // Add platform/mode context if provided
    if (platform || mode) {
      const contextPrefix = `[Context: Platform=${platform || "web"}, Mode=${mode || "Agents"}]\n\n`;
      fullMessage = contextPrefix + prompt;
    }

    // Send message and get response
    const response = await sendMessageAndGetResponse(
      conversation, 
      fullMessage, 
      platform || "web", 
      mode || "Agents"
    );

    const duration = Date.now() - startTime;
    console.log(`[OpenClaw] Response received in ${duration}ms`);

    res.json({
      success: true,
      content: response.content,
      sessionId: session,
      conversationId: conversation.conversationId,
      metadata: {
        platform: platform || "web",
        mode: mode || "Agents",
        duration: duration,
        activityId: response.activityId,
        timestamp: response.timestamp
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
  console.error("Error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const server = app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(`✅ OpenClaw running on http://${HOST}:${PORT}`);
  console.log(`✅ Health check: http://${HOST}:${PORT}/health`);
  console.log(`✅ Microsoft Studio: ${MICROSOFT_STUDIO_SECRET_KEY ? "Configured" : "Not Configured"}`);
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
