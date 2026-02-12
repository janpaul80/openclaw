import client from 'prom-client';

// Create a Registry
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ 
  register,
  prefix: 'openclaw_',
  labels: { service: 'openclaw' }
});

// ============================================================
// EXECUTION METRICS
// ============================================================

/**
 * Total number of executions by status and phase
 */
export const executionCounter = new client.Counter({
  name: 'openclaw_executions_total',
  help: 'Total number of autonomous executions',
  labelNames: ['status', 'phase'],
  registers: [register],
});

/**
 * Execution duration histogram by phase and status
 */
export const executionDuration = new client.Histogram({
  name: 'openclaw_execution_duration_seconds',
  help: 'Execution duration in seconds by phase',
  labelNames: ['phase', 'status'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 900, 1200],
  registers: [register],
});

/**
 * Currently active executions
 */
export const activeExecutions = new client.Gauge({
  name: 'openclaw_active_executions',
  help: 'Number of currently active autonomous executions',
  registers: [register],
});

/**
 * Retry attempts counter
 */
export const retryAttempts = new client.Counter({
  name: 'openclaw_retry_attempts_total',
  help: 'Total number of retry attempts',
  labelNames: ['attempt', 'result'],
  registers: [register],
});

/**
 * Fixer effectiveness counter
 */
export const fixerEffectiveness = new client.Counter({
  name: 'openclaw_fixer_effectiveness',
  help: 'Fixer agent effectiveness (fixed vs failed)',
  labelNames: ['result'],
  registers: [register],
});

// ============================================================
// SANDBOX METRICS
// ============================================================

/**
 * Sandbox container lifecycle events
 */
export const sandboxContainers = new client.Counter({
  name: 'openclaw_sandbox_containers_total',
  help: 'Total sandbox container lifecycle events',
  labelNames: ['operation', 'status'],
  registers: [register],
});

/**
 * Currently active sandbox containers
 */
export const activeSandboxContainers = new client.Gauge({
  name: 'openclaw_sandbox_active_containers',
  help: 'Number of currently active sandbox containers',
  registers: [register],
});

/**
 * Sandbox creation duration
 */
export const sandboxCreationDuration = new client.Histogram({
  name: 'openclaw_sandbox_creation_duration_seconds',
  help: 'Time taken to create sandbox container',
  buckets: [1, 2, 5, 10, 15, 30, 60],
  registers: [register],
});

/**
 * Sandbox cleanup duration
 */
export const sandboxCleanupDuration = new client.Histogram({
  name: 'openclaw_sandbox_cleanup_duration_seconds',
  help: 'Time taken to cleanup sandbox container',
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/**
 * Sandbox errors by type
 */
export const sandboxErrors = new client.Counter({
  name: 'openclaw_sandbox_errors_total',
  help: 'Total sandbox errors by type',
  labelNames: ['error_type'],
  registers: [register],
});

/**
 * Sandbox health status
 */
export const sandboxHealth = new client.Gauge({
  name: 'openclaw_sandbox_healthy',
  help: 'Sandbox health status (1=healthy, 0=unhealthy)',
  registers: [register],
});

// ============================================================
// RESOURCE METRICS
// ============================================================

/**
 * VPS CPU usage percentage
 */
export const vpsCpuUsage = new client.Gauge({
  name: 'openclaw_vps_cpu_usage_percent',
  help: 'VPS CPU usage percentage',
  labelNames: ['vps_host'],
  registers: [register],
});

/**
 * VPS memory usage percentage
 */
export const vpsMemoryUsage = new client.Gauge({
  name: 'openclaw_vps_memory_usage_percent',
  help: 'VPS memory usage percentage',
  labelNames: ['vps_host'],
  registers: [register],
});

/**
 * VPS disk usage percentage
 */
export const vpsDiskUsage = new client.Gauge({
  name: 'openclaw_vps_disk_usage_percent',
  help: 'VPS disk usage percentage',
  labelNames: ['vps_host'],
  registers: [register],
});

// ============================================================
// AGENT METRICS
// ============================================================

/**
 * Agent invocations by role and provider
 */
export const agentInvocations = new client.Counter({
  name: 'openclaw_agent_invocations_total',
  help: 'Total agent invocations by role and provider',
  labelNames: ['role', 'provider', 'status'],
  registers: [register],
});

/**
 * Agent response time
 */
export const agentResponseTime = new client.Histogram({
  name: 'openclaw_agent_response_duration_seconds',
  help: 'Agent response time in seconds',
  labelNames: ['role', 'provider'],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Record execution start
 * @param {string} sessionId - Session identifier
 * @returns {function} End function to record completion
 */
export function recordExecutionStart(sessionId) {
  activeExecutions.inc();
  const startTime = Date.now();
  
  return (status, phase) => {
    activeExecutions.dec();
    const duration = (Date.now() - startTime) / 1000;
    
    executionCounter.inc({ status, phase });
    executionDuration.observe({ phase: 'total', status }, duration);
  };
}

/**
 * Record sandbox container creation
 * @param {string} containerId - Container identifier
 * @returns {function} End function to record completion
 */
export function recordSandboxCreation(containerId) {
  activeSandboxContainers.inc();
  const startTime = Date.now();
  
  return (status) => {
    const duration = (Date.now() - startTime) / 1000;
    
    sandboxContainers.inc({ operation: 'created', status });
    sandboxCreationDuration.observe(duration);
  };
}

/**
 * Record sandbox container cleanup
 * @param {string} containerId - Container identifier
 * @returns {function} End function to record completion
 */
export function recordSandboxCleanup(containerId) {
  const startTime = Date.now();
  
  return (status) => {
    activeSandboxContainers.dec();
    const duration = (Date.now() - startTime) / 1000;
    
    sandboxContainers.inc({ operation: 'destroyed', status });
    sandboxCleanupDuration.observe(duration);
  };
}

/**
 * Record sandbox error
 * @param {string} errorType - Error type (ssh_failed, docker_failed, timeout, permission_denied)
 */
export function recordSandboxError(errorType) {
  sandboxErrors.inc({ error_type: errorType });
}

/**
 * Update sandbox health status
 * @param {boolean} healthy - Health status
 */
export function updateSandboxHealth(healthy) {
  sandboxHealth.set(healthy ? 1 : 0);
}

/**
 * Record retry attempt
 * @param {number} attempt - Attempt number (1, 2, 3)
 * @param {string} result - Result (success, failed)
 */
export function recordRetry(attempt, result) {
  retryAttempts.inc({ attempt: attempt.toString(), result });
}

/**
 * Record fixer result
 * @param {string} result - Result (fixed, failed)
 */
export function recordFixerResult(result) {
  fixerEffectiveness.inc({ result });
}

/**
 * Record agent invocation
 * @param {string} role - Agent role
 * @param {string} provider - Provider (microsoft, qwen)
 * @returns {function} End function to record completion
 */
export function recordAgentInvocation(role, provider) {
  const startTime = Date.now();
  
  return (status) => {
    const duration = (Date.now() - startTime) / 1000;
    
    agentInvocations.inc({ role, provider, status });
    agentResponseTime.observe({ role, provider }, duration);
  };
}

/**
 * Update VPS resource metrics
 * @param {string} vpsHost - VPS hostname/IP
 * @param {object} resources - Resource usage data
 */
export function updateVPSResources(vpsHost, resources) {
  if (resources.cpu !== undefined) {
    vpsCpuUsage.set({ vps_host: vpsHost }, resources.cpu);
  }
  if (resources.memory !== undefined) {
    vpsMemoryUsage.set({ vps_host: vpsHost }, resources.memory);
  }
  if (resources.disk !== undefined) {
    vpsDiskUsage.set({ vps_host: vpsHost }, resources.disk);
  }
}

/**
 * Get all metrics in Prometheus format
 * @returns {Promise<string>} Metrics in Prometheus text format
 */
export async function getMetrics() {
  return await register.metrics();
}

/**
 * Get metrics as JSON (for debugging)
 * @returns {Promise<object>} Metrics as JSON
 */
export async function getMetricsJSON() {
  return await register.getMetricsAsJSON();
}

/**
 * Reset all metrics (for testing)
 */
export function resetMetrics() {
  register.resetMetrics();
}

export default logger;
