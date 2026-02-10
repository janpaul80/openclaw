
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ============================================================
// DUAL PROVIDER CONFIGURATION
// ============================================================
// Provider 1: Microsoft Copilot Studio (PRIMARY - Planning/Supervision)
const MICROSOFT_STUDIO_SECRET_KEY = process.env.MICROSOFT_STUDIO_SECRET_KEY || "";
const DIRECT_LINE_BASE = process.env.DIRECT_LINE_BASE || "https://europe.directline.botframework.com/v3/directline";

// Provider 2: Qwen via Ollama (SECONDARY - Execution/Building)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:14b";

// ============================================================
// Agent Role → Provider Routing
// ============================================================
// Microsoft Copilot Studio: 7 supervisory agents (brain & orchestrator)
// These agents PLAN, COORDINATE, and SUPERVISE — they do NOT generate bulk code
const MICROSOFT_ROLES = ["planner", "frontend", "backend", "devops", "qa", "android", "ios"];

// Microsoft role display names (matching Copilot Studio exactly)
const MICROSOFT_ROLE_NAMES = {
  planner: "Planning Architect",
  frontend: "Frontend Engineer",
  backend: "Backend Agent",
  devops: "DevOps Agent",
  qa: "QA Agent Specialist",
  android: "Android Agent",
  ios: "iOS Agent"
};

// Qwen via Ollama: execution muscle (bulk code generation, installs, fixes)
const QWEN_ROLES = ["builder", "installer", "fixer", "coder", "executor"];

function getProviderForRole(role) {
  const normalizedRole = (role || "").toLowerCase();
  if (MICROSOFT_ROLES.includes(normalizedRole)) {
    return "microsoft";
  }
  if (QWEN_ROLES.includes(normalizedRole)) {
    return "qwen";
  }
  // Fuzzy matching for aliases
  if (normalizedRole.includes("plan") || normalizedRole.includes("architect")) return "microsoft";
  if (normalizedRole.includes("front")) return "microsoft";
  if (normalizedRole.includes("back")) return "microsoft";
  if (normalizedRole.includes("devops") || normalizedRole.includes("deploy")) return "microsoft";
  if (normalizedRole.includes("qa") || normalizedRole.includes("test") || normalizedRole.includes("quality")) return "microsoft";
  if (normalizedRole.includes("android") || normalizedRole.includes("mobile")) return "microsoft";
  if (normalizedRole.includes("ios") || normalizedRole.includes("apple") || normalizedRole.includes("swift")) return "microsoft";
  if (normalizedRole.includes("build") || normalizedRole.includes("code") || normalizedRole.includes("install") || normalizedRole.includes("fix")) return "qwen";
  // Default: unknown roles go to Qwen for execution
  return "qwen";
}

// ============================================================
// Startup Logging
// ============================================================
console.log("========================================");
console.log("OpenClaw Orchestrator v3.1.0 Starting...");
console.log("  DUAL PROVIDER Architecture");
console.log("========================================");
console.log(`PORT: ${PORT}`);
console.log(`HOST: ${HOST}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || "development"}`);
console.log("--- Provider 1: Microsoft Copilot Studio ---");
console.log(`  Secret: ${MICROSOFT_STUDIO_SECRET_KEY ? `SET ✓ (${MICROSOFT_STUDIO_SECRET_KEY.length} chars)` : "NOT SET ✗"}`);
console.log(`  Direct Line: ${DIRECT_LINE_BASE}`);
console.log(`  Roles: ${MICROSOFT_ROLES.map(r => MICROSOFT_ROLE_NAMES[r] || r).join(", ")}`);
console.log("--- Provider 2: Qwen via Ollama ---");
console.log(`  Base URL: ${OLLAMA_BASE_URL}`);
console.log(`  Model: ${OLLAMA_MODEL}`);
console.log(`  Roles: ${QWEN_ROLES.join(", ")}`);
console.log("========================================");

app.use(express.json({ limit: "10mb" }));

// ============================================================
// Agent System Prompts (for Qwen execution agents only)
// Microsoft agents use their own prompts configured in Copilot Studio
// ============================================================
const QWEN_AGENT_PROMPTS = {
  builder: `You are the Builder Agent for HeftCoder, a vibe-coding platform.

YOUR ROLE: Generate complete, production-ready, multi-file code based on an APPROVED PLAN.

CRITICAL OUTPUT FORMATTING RULES:
1. Do NOT wrap code in bordered boxes, clipped containers, or scrollable UI elements
2. Code must appear as free-flowing text with NO borders, NO clipping, NO scrollbars
3. Before EACH code file, include a "Code Summary" explaining what the code does
4. After EACH code file, include a "How to Run" section with exact commands
5. At the TOP of each code file, include the file path as a comment (e.g., // backend/src/index.ts)

CODE GENERATION RULES:
- Generate 400+ lines of real, working code
- Output MULTIPLE files with clear file path headers
- Use modern frameworks (React, Express, Tailwind, Prisma)
- Include complete HTML with inline styles for immediate preview
- Every HTML file must be a COMPLETE document (<!DOCTYPE html>...)
- Include error handling, loading states, responsive design
- Write code that actually works — no placeholders, no TODOs
- Include package.json with all dependencies

FORMAT for each file:

**Code Summary:** [Brief explanation of what this file does and its purpose in the project]

\`\`\`[language]
// filepath: [path/to/file.ext]
[complete file contents]
\`\`\`

**How to Run:**
- [Step 1 command]
- [Step 2 command]

---

[Next file follows same format]

IMPORTANT: 
- The FIRST code block must be a complete HTML file that can render immediately in a preview iframe
- End with a consolidated "How to Run" section listing all terminal commands in order`,

  installer: `You are the Installer Agent for HeftCoder, a vibe-coding platform.

YOUR ROLE: Generate dependency installation and build commands.

CRITICAL OUTPUT FORMATTING RULES:
1. Do NOT wrap commands in bordered boxes or scrollable containers
2. Commands must appear as free-flowing text
3. Before each command block, include a brief explanation of what it does

RULES:
- Output terminal commands with clear explanations
- Include npm install, build steps, database migrations
- Handle errors with || operators
- Include verification commands (npm test, curl health checks)
- Be thorough — install ALL needed dependencies

FORMAT:

**Step 1: Install Dependencies**
This installs all required npm packages for the project.

\`\`\`bash
npm install express cors dotenv prisma @prisma/client
\`\`\`

**Step 2: Generate Prisma Client**
This generates the Prisma client based on your schema.

\`\`\`bash
npx prisma generate
\`\`\`

**Step 3: Run Database Migrations**
This creates the database tables defined in your schema.

\`\`\`bash
npx prisma migrate dev --name init
\`\`\`

**Step 4: Build the Project**
This compiles TypeScript and prepares the production build.

\`\`\`bash
npm run build
\`\`\`

**Step 5: Start and Verify**
This starts the server and verifies it's running correctly.

\`\`\`bash
npm start &
sleep 2
curl http://localhost:3000/health
\`\`\``,

  fixer: `You are the Fixer Agent for HeftCoder, a vibe-coding platform.

YOUR ROLE: Detect and fix errors in code and build output.

CRITICAL OUTPUT FORMATTING RULES:
1. Do NOT wrap code in bordered boxes, clipped containers, or scrollable UI elements
2. Code must appear as free-flowing text with NO borders, NO clipping, NO scrollbars
3. Before EACH code fix, include a "Code Summary" explaining the fix
4. After EACH code fix, include a "How to Run" section to verify the fix
5. At the TOP of each code file, include the file path as a comment

RULES:
- Analyze error messages and stack traces
- Output corrected code with clear file paths
- Explain what was wrong and how you fixed it
- If multiple files need fixing, fix ALL of them
- Include terminal commands to verify the fix

FORMAT:

## 🔧 Error Analysis
[Brief explanation of what went wrong and why]

## 🛠️ Fix

**Code Summary:** [Explanation of what was changed and why it fixes the issue]

\`\`\`[language]
// filepath: [path/to/file.ext]
[corrected complete file contents]
\`\`\`

**How to Run:**
- [Command to rebuild/restart]
- [Command to verify the fix]

## ✅ Verification
Run these commands to confirm the fix works:

\`\`\`bash
[verification commands]
\`\`\``
};

// ============================================================
// In-memory session store (shared across providers)
// ============================================================
const sessions = new Map();
const microsoftConversations = new Map(); // Direct Line conversation cache

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      history: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      approvedPlan: null
    });
  }
  const session = sessions.get(sessionId);
  session.lastActivity = Date.now();
  return session;
}

// Clean up old sessions every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.lastActivity < cutoff) {
      sessions.delete(id);
      microsoftConversations.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ============================================================
// PROVIDER 1: Microsoft Copilot Studio (Direct Line)
// ============================================================

function isMicrosoftConfigured() {
  return !!MICROSOFT_STUDIO_SECRET_KEY;
}

async function createMicrosoftConversation() {
  console.log(`[OpenClaw] Creating new Microsoft Direct Line conversation...`);
  const response = await fetch(`${DIRECT_LINE_BASE}/conversations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MICROSOFT_STUDIO_SECRET_KEY}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create Microsoft conversation: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  console.log(`[OpenClaw] Microsoft conversation created: ${data.conversationId}`);
  return data;
}

async function getOrCreateMicrosoftConversation(sessionId) {
  if (microsoftConversations.has(sessionId)) {
    const cached = microsoftConversations.get(sessionId);
    // Check if conversation is still valid (less than 25 minutes old)
    if (Date.now() - cached.createdAt < 25 * 60 * 1000) {
      return cached;
    }
    microsoftConversations.delete(sessionId);
  }

  const conversation = await createMicrosoftConversation();
  const cached = {
    ...conversation,
    createdAt: Date.now(),
    watermark: null
  };
  microsoftConversations.set(sessionId, cached);
  return cached;
}

async function sendMicrosoftMessage(conversation, message) {
  const response = await fetch(`${DIRECT_LINE_BASE}/conversations/${conversation.conversationId}/activities`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MICROSOFT_STUDIO_SECRET_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "message",
      from: { id: "openclaw-user" },
      text: message
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send message: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

async function getMicrosoftResponse(conversation, watermark = null, maxWaitMs = 60000) {
  const startTime = Date.now();
  let lastWatermark = watermark;

  while (Date.now() - startTime < maxWaitMs) {
    const url = `${DIRECT_LINE_BASE}/conversations/${conversation.conversationId}/activities${lastWatermark ? `?watermark=${lastWatermark}` : ""}`;
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${MICROSOFT_STUDIO_SECRET_KEY}` }
    });

    if (!response.ok) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const data = await response.json();
    lastWatermark = data.watermark || lastWatermark;

    // Find bot responses (not from our user)
    const botActivities = (data.activities || []).filter(
      a => a.type === "message" && a.from?.id !== "openclaw-user"
    );

    if (botActivities.length > 0) {
      const lastActivity = botActivities[botActivities.length - 1];
      return {
        content: lastActivity.text || "",
        activityId: lastActivity.id,
        timestamp: lastActivity.timestamp,
        from: lastActivity.from,
        watermark: lastWatermark
      };
    }

    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error("Timeout waiting for Microsoft Copilot Studio response");
}

async function invokeMicrosoft(sessionId, prompt, role) {
  if (!isMicrosoftConfigured()) {
    throw new Error("Microsoft Copilot Studio not configured (MICROSOFT_STUDIO_SECRET_KEY missing)");
  }

  const startTime = Date.now();
  const conversation = await getOrCreateMicrosoftConversation(sessionId);

  // Prepend role context to the prompt
  const roleContext = `[Agent Role: ${role.toUpperCase()}]\n\n`;
  const fullPrompt = roleContext + prompt;

  await sendMicrosoftMessage(conversation, fullPrompt);
  const response = await getMicrosoftResponse(conversation, conversation.watermark);

  // Update watermark for next message
  const cached = microsoftConversations.get(sessionId);
  if (cached) {
    cached.watermark = response.watermark;
  }

  return {
    content: response.content,
    provider: "microsoft",
    model: "copilot-studio",
    latencyMs: Date.now() - startTime,
    activityId: response.activityId,
    timestamp: response.timestamp
  };
}

// ============================================================
// PROVIDER 2: Qwen via Ollama
// ============================================================

async function checkOllamaHealth() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return { status: "error", error: `HTTP ${response.status}` };
    const data = await response.json();
    const models = (data.models || []).map(m => m.name);
    const hasModel = models.some(m => m.startsWith(OLLAMA_MODEL.split(":")[0]));
    return { status: "ok", models, hasModel, targetModel: OLLAMA_MODEL };
  } catch (err) {
    return { status: "unreachable", error: err.message };
  }
}

async function invokeQwen(systemPrompt, userPrompt, conversationHistory = []) {
  const messages = [];
  messages.push({ role: "system", content: systemPrompt });
  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: userPrompt });

  const startTime = Date.now();

  const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 8192,
      stream: false
    }),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    provider: "qwen",
    model: data.model || OLLAMA_MODEL,
    latencyMs: Date.now() - startTime,
    usage: data.usage || {},
    finishReason: data.choices?.[0]?.finish_reason || "stop"
  };
}

async function streamQwen(systemPrompt, userPrompt, conversationHistory = [], onToken) {
  const messages = [];
  messages.push({ role: "system", content: systemPrompt });
  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: userPrompt });

  const startTime = Date.now();
  let fullContent = "";

  const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 8192,
      stream: true
    }),
    signal: AbortSignal.timeout(180000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama stream error: ${response.status} - ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const jsonStr = trimmed.slice(6);
      if (jsonStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          onToken(delta);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return {
    content: fullContent,
    provider: "qwen",
    model: OLLAMA_MODEL,
    latencyMs: Date.now() - startTime,
    tokenCount: fullContent.split(/\s+/).length
  };
}

// ============================================================
// UNIFIED INVOKE (Routes to correct provider based on role)
// ============================================================

async function invokeAgent(sessionId, prompt, role, conversationHistory = [], approvedPlan = null) {
  const provider = getProviderForRole(role);
  console.log(`[OpenClaw] Routing ${role} → ${provider}`);

  if (provider === "microsoft") {
    return await invokeMicrosoft(sessionId, prompt, role);
  } else {
    // Qwen execution agent
    const systemPrompt = QWEN_AGENT_PROMPTS[role] || QWEN_AGENT_PROMPTS.builder;
    let finalPrompt = prompt;

    // If there's an approved plan, prepend it for execution agents
    if (approvedPlan && (role === "builder" || role === "coder" || role === "executor")) {
      finalPrompt = `APPROVED PLAN:\n${approvedPlan}\n\nNow implement this plan fully. Generate all files.\n\nOriginal request: ${prompt}`;
    }

    return await invokeQwen(systemPrompt, finalPrompt, conversationHistory);
  }
}

async function streamAgent(sessionId, prompt, role, conversationHistory = [], approvedPlan = null, onToken) {
  const provider = getProviderForRole(role);
  console.log(`[OpenClaw] Streaming ${role} → ${provider}`);

  if (provider === "microsoft") {
    // Microsoft doesn't support streaming, invoke and emit all at once
    const result = await invokeMicrosoft(sessionId, prompt, role);
    // Simulate streaming by emitting word by word
    const words = result.content.split(" ");
    for (let i = 0; i < words.length; i++) {
      await new Promise(r => setTimeout(r, 15));
      onToken(words[i] + (i < words.length - 1 ? " " : ""));
    }
    return result;
  } else {
    // Qwen supports true streaming
    const systemPrompt = QWEN_AGENT_PROMPTS[role] || QWEN_AGENT_PROMPTS.builder;
    let finalPrompt = prompt;

    if (approvedPlan && (role === "builder" || role === "coder" || role === "executor")) {
      finalPrompt = `APPROVED PLAN:\n${approvedPlan}\n\nNow implement this plan fully. Generate all files.\n\nOriginal request: ${prompt}`;
    }

    return await streamQwen(systemPrompt, finalPrompt, conversationHistory, onToken);
  }
}

// ============================================================
// Routes
// ============================================================

// Network diagnostic endpoint - comprehensive container network analysis
app.get("/debug/network", async (req, res) => {
  console.log("[OpenClaw] Running comprehensive network diagnostics...");
  
  const { execSync } = await import("child_process");
  const os = await import("os");
  const dns = await import("dns");
  const { promisify } = await import("util");
  const dnsResolve = promisify(dns.resolve);
  const dnsResolve4 = promisify(dns.resolve4);
  
  // Step 1: Gather container network info
  let networkInfo = {};
  try {
    const interfaces = os.networkInterfaces();
    networkInfo.interfaces = {};
    for (const [name, addrs] of Object.entries(interfaces)) {
      networkInfo.interfaces[name] = addrs.map(a => ({
        address: a.address,
        family: a.family,
        internal: a.internal
      }));
    }
  } catch (e) { networkInfo.interfaceError = e.message; }

  // Step 2: Get default gateway
  let gateway = null;
  try {
    const routeOutput = execSync("ip route 2>/dev/null || route -n 2>/dev/null || echo 'no route cmd'", { encoding: "utf8", timeout: 3000 });
    networkInfo.routes = routeOutput.trim().split("\n").slice(0, 10);
    const defaultMatch = routeOutput.match(/default via (\S+)/);
    if (defaultMatch) {
      gateway = defaultMatch[1];
      networkInfo.defaultGateway = gateway;
    }
  } catch (e) { networkInfo.routeError = e.message; }

  // Step 3: DNS resolution for host.docker.internal
  let hostDockerIP = null;
  try {
    const ips = await dnsResolve4("host.docker.internal");
    hostDockerIP = ips[0];
    networkInfo.hostDockerInternal = { resolved: true, ips };
  } catch (e) {
    networkInfo.hostDockerInternal = { resolved: false, error: e.message };
    // Try /etc/hosts
    try {
      const hosts = execSync("cat /etc/hosts 2>/dev/null || echo 'no hosts file'", { encoding: "utf8", timeout: 2000 });
      const hostLine = hosts.split("\n").find(l => l.includes("host.docker.internal"));
      if (hostLine) {
        const ip = hostLine.trim().split(/\s+/)[0];
        hostDockerIP = ip;
        networkInfo.hostDockerInternal.fromHosts = hostLine.trim();
        networkInfo.hostDockerInternal.ip = ip;
      }
    } catch (e2) { /* ignore */ }
  }

  // Step 4: Check /etc/hosts for any useful entries
  try {
    const hosts = execSync("cat /etc/hosts 2>/dev/null", { encoding: "utf8", timeout: 2000 });
    networkInfo.etcHosts = hosts.trim().split("\n").filter(l => l.trim() && !l.startsWith("#"));
  } catch (e) { /* ignore */ }

  // Step 5: Build dynamic test URLs based on discovered network
  const testUrls = [
    { name: "Docker default bridge (172.17.0.1)", url: "http://172.17.0.1:11434" },
    { name: "host.docker.internal", url: "http://host.docker.internal:11434" },
    { name: "localhost IPv4", url: "http://127.0.0.1:11434" },
    { name: "localhost IPv6", url: "http://[::1]:11434" },
    { name: "Public IP", url: "http://74.208.158.106:11434" },
  ];

  // Add gateway-based URL if different from 172.17.0.1
  if (gateway && gateway !== "172.17.0.1") {
    testUrls.unshift({ name: `Default gateway (${gateway})`, url: `http://${gateway}:11434` });
  }

  // Add resolved host.docker.internal IP if available
  if (hostDockerIP && hostDockerIP !== "172.17.0.1") {
    testUrls.splice(1, 0, { name: `host.docker.internal resolved (${hostDockerIP})`, url: `http://${hostDockerIP}:11434` });
  }

  // Add configured URL if unique
  const configuredInList = testUrls.some(t => t.url === OLLAMA_BASE_URL);
  if (!configuredInList) {
    testUrls.push({ name: "Configured URL", url: OLLAMA_BASE_URL });
  }

  // Step 6: Test Coolify API (known to work from containers) as control test
  let coolifyReachable = false;
  try {
    const coolifyResp = await fetch("http://host.docker.internal:8000/api/v1/version", {
      signal: AbortSignal.timeout(3000)
    });
    coolifyReachable = coolifyResp.ok || coolifyResp.status < 500;
    networkInfo.coolifyApiTest = { 
      url: "http://host.docker.internal:8000",
      reachable: true, 
      status: coolifyResp.status 
    };
  } catch (e) {
    networkInfo.coolifyApiTest = { 
      url: "http://host.docker.internal:8000",
      reachable: false, 
      error: e.message 
    };
    // Try gateway IP for Coolify
    if (gateway) {
      try {
        const gwResp = await fetch(`http://${gateway}:8000/api/v1/version`, {
          signal: AbortSignal.timeout(3000)
        });
        networkInfo.coolifyViaGateway = { 
          url: `http://${gateway}:8000`,
          reachable: true, 
          status: gwResp.status 
        };
      } catch (e2) {
        networkInfo.coolifyViaGateway = { 
          url: `http://${gateway}:8000`,
          reachable: false, 
          error: e2.message 
        };
      }
    }
  }

  // Step 7: Test each Ollama URL
  const results = [];
  for (const test of testUrls) {
    const startTime = Date.now();
    try {
      const response = await fetch(`${test.url}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      });
      const latency = Date.now() - startTime;
      
      if (response.ok) {
        const data = await response.json();
        const models = (data.models || []).map(m => m.name);
        results.push({
          name: test.name,
          url: test.url,
          status: "success",
          latencyMs: latency,
          models,
          hasQwen: models.some(m => m.includes("qwen"))
        });
      } else {
        results.push({
          name: test.name,
          url: test.url,
          status: "http_error",
          httpStatus: response.status,
          latencyMs: latency
        });
      }
    } catch (err) {
      results.push({
        name: test.name,
        url: test.url,
        status: "failed",
        error: err.message,
        latencyMs: Date.now() - startTime
      });
    }
  }

  // Step 8: Find working URL and generate recommendation
  const working = results.find(r => r.status === "success" && r.hasQwen);
  const anyWorking = results.find(r => r.status === "success");

  let recommendation = "No working URL found";
  let fixSuggestion = null;

  if (working) {
    recommendation = working.url;
  } else if (anyWorking) {
    recommendation = anyWorking.url;
  } else {
    // Generate fix suggestion based on diagnostics
    if (coolifyReachable) {
      fixSuggestion = "host.docker.internal resolves and Coolify API is reachable on port 8000, but Ollama port 11434 is blocked. Check if Ollama is listening on 0.0.0.0 (not just [::]) and check iptables rules.";
    } else if (gateway) {
      fixSuggestion = `Container gateway is ${gateway}. Neither Coolify (port 8000) nor Ollama (port 11434) reachable via gateway. Possible iptables/firewall blocking Docker→Host traffic. Run on host: sudo iptables -I INPUT -i docker0 -j ACCEPT && sudo iptables -I INPUT -i br-+ -j ACCEPT`;
    } else {
      fixSuggestion = "Cannot determine container gateway. Container may be in isolated network mode.";
    }
  }

  console.log("[OpenClaw] Network diagnostics complete");
  results.forEach(r => {
    console.log(`  ${r.name}: ${r.status} (${r.latencyMs}ms) ${r.error || ""}`);
  });

  res.json({
    timestamp: new Date().toISOString(),
    configuredUrl: OLLAMA_BASE_URL,
    configuredModel: OLLAMA_MODEL,
    recommendation,
    fixSuggestion,
    networkInfo,
    results,
    summary: {
      total: results.length,
      successful: results.filter(r => r.status === "success").length,
      withQwen: results.filter(r => r.hasQwen).length,
      coolifyReachable
    }
  });
});

// Health check
app.get("/health", async (req, res) => {
  const ollamaHealth = await checkOllamaHealth();
  const uptime = process.uptime();

  res.json({
    status: isMicrosoftConfigured() ? "ok" : "degraded",
    service: "openclaw",
    version: "3.1.0",
    architecture: "dual-provider",
    uptime,
    timestamp: new Date().toISOString(),
    providers: {
      microsoft: {
        status: isMicrosoftConfigured() ? "configured" : "not_configured",
        roles: MICROSOFT_ROLES
      },
      qwen: {
        status: ollamaHealth.status,
        model: OLLAMA_MODEL,
        roles: QWEN_ROLES,
        ...ollamaHealth
      }
    },
    activeSessions: sessions.size,
    agents: [...MICROSOFT_ROLES, ...QWEN_ROLES]
  });
});

// List available agents
app.get("/agents", (req, res) => {
  const microsoftAgents = MICROSOFT_ROLES.map(role => ({
    id: role,
    name: MICROSOFT_ROLE_NAMES[role] || role.charAt(0).toUpperCase() + role.slice(1),
    provider: "microsoft",
    role: "Planning & Supervision",
    status: isMicrosoftConfigured() ? "active" : "inactive"
  }));

  const qwenAgents = QWEN_ROLES.map(role => ({
    id: role,
    name: role.charAt(0).toUpperCase() + role.slice(1),
    provider: "qwen",
    role: "Execution & Building",
    status: "active"
  }));

  res.json({
    agents: [...microsoftAgents, ...qwenAgents],
    routing: {
      microsoft: MICROSOFT_ROLES,
      qwen: QWEN_ROLES
    },
    microsoftAgentNames: MICROSOFT_ROLE_NAMES
  });
});

// Invoke agent (non-streaming)
app.post("/invoke", async (req, res) => {
  const startTime = Date.now();
  try {
    const { prompt, sessionId, mode, conversationHistory, platform, approvedPlan } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Prompt is required" });
    }

    const agentRole = (mode || "planner").toLowerCase();
    const session = sessionId ? getSession(sessionId) : null;
    const history = conversationHistory || (session ? session.history : []);
    const plan = approvedPlan || (session ? session.approvedPlan : null);

    console.log(`[OpenClaw] Invoke: role=${agentRole}, session=${sessionId || "none"}, prompt="${prompt.substring(0, 80)}..."`);

    const result = await invokeAgent(sessionId || `temp-${Date.now()}`, prompt, agentRole, history, plan);

    // Update session history
    if (session) {
      session.history.push({ role: "user", content: prompt });
      session.history.push({ role: "assistant", content: result.content });
      if (session.history.length > 20) {
        session.history = session.history.slice(-16);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[OpenClaw] Response: ${duration}ms, ${result.content.length} chars, provider=${result.provider}`);

    res.json({
      success: true,
      content: result.content,
      agentId: agentRole,
      agentName: agentRole.charAt(0).toUpperCase() + agentRole.slice(1),
      provider: result.provider,
      sessionId: sessionId || undefined,
      metadata: {
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        platform: platform || "web",
        mode: agentRole,
        duration
      }
    });
  } catch (error) {
    console.error(`[OpenClaw] Invoke error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    });
  }
});

// Invoke agent with streaming (SSE)
app.post("/invoke/stream", async (req, res) => {
  const startTime = Date.now();
  try {
    const { prompt, sessionId, mode, conversationHistory, platform, approvedPlan } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Prompt is required" });
    }

    const agentRole = (mode || "planner").toLowerCase();
    const session = sessionId ? getSession(sessionId) : null;
    const history = conversationHistory || (session ? session.history : []);
    const plan = approvedPlan || (session ? session.approvedPlan : null);
    const provider = getProviderForRole(agentRole);

    console.log(`[OpenClaw] Stream: role=${agentRole}, provider=${provider}, session=${sessionId || "none"}`);

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    res.write(`data: ${JSON.stringify({ type: "agent_start", agentId: agentRole, agentName: agentRole.charAt(0).toUpperCase() + agentRole.slice(1), provider })}\n\n`);

    let tokenCount = 0;
    const result = await streamAgent(sessionId || `temp-${Date.now()}`, prompt, agentRole, history, plan, (token) => {
      tokenCount++;
      res.write(`data: ${JSON.stringify({ type: "token", content: token, agentId: agentRole })}\n\n`);
    });

    // Update session history
    if (session) {
      session.history.push({ role: "user", content: prompt });
      session.history.push({ role: "assistant", content: result.content });
      if (session.history.length > 20) {
        session.history = session.history.slice(-16);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[OpenClaw] Stream done: ${duration}ms, ${tokenCount} tokens, provider=${result.provider}`);

    res.write(`data: ${JSON.stringify({
      type: "done",
      agentId: agentRole,
      agentName: agentRole.charAt(0).toUpperCase() + agentRole.slice(1),
      provider: result.provider,
      content: result.content,
      metadata: {
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        tokenCount,
        duration
      }
    })}\n\n`);

    res.end();
  } catch (error) {
    console.error(`[OpenClaw] Stream error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
      res.end();
    }
  }
});

// Store approved plan for a session
app.post("/sessions/:sessionId/approve-plan", (req, res) => {
  const { sessionId } = req.params;
  const { plan } = req.body;

  if (!plan) {
    return res.status(400).json({ success: false, error: "Plan is required" });
  }

  const session = getSession(sessionId);
  session.approvedPlan = plan;

  console.log(`[OpenClaw] Plan approved for session ${sessionId}`);

  res.json({
    success: true,
    sessionId,
    message: "Plan approved. Execution agents (builder/installer/fixer) will now use this plan."
  });
});

// Multi-agent invoke (parallel execution - Qwen agents only, after plan approval)
app.post("/invoke/multi", async (req, res) => {
  const startTime = Date.now();
  try {
    const { prompt, sessionId, conversationHistory, platform, approvedPlan } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Prompt is required" });
    }

    if (!approvedPlan) {
      return res.status(400).json({
        success: false,
        error: "Multi-agent execution requires an approved plan. Use /invoke with mode='planner' first, then approve the plan."
      });
    }

    const session = sessionId ? getSession(sessionId) : null;
    const history = conversationHistory || (session ? session.history : []);

    console.log(`[OpenClaw] Multi-agent invoke (Qwen execution): prompt="${prompt.substring(0, 80)}..."`);

    // Run builder, installer, and fixer in parallel (all Qwen)
    const agents = ["builder", "installer", "fixer"];
    const results = await Promise.allSettled(
      agents.map(async (agentRole) => {
        const systemPrompt = QWEN_AGENT_PROMPTS[agentRole];
        let finalPrompt = prompt;
        if (agentRole === "builder") {
          finalPrompt = `APPROVED PLAN:\n${approvedPlan}\n\nNow implement this plan fully.\n\nOriginal request: ${prompt}`;
        }
        const result = await invokeQwen(systemPrompt, finalPrompt, history);
        return {
          agentId: agentRole,
          agentName: agentRole.charAt(0).toUpperCase() + agentRole.slice(1),
          provider: "qwen",
          content: result.content,
          confidence: agentRole === "builder" ? 0.9 : agentRole === "installer" ? 0.85 : 0.8,
          latencyMs: result.latencyMs,
          tokenCount: result.content.split(/\s+/).length,
          model: result.model
        };
      })
    );

    const successful = results
      .filter(r => r.status === "fulfilled")
      .map(r => r.value);

    const failed = results
      .filter(r => r.status === "rejected")
      .map((r, i) => ({ agentId: agents[i], error: r.reason?.message }));

    const duration = Date.now() - startTime;
    console.log(`[OpenClaw] Multi-agent done: ${successful.length} succeeded, ${failed.length} failed, ${duration}ms`);

    res.json({
      success: true,
      agents: successful,
      failed,
      totalLatencyMs: duration
    });
  } catch (error) {
    console.error(`[OpenClaw] Multi-agent error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multi-agent streaming (SSE) - Qwen execution agents only
app.post("/invoke/multi/stream", async (req, res) => {
  const startTime = Date.now();
  try {
    const { prompt, sessionId, conversationHistory, platform, approvedPlan } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Prompt is required" });
    }

    if (!approvedPlan) {
      return res.status(400).json({
        success: false,
        error: "Multi-agent execution requires an approved plan. Use /invoke with mode='planner' first."
      });
    }

    const session = sessionId ? getSession(sessionId) : null;
    const history = conversationHistory || (session ? session.history : []);

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    console.log(`[OpenClaw] Multi-stream (Qwen execution): prompt="${prompt.substring(0, 80)}..."`);

    // Run Qwen execution agents in parallel, stream builder output
    const agents = ["builder", "installer", "fixer"];
    const agentResults = [];

    const promises = agents.map(async (agentRole) => {
      const systemPrompt = QWEN_AGENT_PROMPTS[agentRole];
      let finalPrompt = prompt;
      if (agentRole === "builder") {
        finalPrompt = `APPROVED PLAN:\n${approvedPlan}\n\nNow implement this plan fully.\n\nOriginal request: ${prompt}`;
      }

      if (agentRole === "builder") {
        // Stream builder output
        res.write(`data: ${JSON.stringify({ type: "agent_start", agentId: "builder", agentName: "Builder", provider: "qwen", model: OLLAMA_MODEL })}\n\n`);

        const result = await streamQwen(systemPrompt, finalPrompt, history, (token) => {
          res.write(`data: ${JSON.stringify({ type: "token", content: token, agentId: "builder" })}\n\n`);
        });

        const agentResult = {
          agentId: "builder",
          agentName: "Builder",
          provider: "qwen",
          content: result.content,
          confidence: 0.9,
          latencyMs: result.latencyMs,
          tokenCount: result.tokenCount
        };
        agentResults.push(agentResult);

        res.write(`data: ${JSON.stringify({ type: "agent_done", agentId: "builder", latencyMs: result.latencyMs, confidence: 0.9 })}\n\n`);
        return agentResult;
      } else {
        // Non-streaming for installer and fixer
        const result = await invokeQwen(systemPrompt, finalPrompt, history);
        const agentResult = {
          agentId: agentRole,
          agentName: agentRole.charAt(0).toUpperCase() + agentRole.slice(1),
          provider: "qwen",
          content: result.content,
          confidence: agentRole === "installer" ? 0.85 : 0.8,
          latencyMs: result.latencyMs,
          tokenCount: result.content.split(/\s+/).length
        };
        agentResults.push(agentResult);

        res.write(`data: ${JSON.stringify({ type: "agent_done", agentId: agentRole, latencyMs: result.latencyMs, confidence: agentResult.confidence })}\n\n`);
        return agentResult;
      }
    });

    await Promise.allSettled(promises);

    // Judge: select best (builder always wins for code generation)
    const builder = agentResults.find(r => r.agentId === "builder");
    const selected = builder || agentResults[0];

    const duration = Date.now() - startTime;

    res.write(`data: ${JSON.stringify({
      type: "judge_selected",
      agentId: selected.agentId,
      agentName: selected.agentName,
      provider: selected.provider,
      strategy: "weighted",
      reasoning: `Selected ${selected.agentName} as primary code generator (${selected.tokenCount} tokens, ${selected.latencyMs}ms)`
    })}\n\n`);

    res.write(`data: ${JSON.stringify({
      type: "done",
      content: selected.content,
      selectedAgent: {
        id: selected.agentId,
        name: selected.agentName,
        provider: selected.provider,
        confidence: selected.confidence,
        latencyMs: selected.latencyMs
      },
      allAgents: agentResults.map(r => ({
        agentId: r.agentId,
        agentName: r.agentName,
        provider: r.provider,
        confidence: r.confidence,
        latencyMs: r.latencyMs,
        tokenCount: r.tokenCount,
        selected: r.agentId === selected.agentId
      })),
      totalLatencyMs: duration
    })}\n\n`);

    res.end();
  } catch (error) {
    console.error(`[OpenClaw] Multi-stream error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
      res.end();
    }
  }
});

// Session management
app.delete("/sessions/:sessionId", (req, res) => {
  const sid = req.params.sessionId;
  sessions.delete(sid);
  microsoftConversations.delete(sid);
  res.json({ success: true });
});

app.get("/sessions", (req, res) => {
  const sessionList = Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    messageCount: s.history.length,
    hasApprovedPlan: !!s.approvedPlan,
    createdAt: new Date(s.createdAt).toISOString(),
    lastActivity: new Date(s.lastActivity).toISOString()
  }));
  res.json({ sessions: sessionList, count: sessionList.length });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const server = app.listen(PORT, HOST, async () => {
  const ollamaHealth = await checkOllamaHealth();
  console.log("========================================");
  console.log(`✅ OpenClaw v3.1.0 DUAL PROVIDER running on http://${HOST}:${PORT}`);
  console.log(`✅ Health: http://${HOST}:${PORT}/health`);
  console.log(`✅ Agents: http://${HOST}:${PORT}/agents`);
  console.log("--- Microsoft Copilot Studio (PRIMARY) ---");
  console.log(`  ${isMicrosoftConfigured() ? "✅ CONFIGURED" : "❌ NOT CONFIGURED"}`);
  console.log(`  Roles: ${MICROSOFT_ROLES.map(r => MICROSOFT_ROLE_NAMES[r] || r).join(", ")}`);
  console.log("--- Qwen via Ollama (SECONDARY) ---");
  console.log(`  Ollama: ${ollamaHealth.status} (${OLLAMA_BASE_URL})`);
  if (ollamaHealth.status === "ok") {
    console.log(`  Model: ${OLLAMA_MODEL} ${ollamaHealth.hasModel ? "LOADED ✓" : "NOT FOUND ✗"}`);
  } else {
    console.log(`  ⚠️  Ollama not reachable: ${ollamaHealth.error}`);
  }
  console.log(`  Roles: ${QWEN_ROLES.join(", ")}`);
  console.log("========================================");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});
