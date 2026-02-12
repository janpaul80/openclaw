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
    console.log(`[AutonomousLoop] Starting loop for session ${sessionId}`);
    console.log(`[AutonomousLoop] Prompt: ${prompt.substring(0, 100)}...`);

    if (this.sessions.has(sessionId)) {
      throw new Error(`Loop already running for session ${sessionId}`);
    }

    const loop = {
      sessionId,
      prompt,
      startTime: Date.now(),
      status: "running",
      events: [],
      result: null
    };

    this.sessions.set(sessionId, loop);
    this.metrics.loops++;

    // Create agent wrappers
    const agents = {
      planner: async (prompt) => {
        console.log(`[AutonomousLoop] Invoking planner for session ${sessionId}`);
        return await agentInvokers.planner(prompt);
      },
      
      builder: async (prompt, plan) => {
        console.log(`[AutonomousLoop] Invoking builder for session ${sessionId}`);
        return await agentInvokers.builder(prompt, plan);
      },
      
      fixer: async (prompt) => {
        console.log(`[AutonomousLoop] Invoking fixer for session ${sessionId}`);
        return await agentInvokers.fixer(prompt);
      }
    };

    // Start orchestrated execution
    try {
      const execution = await orchestrator.startExecution(
        sessionId,
        prompt,
        agents,
        {
          onEvent: (event) => {
            loop.events.push(event);
            
            // Forward events to callback if provided
            if (options.onEvent) {
              options.onEvent(event);
            }
          }
        }
      );

      // Wait for completion
      await this.waitForCompletion(sessionId, options.timeout || 900000);

      // Get final result
      const details = orchestrator.getDetails(sessionId);
      
      if (details && details.state === "success") {
        loop.status = "success";
        loop.result = {
          success: true,
          code: details.code,
          plan: details.plan,
          iterations: details.currentIteration,
          duration: Date.now() - loop.startTime,
          snapshots: details.snapshots
        };
        
        this.metrics.successful++;
        this.updateAvgIterations(details.currentIteration);
        
        console.log(`[AutonomousLoop] Loop completed successfully for session ${sessionId} (${details.currentIteration} iterations)`);
      } else {
        loop.status = "failed";
        loop.result = {
          success: false,
          error: details ? details.errors.join('; ') : 'Unknown error',
          iterations: details ? details.currentIteration : 0,
          duration: Date.now() - loop.startTime
        };
        
        this.metrics.failed++;
        
        console.log(`[AutonomousLoop] Loop failed for session ${sessionId}`);
      }

      return loop.result;
    } catch (error) {
      loop.status = "error";
      loop.result = {
        success: false,
        error: error.message,
        duration: Date.now() - loop.startTime
      };
      
      this.metrics.failed++;
      
      console.error(`[AutonomousLoop] Loop error for session ${sessionId}: ${error.message}`);
      
      return loop.result;
    } finally {
      // Cleanup
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
    console.log(`[AutonomousLoop] Stopping loop for session ${sessionId} (reason: ${reason})`);

    const loop = this.sessions.get(sessionId);
    
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }

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
