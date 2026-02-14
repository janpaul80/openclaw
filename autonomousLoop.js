/**
 * Autonomous Build Loop - Phase 1
 * 
 * Self-healing autonomous execution with:
 * - Planner → Builder → Fixer workflow
 * - Automatic error detection
 * - Max 5 iterations with self-healing
 * - Workspace snapshots for rollback/audit
 * - Complete execution tracking
 */

import orchestrator from "./orchestrator.js";
import logger, { createSessionLogger, logError, logPerformance } from "./logger.js";
import { recordExecutionStart, recordRetry, recordFixerResult, recordFixCycles } from "./metrics.js";

// ============================================================
// AUTONOMOUS LOOP
// ============================================================

class AutonomousLoop {
  constructor() {
    this.sessions = new Map(); // sessionId -> loop state
    this.metrics = {
      loops: 0,
      successful: 0,
      failed: 0,
      avgIterations: 0
    };
  }

  /**
   * Start autonomous build loop
   */
  async start(sessionId, prompt, agentInvokers, options = {}) {
    const sessionLogger = createSessionLogger(sessionId);
    const recordExecution = recordExecutionStart(sessionId);
    const startTime = Date.now();

    sessionLogger.info({
      type: 'loop_start',
      prompt: prompt.substring(0, 200),
      promptLength: prompt.length
    }, `Starting autonomous loop for session ${sessionId}`);

    if (this.sessions.has(sessionId)) {
      throw new Error(`Loop already running for session ${sessionId}`);
    }

    const loop = {
      sessionId,
      prompt,
      startTime,
      status: "running",
      events: [],
      result: null,
      logger: sessionLogger
    };

    this.sessions.set(sessionId, loop);
    this.metrics.loops++;

    // Create agent wrappers
    const agents = {
      planner: async (prompt) => {
        sessionLogger.info({
          type: 'agent_invoke',
          agent: 'planner',
          promptLength: prompt.length
        }, 'Invoking planner agent');
        return await agentInvokers.planner(prompt);
      },

      builder: async (prompt, plan) => {
        sessionLogger.info({
          type: 'agent_invoke',
          agent: 'builder',
          promptLength: prompt.length,
          hasPlan: !!plan
        }, 'Invoking builder agent');
        return await agentInvokers.builder(prompt, plan);
      },

      fixer: async (prompt) => {
        sessionLogger.info({
          type: 'agent_invoke',
          agent: 'fixer',
          promptLength: prompt.length
        }, 'Invoking fixer agent');
        return await agentInvokers.fixer(prompt);
      }
    };

    // Start orchestrated execution
    try {
      sessionLogger.info({
        type: 'execution_start',
        phase: 'orchestration'
      }, 'Starting orchestrated execution');

      const execution = await orchestrator.startExecution(
        sessionId,
        prompt,
        agents,
        {
          complexity: options.complexity,
          onEvent: (event) => {
            loop.events.push(event);

            // Log important events
            if (['planning_complete', 'building_complete', 'fixing_complete', 'execution_complete'].includes(event.type)) {
              sessionLogger.info({
                type: 'execution_event',
                event: event.type,
                data: event.data
              }, `Execution event: ${event.type}`);
            }

            // Forward events to callback if provided
            if (options.onEvent) {
              options.onEvent(event);
            }
          }
        }
      );

      // Wait for completion
      sessionLogger.debug({
        type: 'waiting_completion',
        timeout: options.timeout || 900000
      }, 'Waiting for execution completion');

      await this.waitForCompletion(sessionId, options.timeout || 900000);

      // Get final result
      const details = orchestrator.getDetails(sessionId);
      const duration = Date.now() - loop.startTime;

      if (details && details.state === "success") {
        loop.status = "success";
        loop.result = {
          success: true,
          code: details.code,
          plan: details.plan,
          iterations: details.currentIteration,
          duration,
          snapshots: details.snapshots
        };

        this.metrics.successful++;
        this.updateAvgIterations(details.currentIteration);

        recordExecution('success', 'completed');
        recordFixCycles(options.complexity || 'medium', details.model || 'unknown', details.currentIteration);
        logPerformance(sessionLogger, 'autonomous_loop', duration, {
          iterations: details.currentIteration,
          snapshots: details.snapshots.length
        });

        sessionLogger.info({
          type: 'loop_success',
          iterations: details.currentIteration,
          duration_ms: duration,
          duration_s: Math.round(duration / 1000)
        }, `Loop completed successfully (${details.currentIteration} iterations, ${Math.round(duration / 1000)}s)`);
      } else {
        loop.status = "failed";
        loop.result = {
          success: false,
          error: details ? details.errors.join('; ') : 'Unknown error',
          iterations: details ? details.currentIteration : 0,
          duration
        };

        this.metrics.failed++;

        recordExecution('failed', 'completed');

        sessionLogger.warn({
          type: 'loop_failed',
          error: loop.result.error,
          iterations: loop.result.iterations,
          duration_ms: duration
        }, `Loop failed after ${loop.result.iterations} iterations`);
      }

      return loop.result;
    } catch (error) {
      const duration = Date.now() - loop.startTime;
      loop.status = "error";
      loop.result = {
        success: false,
        error: error.message,
        duration
      };

      this.metrics.failed++;
      recordExecution('error', 'failed');

      logError(sessionLogger, error, {
        type: 'loop_error',
        duration_ms: duration
      });

      return loop.result;
    } finally {
      // Cleanup
      sessionLogger.debug({
        type: 'cleanup_start'
      }, 'Starting cleanup');
      await orchestrator.cleanup(sessionId);
    }
  }

  /**
   * Wait for execution to complete
   */
  async waitForCompletion(sessionId, timeout) {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second

    while (Date.now() - startTime < timeout) {
      const status = orchestrator.getStatus(sessionId);

      if (!status.found) {
        throw new Error("Execution not found");
      }

      // Check if execution is complete
      if (status.state === "success" || status.state === "failed" || status.state === "timeout") {
        return;
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Timeout reached
    throw new Error("Execution timeout");
  }

  /**
   * Stop autonomous loop
   */
  async stop(sessionId, reason = "manual") {
    const loop = this.sessions.get(sessionId);

    if (!loop) {
      logger.warn({
        type: 'loop_stop_failed',
        sessionId,
        reason: 'not_found'
      }, `Cannot stop loop - not found for session ${sessionId}`);
      return { success: false, error: "Loop not found" };
    }

    const sessionLogger = loop.logger || createSessionLogger(sessionId);

    sessionLogger.warn({
      type: 'loop_stop',
      reason,
      duration_ms: Date.now() - loop.startTime
    }, `Stopping loop (reason: ${reason})`);

    // Stop orchestrator
    await orchestrator.stopExecution(sessionId, reason);

    loop.status = "stopped";
    loop.result = {
      success: false,
      error: `Stopped: ${reason}`,
      duration: Date.now() - loop.startTime
    };

    return {
      success: true,
      sessionId,
      reason,
      duration: Date.now() - loop.startTime
    };
  }

  /**
   * Get loop status
   */
  getStatus(sessionId) {
    const loop = this.sessions.get(sessionId);

    if (!loop) {
      return { found: false };
    }

    const orchestratorStatus = orchestrator.getStatus(sessionId);

    return {
      found: true,
      sessionId: loop.sessionId,
      status: loop.status,
      duration: Date.now() - loop.startTime,
      eventCount: loop.events.length,
      orchestrator: orchestratorStatus
    };
  }

  /**
   * Get loop details
   */
  getDetails(sessionId) {
    const loop = this.sessions.get(sessionId);

    if (!loop) {
      return null;
    }

    const orchestratorDetails = orchestrator.getDetails(sessionId);

    return {
      sessionId: loop.sessionId,
      prompt: loop.prompt,
      status: loop.status,
      startTime: loop.startTime,
      duration: Date.now() - loop.startTime,
      events: loop.events,
      result: loop.result,
      orchestrator: orchestratorDetails
    };
  }

  /**
   * Get loop metrics
   */
  getMetrics() {
    const orchestratorMetrics = orchestrator.getMetrics();

    return {
      loops: this.metrics.loops,
      successful: this.metrics.successful,
      failed: this.metrics.failed,
      active: this.sessions.size,
      successRate: this.metrics.loops > 0
        ? (this.metrics.successful / this.metrics.loops * 100).toFixed(2) + '%'
        : 'N/A',
      avgIterations: this.metrics.avgIterations.toFixed(2),
      orchestrator: orchestratorMetrics
    };
  }

  /**
   * Update average iterations
   */
  updateAvgIterations(iterations) {
    const total = this.metrics.avgIterations * (this.metrics.successful - 1) + iterations;
    this.metrics.avgIterations = total / this.metrics.successful;
  }

  /**
   * Cleanup loop
   */
  cleanup(sessionId) {
    this.sessions.delete(sessionId);
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

const autonomousLoop = new AutonomousLoop();

export default autonomousLoop;
