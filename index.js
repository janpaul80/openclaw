
import express from "express";
import sandboxManager from "./sandboxManager.js";
import orchestrator from "./orchestrator.js";
import autonomousLoop from "./autonomousLoop.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger, { createLogger, createSessionLogger } from "./logger.js";
import { getMetrics, updateSandboxHealth, tokenUsage, responseSize, recordAgentInvocation, builderQueueSize, queueWaitTime } from "./metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ============================================================
// SSH KEY INITIALIZATION (for VPS sandbox access)
// ============================================================
// Write SSH private key from environment variable to filesystem
// This enables OpenClaw to SSH into VPS for Docker container management
if (process.env.SSH_PRIVATE_KEY) {
  try {
    const sshDir = path.join(process.env.HOME || "/root", ".ssh");
    const keyPath = path.join(sshDir, "id_rsa");

    // Create .ssh directory if it doesn't exist
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
      logger.info({ type: 'ssh_init', sshDir }, 'Created SSH directory');
    }

    let keyContent = (process.env.SSH_PRIVATE_KEY || '').trim();

    // Remove BOM if present
    if (keyContent.charCodeAt(0) === 0xFEFF) {
      keyContent = keyContent.slice(1);
    }

    // Heuristic: If it doesn't have the header, it's likely base64 encoded
    if (!keyContent.includes("BEGIN OPENSSH PRIVATE KEY") && !keyContent.includes("BEGIN RSA PRIVATE KEY")) {
      try {
        logger.info({ type: 'ssh_init' }, 'Attempting to decode SSH key from Base64');
        const decoded = Buffer.from(keyContent, "base64").toString("utf8");
        if (decoded.includes("BEGIN")) {
          keyContent = decoded;
        }
      } catch (e) {
        logger.warn({ type: 'ssh_init', error: e.message }, 'Failed to decode SSH_PRIVATE_KEY as base64, using as raw text');
      }
    }

    // Normalize line endings to \n (Unix)
    keyContent = keyContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Ensure it ends with a newline
    if (!keyContent.endsWith('\n')) {
      keyContent += '\n';
    }

    fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });

    // Verify file written correctly
    const stats = fs.statSync(keyPath);

    logger.info({
      type: 'ssh_init',
      keyPath,
      keySize: keyContent.length,
      fileMode: (stats.mode & 0o777).toString(8),
      firstLine: keyContent.split('\n')[0],
      isBase64Input: !process.env.SSH_PRIVATE_KEY.includes("BEGIN")
    }, 'SSH configuration completed with robust formatting');

  } catch (error) {
    logger.error({
      type: 'ssh_init',
      error: error.message,
      stack: error.stack
    }, 'Error configuring SSH key - sandbox functionality may be unavailable');
  }
} else {
  logger.warn({ type: 'ssh_init' }, 'SSH_PRIVATE_KEY environment variable not set - sandbox functionality will be unavailable');
}

// ============================================================
// DUAL PROVIDER CONFIGURATION
// ============================================================
// Provider 1: Microsoft Copilot Studio (PRIMARY - Planning/Supervision)
const MICROSOFT_STUDIO_SECRET_KEY = process.env.MICROSOFT_STUDIO_SECRET_KEY || "";
const DIRECT_LINE_BASE = process.env.DIRECT_LINE_BASE || "https://europe.directline.botframework.com/v3/directline";

// Provider 2: Qwen via Ollama (SECONDARY - Execution/Building)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://87.106.111.220:11434"; // Default to CPU VPS
const OLLAMA_PRIMARY_URL = process.env.OLLAMA_PRIMARY_URL || "http://79.112.58.103:29409/ollama"; // GPU Primary (Hardcoded for Phase G1)
const OLLAMA_PRIMARY_KEY = process.env.OLLAMA_PRIMARY_KEY || "sk-b4477739f6804216bbdb5ab62aa4580b"; // Primary Key
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || "120000"); // 2 minutes default
const OLLAMA_MODEL = "qwen2.5-coder:14b";
const OLLAMA_FIXER_MODEL = process.env.OLLAMA_FIXER_MODEL || "qwen2.5-coder:1.5b";

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

const OLLAMA_7B_MODEL = "qwen2.5-coder:7b";
const OLLAMA_1_5B_MODEL = "qwen2.5-coder:1.5b";

let activeBuilderRequests = 0;

const PHASE_3_6_ENABLED = true;

/**
 * PHASE 3.6: Intent Detection
 * Categorizes the prompt to inform model routing
 */
function detectIntent(prompt = '') {
  const p = prompt.toLowerCase();
  if (p.includes('scaffold') || p.includes('boilerplate') || p.includes('setup') || p.includes('new project')) return 'SCAFFOLD';
  if (p.includes('crud') || p.includes('form') || p.includes('api') || p.includes('list')) return 'CRUD';
  if (p.includes('static') || p.includes('landing') || p.includes('html only')) return 'STATIC';
  if (p.includes('refactor') || p.includes('optimize') || p.includes('migration')) return 'REFACTOR';
  return 'GENERAL';
}

/**
 * Adaptive Model Routing Logic (v4.1 - Phase 3.6)
 * Selects the best model based on role, task complexity, intent, and current queue depth.
 */
function getAdaptiveModel(role, complexity = 'medium', prompt = '') {
  const intent = detectIntent(prompt);
  let model = OLLAMA_MODEL; // Default to 14b
  let reason = 'default_fallback';

  if (role === 'fixer') {
    model = OLLAMA_FIXER_MODEL;
    reason = 'fixer_pinned';
  } else if (role !== 'builder' && role !== 'coder' && role !== 'executor') {
    model = OLLAMA_MODEL;
    reason = 'planner_quality_pinned';
  } else {
    const queue = activeBuilderRequests;

    // PHASE 3.6 OPTIMIZATION: Complex but "Standard" intents can use 7b
    if (complexity === 'complex') {
      if (PHASE_3_6_ENABLED && (intent === 'CRUD' || intent === 'STATIC' || intent === 'SCAFFOLD')) {
        model = OLLAMA_7B_MODEL;
        reason = `complex_optimized_${intent.toLowerCase()}`;
      } else {
        model = OLLAMA_MODEL;
        reason = 'complex_pinned_quality';
      }
    }
    // SIMPLE tasks: Aggressive downgrading
    else if (complexity === 'simple') {
      if (queue >= 3) {
        model = OLLAMA_1_5B_MODEL;
        reason = 'simple_queue_high';
      } else if (queue >= 2) {
        model = OLLAMA_7B_MODEL;
        reason = 'simple_queue_medium';
      } else {
        model = OLLAMA_MODEL;
        reason = 'simple_queue_low';
      }
    }
    // MEDIUM tasks: Balanced
    else {
      if (queue >= 3 || (PHASE_3_6_ENABLED && intent === 'STATIC')) {
        model = OLLAMA_7B_MODEL;
        reason = queue >= 3 ? 'medium_queue_high' : 'medium_optimized_static';
      } else {
        model = OLLAMA_MODEL;
        reason = 'medium_standard';
      }
    }
  }

  // Record decision in metrics
  import('./metrics.js').then(m => {
    m.recordRoutingDecision(role, model, reason, complexity);
  }).catch(() => { });

  if (reason !== 'default_fallback' && reason !== 'fixer_pinned') {
    console.log(`[OpenClaw] Routing ${role} ΓåÆ ${model} (Reason: ${reason}, Intent: ${intent}, Queue: ${activeBuilderRequests})`);
  }

  return model;
}

const OLLAMA_MAX_CONCURRENCY = parseInt(process.env.OLLAMA_MAX_CONCURRENCY || "2");

let ollamaQueue = [];
let ollamaProcessing = 0;

/**
 * Enqueue an Ollama request to manage throughput and track wait times correctly.
 */
async function enqueueOllama(task) {
  const waitStart = Date.now();
  return new Promise((resolve, reject) => {
    ollamaQueue.push({ task, resolve, reject, waitStart });
    processOllamaQueue();
  });
}

function processOllamaQueue() {
  // Respect concurrency limit
  if (ollamaProcessing >= OLLAMA_MAX_CONCURRENCY || ollamaQueue.length === 0) return;

  const { task, resolve, reject, waitStart } = ollamaQueue.shift();
  const waitSeconds = (Date.now() - waitStart) / 1000;

  // Record the actual wait time in the queue
  queueWaitTime.observe(waitSeconds);

  // SLA ALERT: If average queue wait exceeding 120 seconds
  if (waitSeconds > 120) {
    console.warn(`[OpenClaw] SLA ALERT: Builder queue wait time exceeded 120s (${Math.round(waitSeconds)}s)!`);
  }

  ollamaProcessing++;
  task()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      ollamaProcessing--;
      processOllamaQueue();
    });
}

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
logger.info({
  type: 'startup',
  version: '4.0.0',
  phase: 'Phase 1: Autonomous Build Loop',
  architecture: 'DUAL PROVIDER',
  port: PORT,
  host: HOST,
  nodeEnv: process.env.NODE_ENV || 'development'
}, 'OpenClaw Orchestrator starting');
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
// OBSERVABILITY MIDDLEWARE
// ============================================================

// Correlation ID middleware - adds unique ID to each request
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] ||
    `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.correlationId = correlationId;
  req.logger = createLogger(correlationId);
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  req.logger.info({
    type: 'http_request',
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }, 'Incoming request');

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    req.logger.info({
      type: 'http_response',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration_ms: duration,
    }, `Request completed in ${duration}ms`);
  });

  next();
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', 'text/plain; version=0.0.4');
    const metrics = await getMetrics();
    res.send(metrics);
  } catch (error) {
    logger.error({ type: 'metrics_error', error: error.message }, 'Error generating metrics');
    res.status(500).send('Error generating metrics');
  }
});

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
5. At the TOP of each code block, include the file path as a comment (e.g., // filepath: src/index.ts) - THIS IS MANDATORY

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
  const endpoints = [];
  if (OLLAMA_PRIMARY_URL) endpoints.push({ url: OLLAMA_PRIMARY_URL, name: 'Primary (GPU)', key: OLLAMA_PRIMARY_KEY });
  endpoints.push({ url: OLLAMA_BASE_URL, name: 'Fallback (CPU)', key: null });

  const results = {};

  for (const endpoint of endpoints) {
    try {
      const headers = {};
      if (endpoint.key) headers['Authorization'] = `Bearer ${endpoint.key}`;

      const response = await fetch(`${endpoint.url}/api/tags`, {
        headers,
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        results[endpoint.name] = { status: "error", error: `HTTP ${response.status}` };
        continue;
      }

      const data = await response.json();
      const models = (data.models || []).map(m => m.name);
      const hasModel = models.some(m => m.startsWith(OLLAMA_MODEL.split(":")[0]));
      results[endpoint.name] = { status: "ok", models, hasModel, targetModel: OLLAMA_MODEL };
    } catch (err) {
      results[endpoint.name] = { status: "unreachable", error: err.message };
    }
  }

  return results;
}

async function invokeQwen(systemPrompt, userPrompt, conversationHistory = [], modelOverride = null) {
  const model = modelOverride || OLLAMA_MODEL;
  const messages = [];
  messages.push({ role: "system", content: systemPrompt });
  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: userPrompt });

  const payload = {
    model: model,
    messages,
    temperature: 0.7,
    max_tokens: 8192,
    stream: false
  };

  // Helper to execute request against specific endpoint
  const executeRequest = async (url, apiKey, timeoutMs) => {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }
    return response.json();
  };

  const startTime = Date.now();
  let data;
  let providerUsed = "cpu";

  // Attempt Primary (GPU) if configured
  if (OLLAMA_PRIMARY_URL) {
    try {
      // console.log(`[OpenClaw] Attempting execution on Primary GPU...`);
      data = await executeRequest(OLLAMA_PRIMARY_URL, OLLAMA_PRIMARY_KEY, OLLAMA_TIMEOUT);
      providerUsed = "gpu";
    } catch (err) {
      console.warn(`[OpenClaw] Primary GPU failed (${err.message}). Falling back to CPU...`);
    }
  }

  // Fallback to CPU if Primary failed or not configured
  if (!data) {
    try {
      data = await executeRequest(OLLAMA_BASE_URL, null, 600000); // 10 min timeout for CPU
      providerUsed = "cpu";
    } catch (err) {
      throw new Error(`All providers failed. Last error: ${err.message}`);
    }
  }

  const duration = Date.now() - startTime;
  const tokenCount = data.usage?.completion_tokens || 0;

  console.log(`[OpenClaw] Invoke complete: provider=${providerUsed}, model=${model}, tokens=${tokenCount}, duration=${duration}ms`);

  return {
    content: data.choices?.[0]?.message?.content || "",
    provider: "qwen", // Legacy field
    model: data.model || model,
    latencyMs: duration,
    usage: data.usage || {},
    finishReason: data.choices?.[0]?.finish_reason || "stop",
    tokenCount,
    executionProvider: providerUsed // New field to track actual source
  };
}

async function streamQwen(systemPrompt, userPrompt, conversationHistory = [], onToken, modelOverride = null) {
  const model = modelOverride || OLLAMA_MODEL;
  const messages = [];
  messages.push({ role: "system", content: systemPrompt });
  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: userPrompt });


  // Helper for streaming request
  const executeStream = async (url, apiKey, timeoutMs) => {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model,
        messages,
        temperature: 0.7,
        max_tokens: 8192,
        stream: true
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status} - ${errorText}`);
    }
    return response;
  };

  let response;
  let providerUsed = "cpu";

  // Attempt Primary (GPU) first
  if (OLLAMA_PRIMARY_URL) {
    try {
      response = await executeStream(OLLAMA_PRIMARY_URL, OLLAMA_PRIMARY_KEY, OLLAMA_TIMEOUT);
      providerUsed = "gpu";
    } catch (err) {
      console.warn(`[OpenClaw] Primary GPU Stream failed (${err.message}). Falling back...`);
    }
  }

  // Fallback to CPU
  if (!response) {
    try {
      response = await executeStream(OLLAMA_BASE_URL, null, 900000); // 15 min timeout
      providerUsed = "cpu";
    } catch (err) {
      throw new Error(`All streaming providers failed. Last error: ${err.message}`);
    }
  }

  const startTime = Date.now();
  let fullContent = "";
  let tokenCount = 0;
  let lastProgressUpdate = Date.now();

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
          tokenCount++;
          onToken(delta);

          // PHASE 0: Progress indicators every 5 seconds
          const now = Date.now();
          if (now - lastProgressUpdate > 5000) {
            const elapsed = Math.round((now - startTime) / 1000);
            console.log(`[OpenClaw] Streaming progress: ${tokenCount} tokens, ${elapsed}s elapsed`);
            lastProgressUpdate = now;
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  const duration = Date.now() - startTime;

  // PHASE 0: Detailed logging
  console.log(`[OpenClaw] Qwen stream complete: model=${OLLAMA_MODEL}, tokens=${tokenCount}, duration=${duration}ms`);

  return {
    content: fullContent,
    provider: "qwen",
    model: OLLAMA_MODEL,
    latencyMs: duration,
    tokenCount
  };
}

// ============================================================
// PHASE 0: Retry Logic for Connection Errors
// ============================================================

async function invokeQwenWithRetry(systemPrompt, userPrompt, conversationHistory = [], maxRetries = 2, modelOverride = null) {
  let lastError;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await invokeQwen(systemPrompt, userPrompt, conversationHistory, modelOverride);

      if (attempt > 0) {
        console.log(`[OpenClaw] Qwen retry succeeded on attempt ${attempt + 1}`);
      }

      return {
        ...result,
        retryCount: attempt
      };
    } catch (error) {
      lastError = error;
      retryCount = attempt + 1;

      // Only retry on connection/timeout errors
      const isRetryable = error.message.includes('connection') ||
        error.message.includes('timeout') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('fetch failed');

      if (isRetryable && attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);  // Exponential backoff: 2s, 4s
        console.log(`[OpenClaw] Qwen connection error, retrying in ${delay}ms (${attempt + 1}/${maxRetries})...`);
        console.log(`[OpenClaw] Error: ${error.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Don't retry other errors
      console.error(`[OpenClaw] Qwen error (not retryable or max retries exceeded): ${error.message}`);
      throw error;
    }
  }

  throw lastError;
}

// ============================================================
// UNIFIED INVOKE (Routes to correct provider based on role)
// ============================================================

async function invokeAgent(sessionId, prompt, role, conversationHistory = [], approvedPlan = null, complexity = 'medium') {
  const provider = getProviderForRole(role);

  const isBuilder = role === 'builder' || role === 'coder' || role === 'executor';
  if (provider === 'qwen' && isBuilder) {
    activeBuilderRequests++;
    builderQueueSize.set(activeBuilderRequests);
  }

  // Adaptive Model Selection (now sees the updated activeBuilderRequests)
  const model = provider === 'microsoft' ? 'microsoft-studio' : getAdaptiveModel(role, complexity, prompt);

  console.log(`[OpenClaw] Routing ${role} → ${provider} (model: ${model}, current_total_builders: ${activeBuilderRequests}, complexity: ${complexity})`);

  const recordAgent = recordAgentInvocation(role, provider, model);

  try {
    let result;
    if (provider === "microsoft") {
      result = await invokeMicrosoft(sessionId, prompt, role);
    } else {
      // Qwen execution agent - Wrap in queue to track wait time vs inference
      const systemPrompt = QWEN_AGENT_PROMPTS[role] || QWEN_AGENT_PROMPTS.builder;
      let finalPrompt = prompt;

      // If there's an approved plan, prepend it for execution agents
      if (approvedPlan && isBuilder) {
        finalPrompt = `APPROVED PLAN:\n${approvedPlan}\n\nNow implement this plan fully. Generate all files.\n\nOriginal request: ${prompt}`;
      }

      // Use retry wrapper with the adaptive model, inside the throughput queue
      result = await enqueueOllama(() => invokeQwenWithRetry(systemPrompt, finalPrompt, conversationHistory, 3, model));

      if (result.tokenCount) {
        tokenUsage.observe({ role, provider: 'qwen', type: 'completion', model: result.model || model }, result.tokenCount);
      }

      if (result.content) {
        responseSize.observe({ role, provider: 'qwen', model: result.model || model }, result.content.length);
      }
    }

    recordAgent('success');
    return result;
  } catch (error) {
    recordAgent('failed');
    throw error;
  } finally {
    if (provider === 'qwen' && isBuilder) {
      activeBuilderRequests--;
      builderQueueSize.set(activeBuilderRequests);
    }
  }
}

async function streamAgent(sessionId, prompt, role, conversationHistory = [], approvedPlan = null, onToken, complexity = 'medium') {
  const provider = getProviderForRole(role);

  const isBuilder = role === 'builder' || role === 'coder' || role === 'executor';
  if (provider === 'qwen' && isBuilder) {
    activeBuilderRequests++;
    builderQueueSize.set(activeBuilderRequests);
  }

  // Adaptive Model Selection (now sees the updated activeBuilderRequests)
  const model = provider === 'microsoft' ? 'microsoft-studio' : getAdaptiveModel(role, complexity);

  console.log(`[OpenClaw] Streaming ${role} → ${provider} (model: ${model}, current_total_builders: ${activeBuilderRequests}, complexity: ${complexity})`);

  const recordAgent = recordAgentInvocation(role, provider, model);

  try {
    let result;
    if (provider === "microsoft") {
      // Microsoft doesn't support streaming, invoke and emit all at once
      result = await invokeMicrosoft(sessionId, prompt, role);
      // Simulate streaming by emitting word by word
      const words = result.content.split(" ");
      for (let i = 0; i < words.length; i++) {
        await new Promise(r => setTimeout(r, 15));
        onToken(words[i] + (i < words.length - 1 ? " " : ""));
      }
    } else {
      // Qwen execution agent - Wrap in queue to track wait time vs inference
      const systemPrompt = QWEN_AGENT_PROMPTS[role] || QWEN_AGENT_PROMPTS.builder;
      let finalPrompt = prompt;

      if (approvedPlan && isBuilder) {
        finalPrompt = `APPROVED PLAN:\n${approvedPlan}\n\nNow implement this plan fully. Generate all files.\n\nOriginal request: ${prompt}`;
      }

      // Use the adaptive model, inside the throughput queue
      result = await enqueueOllama(() => streamQwen(systemPrompt, finalPrompt, conversationHistory, onToken, model));

      if (result.tokenCount) {
        tokenUsage.observe({ role, provider: 'qwen', type: 'completion', model: result.model || model }, result.tokenCount);
      }

      if (result.content) {
        responseSize.observe({ role, provider: 'qwen', model: result.model || model }, result.content.length);
      }
    }

    recordAgent('success');
    return result;
  } catch (error) {
    recordAgent('failed');
    throw error;
  } finally {
    if (provider === 'qwen' && isBuilder) {
      activeBuilderRequests--;
      builderQueueSize.set(activeBuilderRequests);
    }
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
  const sandboxHealth = await sandboxManager.healthCheck();
  const uptime = process.uptime();

  res.json({
    status: isMicrosoftConfigured() ? "ok" : "degraded",
    service: "openclaw",
    version: "4.0.0",
    architecture: "autonomous-build-loop",
    phase: "1",
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
    sandbox: {
      healthy: sandboxHealth.healthy,
      vpsHost: sandboxHealth.vpsHost,
      connectionMethod: sandboxHealth.connectionMethod,
      dockerVersion: sandboxHealth.dockerVersion || null,
      error: sandboxHealth.error || null
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

  // PHASE 0: Set request/response timeouts
  req.setTimeout(600000);  // 10 minutes
  res.setTimeout(600000);

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

    // PHASE 0: Enhanced logging with retry count
    console.log(`[OpenClaw] Response: ${duration}ms, ${result.content.length} chars, provider=${result.provider}, retries=${result.retryCount || 0}`);

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
        duration,
        retryCount: result.retryCount || 0,
        tokenCount: result.tokenCount || 0
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

  // PHASE 0: Set request/response timeouts for streaming
  req.setTimeout(900000);  // 15 minutes
  res.setTimeout(900000);

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

    // PHASE 0: Set up SSE with keep-alive
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Keep-Alive": "timeout=900"  // 15 minutes
    });

    // PHASE 0: Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);  // Every 30 seconds

    try {
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
    } finally {
      clearInterval(heartbeat);
    }
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

// ============================================================
// PHASE 1: AUTONOMOUS EXECUTION ROUTES
// ============================================================

// Start autonomous execution
app.post("/autonomous/execute", async (req, res) => {
  const startTime = Date.now();

  try {
    const { prompt, sessionId, complexity = 'medium' } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Prompt is required" });
    }

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "Session ID is required" });
    }

    console.log(`[OpenClaw] Starting autonomous execution for session ${sessionId} (complexity: ${complexity})`);

    // Create agent invokers
    const agentInvokers = {
      planner: async (prompt) => {
        return await invokeAgent(sessionId, prompt, "planner", [], null, complexity);
      },
      builder: async (prompt, plan) => {
        return await invokeAgent(sessionId, prompt, "builder", [], plan, complexity);
      },
      fixer: async (prompt) => {
        return await invokeAgent(sessionId, prompt, "fixer", [], null, complexity);
      }
    };

    // Start autonomous loop (non-blocking)
    autonomousLoop.start(sessionId, prompt, agentInvokers, {
      complexity,
      onEvent: (event) => {
        console.log(`[OpenClaw] Autonomous event: ${event.type} (session ${sessionId})`);
      }
    }).then(result => {
      console.log(`[OpenClaw] Autonomous execution completed for session ${sessionId}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    }).catch(error => {
      console.error(`[OpenClaw] Autonomous execution error for session ${sessionId}: ${error.message}`);
    });

    res.json({
      success: true,
      sessionId,
      message: "Autonomous execution started",
      duration: Date.now() - startTime
    });
  } catch (error) {
    console.error(`[OpenClaw] Autonomous execute error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    });
  }
});

// Get autonomous execution status
app.get("/autonomous/status/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const status = autonomousLoop.getStatus(sessionId);

    if (!status.found) {
      return res.status(404).json({ success: false, error: "Execution not found" });
    }

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error(`[OpenClaw] Autonomous status error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get autonomous execution details
app.get("/autonomous/details/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const details = autonomousLoop.getDetails(sessionId);

    if (!details) {
      return res.status(404).json({ success: false, error: "Execution not found" });
    }

    res.json({
      success: true,
      ...details
    });
  } catch (error) {
    console.error(`[OpenClaw] Autonomous details error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop autonomous execution
app.post("/autonomous/stop/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await autonomousLoop.stop(sessionId, "manual");

    res.json(result);
  } catch (error) {
    console.error(`[OpenClaw] Autonomous stop error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get autonomous metrics
app.get("/autonomous/metrics", (req, res) => {
  try {
    const metrics = autonomousLoop.getMetrics();
    res.json({ success: true, metrics });
  } catch (error) {
    console.error(`[OpenClaw] Autonomous metrics error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Prometheus metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ============================================================
// PHASE 1: SANDBOX MANAGEMENT ROUTES
// ============================================================

// Get sandbox status
app.get("/sandbox/status", (req, res) => {
  try {
    const status = sandboxManager.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    console.error(`[OpenClaw] Sandbox status error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List active containers
app.get("/sandbox/containers", (req, res) => {
  try {
    const status = sandboxManager.getStatus();
    res.json({
      success: true,
      containers: status.containers,
      active: status.active,
      queued: status.queued
    });
  } catch (error) {
    console.error(`[OpenClaw] Sandbox containers error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Force cleanup all containers
app.delete("/sandbox/cleanup", async (req, res) => {
  try {
    const result = await sandboxManager.cleanupAll();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error(`[OpenClaw] Sandbox cleanup error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sandbox health check
app.get("/sandbox/health", async (req, res) => {
  try {
    const health = await sandboxManager.healthCheck();
    res.json({ success: true, ...health });
  } catch (error) {
    console.error(`[OpenClaw] Sandbox health error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
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
  const sandboxHealth = await sandboxManager.healthCheck();

  console.log("========================================");
  console.log(`✅ OpenClaw v4.0.0 AUTONOMOUS BUILD LOOP running on http://${HOST}:${PORT}`);
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
  console.log("--- PHASE 1: Docker Sandbox (VPS) ---");
  console.log(`  VPS: ${process.env.VPS_HOST || "87.106.111.220"}`);
  console.log(`  Connection: SSH (secure)`);
  console.log(`  Status: ${sandboxHealth.healthy ? "✅ HEALTHY" : "❌ UNHEALTHY"}`);
  if (sandboxHealth.healthy) {
    console.log(`  Docker: ${sandboxHealth.dockerVersion}`);
  } else {
    console.log(`  Error: ${sandboxHealth.error}`);
  }
  console.log(`  Max Containers: ${process.env.MAX_CONCURRENT_CONTAINERS || "3"}`);
  console.log("--- PHASE 1: Autonomous Execution ---");
  console.log(`  Orchestrator: ✅ READY`);
  console.log(`  Max Iterations: 5`);
  console.log(`  Max Duration: 15 minutes`);
  console.log("========================================");
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  await sandboxManager.cleanupAll();
  server.close(() => process.exit(0));
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down...");
  await sandboxManager.cleanupAll();
  server.close(() => process.exit(0));
});
