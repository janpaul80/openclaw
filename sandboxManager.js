/**
 * Docker Sandbox Manager - Phase 1
 * 
 * Secure VPS-based container execution with:
 * - SSH transport (no unsecured TCP)
 * - Conservative resource limits (max 3 containers, 1 CPU, 2GB each)
 * - Global execution queue
 * - Hard lifetime limits (15 minutes)
 * - Full lifecycle logging
 * - Resource monitoring
 */

import { exec } from "child_process";
import { promisify } from "util";
import logger, { createContainerLogger, logError, logPerformance } from "./logger.js";
import {
  recordSandboxCreation,
  recordSandboxCleanup,
  recordSandboxError,
  updateSandboxHealth,
  activeSandboxContainers,
  updateVPSResources
} from "./metrics.js";

const execAsync = promisify(exec);

// ============================================================
// CONFIGURATION
// ============================================================

const VPS_HOST = process.env.VPS_HOST || "87.106.111.220";
const VPS_USER = process.env.VPS_USER || "openclaw";
const VPS_SSH_KEY = process.env.VPS_SSH_KEY || "/root/.ssh/id_rsa";

// Conservative limits
const MAX_CONCURRENT_CONTAINERS = parseInt(process.env.MAX_CONCURRENT_CONTAINERS || "3");
const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || "1";
const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || "2g";
const CONTAINER_DISK_LIMIT = process.env.CONTAINER_DISK_LIMIT || "10g";
const MAX_EXECUTION_TIME = parseInt(process.env.MAX_EXECUTION_TIME || "900000"); // 15 minutes

// Base image for sandboxes
const SANDBOX_IMAGE = "node:20-alpine";

// ============================================================
// STATE MANAGEMENT
// ============================================================

class SandboxManager {
  constructor() {
    this.containers = new Map(); // sessionId -> container info
    this.queue = []; // Pending container requests
    this.metrics = {
      created: 0,
      destroyed: 0,
      failed: 0,
      queued: 0,
      timeouts: 0
    };
  }

  /**
   * Execute Docker command via SSH
   */
  async dockerExec(command, timeout = 30000) {
    const sshCommand = `ssh -i ${VPS_SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${VPS_USER}@${VPS_HOST} "docker ${command}"`;
    const startTime = Date.now();

    logger.debug({
      type: 'docker_exec',
      command: command.substring(0, 100),
      vpsHost: VPS_HOST,
      timeout
    }, 'Executing Docker command via SSH');

    try {
      const { stdout, stderr } = await execAsync(sshCommand, {
        timeout,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });

      const duration = Date.now() - startTime;
      logPerformance(logger, 'docker_exec', duration, { command: command.substring(0, 50) });

      if (stderr && !stderr.includes("WARNING")) {
        logger.warn({
          type: 'docker_stderr',
          stderr: stderr.substring(0, 200)
        }, 'Docker command produced stderr output');
      }

      return stdout.trim();
    } catch (error) {
      const duration = Date.now() - startTime;
      logError(logger, error, {
        type: 'docker_exec_failed',
        command: command.substring(0, 100),
        duration_ms: duration
      });
      
      // Categorize error type for metrics
      if (error.message.includes('Permission denied')) {
        recordSandboxError('permission_denied');
      } else if (error.message.includes('timeout')) {
        recordSandboxError('timeout');
      } else if (error.message.includes('ssh')) {
        recordSandboxError('ssh_failed');
      } else {
        recordSandboxError('docker_failed');
      }
      
      throw new Error(`Docker SSH command failed: ${error.message}`);
    }
  }

  /**
   * Check if we can create a new container
   */
  canCreateContainer() {
    const activeCount = Array.from(this.containers.values())
      .filter(c => c.status === "running").length;
    return activeCount < MAX_CONCURRENT_CONTAINERS;
  }

  /**
   * Create a new sandbox container
   */
  async createContainer(sessionId, options = {}) {
    const containerLogger = createContainerLogger(`pending-${sessionId}`, sessionId);
    const recordCreation = recordSandboxCreation(sessionId);
    const startTime = Date.now();
    
    containerLogger.info({
      type: 'container_create_start',
      sessionId,
      options
    }, 'Starting container creation');

    // Check concurrency limit
    if (!this.canCreateContainer()) {
      containerLogger.warn({
        type: 'container_queued',
        currentContainers: this.containers.size,
        maxContainers: MAX_CONCURRENT_CONTAINERS
      }, 'Concurrency limit reached, queueing request');
      
      this.metrics.queued++;

      return new Promise((resolve, reject) => {
        this.queue.push({ sessionId, options, resolve, reject });
      });
    }

    const containerName = `openclaw-${sessionId}`;
    const workdir = `/workspace/${sessionId}`;

    try {
      // Security: Drop all capabilities, read-only root, no privileged mode
      const createCmd = [
        "run -d",
        `--name ${containerName}`,
        `--cpus=${CONTAINER_CPU_LIMIT}`,
        `--memory=${CONTAINER_MEMORY_LIMIT}`,
        "--read-only",
        "--tmpfs /tmp:rw,noexec,nosuid,size=1g",
        `--tmpfs ${workdir}:rw,exec,nosuid,size=5g`,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--network=none", // Isolated network
        `--workdir=${workdir}`,
        `--label=openclaw.session=${sessionId}`,
        `--label=openclaw.created=${Date.now()}`,
        SANDBOX_IMAGE,
        "sleep infinity"
      ].join(" ");

      const containerId = await this.dockerExec(createCmd, 60000);

      const container = {
        id: containerId,
        sessionId,
        name: containerName,
        status: "running",
        createdAt: Date.now(),
        workdir,
        metrics: {
          commandsExecuted: 0,
          filesCreated: 0,
          filesRead: 0,
          errors: 0
        }
      };

      this.containers.set(sessionId, container);
      this.metrics.created++;

      const duration = Date.now() - startTime;
      recordCreation('success');
      activeSandboxContainers.set(this.containers.size);
      
      containerLogger.info({
        type: 'container_created',
        containerId: containerId.substring(0, 12),
        containerName,
        duration_ms: duration,
        workdir,
        limits: {
          cpu: CONTAINER_CPU_LIMIT,
          memory: CONTAINER_MEMORY_LIMIT,
          disk: CONTAINER_DISK_LIMIT
        }
      }, `Container created in ${duration}ms`);

      // Set up automatic cleanup after max execution time
      setTimeout(() => {
        this.destroyContainer(sessionId, "timeout");
      }, MAX_EXECUTION_TIME);

      // Process queue if any
      this.processQueue();

      return container;
    } catch (error) {
      this.metrics.failed++;
      const duration = Date.now() - startTime;
      recordCreation('failed');
      
      logError(containerLogger, error, {
        type: 'container_create_failed',
        sessionId,
        duration_ms: duration
      });
      
      throw error;
    }
  }

  /**
   * Execute command in container
   */
  async execInContainer(sessionId, command, timeout = 60000) {
    const container = this.containers.get(sessionId);

    if (!container) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    if (container.status !== "running") {
      throw new Error(`Container ${container.id} is not running (status: ${container.status})`);
    }

    console.log(`[SandboxManager] Exec in ${container.id.substring(0, 12)}: ${command.substring(0, 80)}...`);

    try {
      const execCmd = `exec ${container.id} sh -c "${command.replace(/"/g, '\\"')}"`;
      const output = await this.dockerExec(execCmd, timeout);

      container.metrics.commandsExecuted++;

      return {
        success: true,
        output,
        exitCode: 0
      };
    } catch (error) {
      container.metrics.errors++;

      return {
        success: false,
        output: error.message,
        exitCode: error.code || 1
      };
    }
  }

  /**
   * Write file to container
   */
  async writeFile(sessionId, filepath, content) {
    const container = this.containers.get(sessionId);

    if (!container) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    console.log(`[SandboxManager] Writing file ${filepath} to ${container.id.substring(0, 12)}`);

    try {
      // Escape content for shell
      const escapedContent = Buffer.from(content).toString('base64');
      const command = `echo '${escapedContent}' | base64 -d > ${filepath}`;

      await this.execInContainer(sessionId, command);
      container.metrics.filesCreated++;

      console.log(`[SandboxManager] File written: ${filepath} (${content.length} bytes)`);

      return { success: true, filepath };
    } catch (error) {
      console.error(`[SandboxManager] Failed to write file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Read file from container
   */
  async readFile(sessionId, filepath) {
    const container = this.containers.get(sessionId);

    if (!container) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    console.log(`[SandboxManager] Reading file ${filepath} from ${container.id.substring(0, 12)}`);

    try {
      const result = await this.execInContainer(sessionId, `cat ${filepath}`);

      if (!result.success) {
        throw new Error(`Failed to read file: ${result.output}`);
      }

      container.metrics.filesRead++;

      return {
        success: true,
        content: result.output,
        filepath
      };
    } catch (error) {
      console.error(`[SandboxManager] Failed to read file: ${error.message}`);
      throw error;
    }
  }

  /**
   * List files in container directory
   */
  async listFiles(sessionId, directory = ".") {
    const container = this.containers.get(sessionId);

    if (!container) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    console.log(`[SandboxManager] Listing files in ${directory} from ${container.id.substring(0, 12)}`);

    try {
      const result = await this.execInContainer(sessionId, `ls -la ${directory}`);

      if (!result.success) {
        throw new Error(`Failed to list files: ${result.output}`);
      }

      return {
        success: true,
        files: result.output.split('\n').filter(line => line.trim()),
        directory
      };
    } catch (error) {
      console.error(`[SandboxManager] Failed to list files: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create workspace snapshot
   */
  async createSnapshot(sessionId) {
    const container = this.containers.get(sessionId);

    if (!container) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    const snapshotName = `openclaw-snapshot-${sessionId}-${Date.now()}`;

    console.log(`[SandboxManager] Creating snapshot ${snapshotName} from ${container.id.substring(0, 12)}`);

    try {
      const commitCmd = `commit ${container.id} ${snapshotName}`;
      const imageId = await this.dockerExec(commitCmd, 120000);

      console.log(`[SandboxManager] Snapshot created: ${imageId.substring(0, 12)}`);

      return {
        success: true,
        snapshotName,
        imageId,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error(`[SandboxManager] Failed to create snapshot: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get container resource usage
   */
  async getResourceUsage(sessionId) {
    const container = this.containers.get(sessionId);

    if (!container) {
      throw new Error(`No container found for session ${sessionId}`);
    }

    try {
      const statsCmd = `stats ${container.id} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.BlockIO}}"`;
      const stats = await this.dockerExec(statsCmd, 10000);

      const [cpu, mem, net, block] = stats.split('|');

      return {
        success: true,
        containerId: container.id,
        cpu,
        memory: mem,
        network: net,
        disk: block,
        uptime: Date.now() - container.createdAt,
        metrics: container.metrics
      };
    } catch (error) {
      console.error(`[SandboxManager] Failed to get resource usage: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Destroy container
   */
  async destroyContainer(sessionId, reason = "manual") {
    const container = this.containers.get(sessionId);

    if (!container) {
      console.log(`[SandboxManager] No container to destroy for session ${sessionId}`);
      return { success: true, reason: "not_found" };
    }

    console.log(`[SandboxManager] Destroying container ${container.id.substring(0, 12)} (reason: ${reason})`);

    try {
      // Force remove container
      const rmCmd = `rm -f ${container.id}`;
      await this.dockerExec(rmCmd, 30000);

      container.status = "destroyed";
      this.containers.delete(sessionId);
      this.metrics.destroyed++;

      if (reason === "timeout") {
        this.metrics.timeouts++;
      }

      console.log(`[SandboxManager] Container destroyed: ${container.id.substring(0, 12)}`);

      // Process queue
      this.processQueue();

      return {
        success: true,
        containerId: container.id,
        reason,
        lifetime: Date.now() - container.createdAt,
        metrics: container.metrics
      };
    } catch (error) {
      console.error(`[SandboxManager] Failed to destroy container: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process queued container requests
   */
  async processQueue() {
    if (this.queue.length === 0) return;
    if (!this.canCreateContainer()) return;

    const request = this.queue.shift();
    console.log(`[SandboxManager] Processing queued request for session ${request.sessionId}`);

    try {
      const container = await this.createContainer(request.sessionId, request.options);
      request.resolve(container);
    } catch (error) {
      request.reject(error);
    }
  }

  /**
   * Cleanup all containers
   */
  async cleanupAll() {
    console.log(`[SandboxManager] Cleaning up all containers (${this.containers.size} active)`);

    const sessions = Array.from(this.containers.keys());
    const results = await Promise.allSettled(
      sessions.map(sessionId => this.destroyContainer(sessionId, "cleanup"))
    );

    const successful = results.filter(r => r.status === "fulfilled").length;
    const failed = results.filter(r => r.status === "rejected").length;

    console.log(`[SandboxManager] Cleanup complete: ${successful} destroyed, ${failed} failed`);

    return {
      total: sessions.length,
      successful,
      failed
    };
  }

  /**
   * Get manager status
   */
  getStatus() {
    const activeContainers = Array.from(this.containers.values())
      .filter(c => c.status === "running");

    return {
      active: activeContainers.length,
      queued: this.queue.length,
      maxConcurrent: MAX_CONCURRENT_CONTAINERS,
      canCreate: this.canCreateContainer(),
      metrics: this.metrics,
      containers: activeContainers.map(c => ({
        id: c.id.substring(0, 12),
        sessionId: c.sessionId,
        uptime: Date.now() - c.createdAt,
        metrics: c.metrics
      }))
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      // Test SSH connection and Docker availability
      const version = await this.dockerExec("version --format '{{.Server.Version}}'", 10000);

      return {
        healthy: true,
        dockerVersion: version,
        vpsHost: VPS_HOST,
        connectionMethod: "SSH",
        status: this.getStatus()
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        vpsHost: VPS_HOST,
        connectionMethod: "SSH"
      };
    }
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

const sandboxManager = new SandboxManager();

// Cleanup on process exit
process.on("SIGTERM", async () => {
  logger.warn({
    type: 'shutdown',
    signal: 'SIGTERM'
  }, "SIGTERM received, cleaning up containers...");
  await sandboxManager.cleanupAll();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.warn({
    type: 'shutdown',
    signal: 'SIGINT'
  }, "SIGINT received, cleaning up containers...");
  await sandboxManager.cleanupAll();
  process.exit(0);
});

// Periodic cleanup of stale containers (every 5 minutes)
setInterval(async () => {
  const now = Date.now();
  const staleThreshold = MAX_EXECUTION_TIME + 60000; // 1 minute grace period

  for (const [sessionId, container] of sandboxManager.containers) {
    const age = now - container.createdAt;
    if (age > staleThreshold) {
      logger.warn({
        type: 'stale_container_cleanup',
        containerId: container.id.substring(0, 12),
        sessionId,
        age_ms: age,
        age_s: Math.round(age / 1000)
      }, `Cleaning up stale container (age: ${Math.round(age / 1000)}s)`);
      await sandboxManager.destroyContainer(sessionId, "stale");
    }
  }
}, 5 * 60 * 1000);

export default sandboxManager;
ntainer(sessionId, "stale");
    }
  }
}, 5 * 60 * 1000);

export default sandboxManager;
 const age = now - container.createdAt;
    if (age > staleThreshold) {
      console.log(`[SandboxManager] Cleaning up stale container ${container.id.substring(0, 12)} (age: ${Math.round(age / 1000)}s)`);
      await sandboxManager.destroyContainer(sessionId, "stale");
    }
  }
}, 5 * 60 * 1000);

export default sandboxManager;
e container ${container.id.substring(0, 12)} (age: ${Math.round(age / 1000)}s)`);
      await sandboxManager.destroyContainer(sessionId, "stale");
    }
  }
}, 5 * 60 * 1000);

export default sandboxManager;
