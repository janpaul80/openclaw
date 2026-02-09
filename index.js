import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Microsoft Copilot Studio configuration
// SECRET_KEY: The bot secret from Copilot Studio > Settings > Security > Web channel security
// ENDPOINT: The token endpoint URL from Copilot Studio > Settings > Channels > Mobile app
// BOT_ID: The bot ID from Copilot Studio > Bot details
const MICROSOFT_STUDIO_SECRET_KEY = process.env.MICROSOFT_STUDIO_SECRET_KEY || "";
const MICROSOFT_STUDIO_ENDPOINT = process.env.MICROSOFT_STUDIO_ENDPOINT || "";
const MICROSOFT_STUDIO_BOT_ID = process.env.MICROSOFT_STUDIO_BOT_ID || "";

// Startup logging
console.log("========================================");
console.log("OpenClaw Orchestrator Starting...");
console.log("========================================");
console.log(`PORT: ${PORT}`);
console.log(`HOST: ${HOST}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || "development"}`);
console.log(`Microsoft Studio Secret: ${MICROSOFT_STUDIO_SECRET_KEY ? "SET ✓" : "NOT SET ✗"}`);
console.log(`Microsoft Studio Endpoint: ${MICROSOFT_STUDIO_ENDPOINT ? "SET ✓" : "NOT SET ✗"}`);
console.log(`Microsoft Studio Bot ID: ${MICROSOFT_STUDIO_BOT_ID ? "SET ✓" : "NOT SET ✗"}`);
console.log("========================================");

app.use(express.json());

// In-memory conversation cache (for session continuity)
const conversationCache = new Map();

/**
 * Determine if Copilot Studio is fully configured
 */
function isCopilotConfigured() {
  return !!(MICROSOFT_STUDIO_SECRET_KEY && MICROSOFT_STUDIO_ENDPOINT);
}

/**
 * Extract the Direct Line base URL from the token endpoint
 * Token endpoint format: https://default{env}.{region}.environment.api.powerplatform.com/powervirtualagents/botsbyschema/{schema}/directline/token?api-version=...
 * Direct Line base: derived from the token response or use regional endpoint
 */
function getDirectLineBaseUrl(tokenEndpoint) {
  // Try to extract region from the token endpoint URL
  // Format: https://default{env}.{region}.environment.api.powerplatform.com/...
  try {
    const url = new URL(tokenEndpoint);
    const hostParts = url.hostname.split(".");
    // hostParts: [default{env}, {region}, environment, api, powerplatform, com]
    if (hostParts.length >= 2) {
      const region = hostParts[1];
      // Map Power Platform regions to Direct Line regions
      const regionMap = {
        "unitedstates": "directline.botframework.com",
        "europe": "europe.directline.botframework.com",
        "asia": "asia.directline.botframework.com",
        "india": "india.directline.botframework.com",
        "australia": "australia.directline.botframework.com",
        "unitedkingdom": "unitedkingdom.directline.botframework.com",
        "japan": "japan.directline.botframework.com",
        "canada": "canada.directline.botframework.com",
        "france": "france.directline.botframework.com",
        "germany": "germany.directline.botframework.com",
        "switzerland": "switzerland.directline.botframework.com",
        "norway": "norway.directline.botframework.com",
        "southamerica": "southamerica.directline.botframework.com",
        "uae": "uae.directline.botframework.com",
        "southafrica": "southafrica.directline.botframework.com",
        "korea": "korea.directline.botframework.com",
        "singapore": "singapore.directline.botframework.com"
      };
      if (regionMap[region]) {
        return `https://${regionMap[region]}/v3/directline`;
      }
    }
  } catch (e) {
    console.warn("[OpenClaw] Could not parse token endpoint URL for region:", e.message);
  }
  // Default fallback
  return "https://directline.botframework.com/v3/directline";
}

/**
 * Get a Direct Line token from the Copilot Studio token endpoint
 */
async function getDirectLineToken() {
  console.log(`[OpenClaw] Requesting Direct Line token from Copilot Studio endpoint...`);
  
  const response = await fetch(MICROSOFT_STUDIO_ENDPOINT, {
    method: "GET",
    headers: {
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token endpoint returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  console.log(`[OpenClaw] Token received, conversationId: ${data.conversationId || "N/A"}`);
  return data;
}

/**
 * Get or create a Direct Line conversation
 */
async function getOrCreateConversation(sessionId) {
  // Check cache first
  if (conversationCache.has(sessionId)) {
    const cached = conversationCache.get(sessionId);
    // Check if conversation is still valid (less than 25 minutes old - tokens expire at 30 min)
    if (Date.now() - cached.createdAt < 25 * 60 * 1000) {
      return cached;
    }
    // Expired, remove from cache
    conversationCache.delete(sessionId);
    console.log(`[OpenClaw] Conversation expired for session: ${sessionId}`);
  }

  // Get token from Copilot Studio token endpoint
  const tokenData = await getDirectLineToken();
  
  // The token endpoint returns: { token, conversationId, ... }
  // Use the token to start/continue a conversation
  const directLineBase = getDirectLineBaseUrl(MICROSOFT_STUDIO_ENDPOINT);
  
  let conversation;
  
  if (tokenData.conversationId) {
    // Token endpoint already created a conversation
    conversation = {
      conversationId: tokenData.conversationId,
      token: tokenData.token,
      directLineBase: directLineBase,
      createdAt: Date.now(),
      watermark: null
    };
  } else {
    // Need to create a conversation using the token
    const convResponse = await fetch(`${directLineBase}/conversations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tokenData.token}`,
        "Content-Type": "application/json"
      }
    });

    if (!convResponse.ok) {
      const errorText = await convResponse.text();
      throw new Error(`Failed to create conversation: ${convResponse.status} - ${errorText}`);
    }

    const convData = await convResponse.json();
    conversation = {
      conversationId: convData.conversationId,
      token: convData.token || tokenData.token,
      directLineBase: directLineBase,
      createdAt: Date.now(),
      watermark: null
    };
  }

  // Cache the conversation
  conversationCache.set(sessionId, conversation);
  console.log(`[OpenClaw] Conversation ready: ${conversation.conversationId} for session: ${sessionId}`);

  return conversation;
}

/**
 * Send a message to the bot and get the response
 */
async function sendMessageAndGetResponse(conversation, message, platform = "web", mode = "Agents") {
  const { conversationId, token, directLineBase } = conversation;

  // Build the activity with context
  const activity = {
    type: "message",
    from: { id: "openclaw-user", name: "HeftCoder User" },
    text: message,
    channelData: {
      platform: platform,
      mode: mode,
      source: "openclaw-orchestrator"
    }
  };

  // Send the message
  const sendResponse = await fetch(`${directLineBase}/conversations/${conversationId}/activities`, {
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
    // Wait before polling
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Get activities
    const activitiesUrl = watermark 
      ? `${directLineBase}/conversations/${conversationId}/activities?watermark=${watermark}`
      : `${directLineBase}/conversations/${conversationId}/activities`;

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
      a => a.from.id !== "openclaw-user" && a.type === "message" && a.text
    );

    if (botActivities.length > 0) {
      // Return the last bot response
      const lastResponse = botActivities[botActivities.length - 1];
      console.log(`[OpenClaw] Received response from bot (${lastResponse.from.id})`);
      return {
        content: lastResponse.text,
        activityId: lastResponse.id,
        timestamp: lastResponse.timestamp,
        from: lastResponse.from
      };
    }
  }

  throw new Error("Timeout waiting for bot response (60s)");
}

// ============================================================
// ROUTES
// ============================================================

// Health endpoint - CRITICAL for Coolify
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "openclaw",
    version: "1.1.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    microsoftStudio: {
      configured: isCopilotConfigured(),
      secretSet: !!MICROSOFT_STUDIO_SECRET_KEY,
      endpointSet: !!MICROSOFT_STUDIO_ENDPOINT,
      botIdSet: !!MICROSOFT_STUDIO_BOT_ID,
      status: isCopilotConfigured() ? "ready" : "incomplete_config"
    }
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "openclaw",
    status: "running",
    version: "1.1.0",
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
    version: "1.1.0",
    config: {
      MICROSOFT_STUDIO_SECRET_KEY: MICROSOFT_STUDIO_SECRET_KEY ? `SET (${MICROSOFT_STUDIO_SECRET_KEY.length} chars)` : "NOT SET",
      MICROSOFT_STUDIO_ENDPOINT: MICROSOFT_STUDIO_ENDPOINT ? `SET (${MICROSOFT_STUDIO_ENDPOINT.substring(0, 50)}...)` : "NOT SET",
      MICROSOFT_STUDIO_BOT_ID: MICROSOFT_STUDIO_BOT_ID || "NOT SET",
      PORT: PORT,
      NODE_ENV: process.env.NODE_ENV || "development"
    },
    requirements: {
      "MICROSOFT_STUDIO_SECRET_KEY": !!MICROSOFT_STUDIO_SECRET_KEY ? "✓" : "✗ REQUIRED",
      "MICROSOFT_STUDIO_ENDPOINT": !!MICROSOFT_STUDIO_ENDPOINT ? "✓" : "✗ REQUIRED - Get from Copilot Studio > Settings > Channels > Mobile app",
      "MICROSOFT_STUDIO_BOT_ID": !!MICROSOFT_STUDIO_BOT_ID ? "✓" : "○ OPTIONAL"
    }
  });
});

// Agent invocation endpoint
app.post("/agents/invoke", async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Check if Copilot Studio is configured
    if (!isCopilotConfigured()) {
      const missing = [];
      if (!MICROSOFT_STUDIO_SECRET_KEY) missing.push("MICROSOFT_STUDIO_SECRET_KEY");
      if (!MICROSOFT_STUDIO_ENDPOINT) missing.push("MICROSOFT_STUDIO_ENDPOINT");
      
      return res.status(503).json({
        error: "Microsoft Copilot Studio not fully configured",
        message: `Missing environment variables: ${missing.join(", ")}`,
        help: "Set MICROSOFT_STUDIO_ENDPOINT to the token endpoint URL from Copilot Studio > Settings > Channels > Mobile app",
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
    
    console.log(`[OpenClaw] Invoking agent for session: ${session}`);
    console.log(`[OpenClaw] Platform: ${platform || "web"}, Mode: ${mode || "Agents"}`);
    console.log(`[OpenClaw] Prompt: ${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}`);

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
        timestamp: response.timestamp,
        botId: response.from?.id || MICROSOFT_STUDIO_BOT_ID
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
  console.log(`✅ OpenClaw v1.1.0 running on http://${HOST}:${PORT}`);
  console.log(`✅ Health check: http://${HOST}:${PORT}/health`);
  console.log(`✅ Config status: http://${HOST}:${PORT}/config/status`);
  console.log(`✅ Copilot Studio: ${isCopilotConfigured() ? "FULLY CONFIGURED" : "INCOMPLETE - see /config/status"}`);
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
