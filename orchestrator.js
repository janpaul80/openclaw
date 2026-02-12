/**
 * Execution Orchestrator - Phase 1
 * 
 * Multi-agent workflow coordination with:
 * - State machine: IDLE → PLANNING → BUILDING → [SUCCESS | ERROR] → FIXING
 * - Error handling and retry logic (max 5 iterations)
 * - Progress tracking and event emission
 * - Detailed iteration logging
 */

import sandboxManager from "./sandboxManager.js";

// ============================================================
// STATE MACHINE
// ============================================================

const States = {
  IDLE: "idle",
  PLANNING: "planning",
  BUILDING: "building",
  TESTING: "testing",
  SUCCESS: "success",
  ERROR: "error",
  FIXING: "fixing",
  FAILED: "failed",
  TIMEOUT: "timeout"
};

const MAX_ITERATIONS = 5;
const MAX_ORCHESTRATION_TIME = 900000; // 15 minutes total

// ============================================================
// EXECUTION ORCHESTRATOR
// ============================================================

class ExecutionOrchestrator {
  constructor() {
    this.executions = new Map(); // sessionId -> execution state
    this.metrics = {
      started: 0,
      completed: 0,
      failed: 0,
      iterations: 0
    };
  }

  /**
   * Start autonomous execution
   */
  async startExecution(sessionId, prompt, agents, options = {}) {
    console.log(`[Orchestrator] Starting execution for session ${sessionId}`);
    
    if (this.executions.has(sessionId)) {
      throw new Error(`Execution already running for session ${sessionId}`);
    }

    const execution = {
      sessionId,
      prompt,
      agents, // { planner, builder, fixer }
      state: States.IDLE,
      startTime: Date.now(),
      iterations: [],
      currentIteration: 0,
      plan: null,
      code: null,
      errors: [],
      snapshots: [],
      events: [],
      options
    };

    this.executions.set(sessionId, execution);
    this.metrics.started++;

    // Set up timeout
    const timeout = setTimeout(() => {
      this.handleTimeout(sessionId);
    }, MAX_ORCHESTRATION_TIME);

    execution.timeout = timeout;

    // Start workflow
    try {
      await this.runWorkflow(sessionId);
    } catch (error) {
      console.error(`[Orchestrator] Execution failed: ${error.message}`);
      this.transitionTo(sessionId, States.FAILED, { error: error.message });
    }

    return execution;
  }

  /**
   * Run the autonomous workflow
   */
  async runWorkflow(sessionId) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) {
      throw new Error(`No execution found for session ${sessionId}`);
    }

    console.log(`[Orchestrator] Running workflow for session ${sessionId}`);

    // Create sandbox container
    this.emitEvent(sessionId, "sandbox_creating", { message: "Creating isolated sandbox..." });
    
    try {
      const container = await sandboxManager.createContainer(sessionId);
      execution.containerId = container.id;
      this.emitEvent(sessionId, "sandbox_created", { containerId: container.id });
    } catch (error) {
      this.emitEvent(sessionId, "sandbox_failed", { error: error.message });
      throw new Error(`Failed to create sandbox: ${error.message}`);
    }

    // Phase 1: Planning
    await this.executePlanning(sessionId);

    // Phase 2: Building (with auto-fixing loop)
    await this.executeBuildLoop(sessionId);

    // Cleanup
    clearTimeout(execution.timeout);
    await sandboxManager.destroyContainer(sessionId, "completed");
  }

  /**
   * Execute planning phase
   */
  async executePlanning(sessionId) {
    const execution = this.executions.get(sessionId);
    
    this.transitionTo(sessionId, States.PLANNING);
    this.emitEvent(sessionId, "planning_start", { prompt: execution.prompt });

    console.log(`[Orchestrator] Planning phase for session ${sessionId}`);

    try {
      // Invoke planner agent
      const planResult = await execution.agents.planner(execution.prompt);
      
      execution.plan = planResult.content;
      
      this.emitEvent(sessionId, "planning_complete", { 
        plan: execution.plan,
        tokens: planResult.tokenCount || 0
      });

      console.log(`[Orchestrator] Plan created: ${execution.plan.substring(0, 100)}...`);
      
      return execution.plan;
    } catch (error) {
      this.emitEvent(sessionId, "planning_failed", { error: error.message });
      throw new Error(`Planning failed: ${error.message}`);
    }
  }

  /**
   * Execute build loop with auto-fixing
   */
  async executeBuildLoop(sessionId) {
    const execution = this.executions.get(sessionId);
    
    console.log(`[Orchestrator] Build loop for session ${sessionId}`);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      execution.currentIteration = i + 1;
      
      const iteration = {
        number: i + 1,
        startTime: Date.now(),
        state: null,
        result: null,
        errors: [],
        snapshot: null
      };

      execution.iterations.push(iteration);
      this.metrics.iterations++;

      console.log(`[Orchestrator] Iteration ${i + 1}/${MAX_ITERATIONS} for session ${sessionId}`);

      // Build phase
      const buildSuccess = await this.executeBuild(sessionId, iteration);
      
      if (buildSuccess) {
        // Success!
        this.transitionTo(sessionId, States.SUCCESS);
        this.metrics.completed++;
        
        this.emitEvent(sessionId, "execution_complete", {
          iterations: i + 1,
          duration: Date.now() - execution.startTime,
          code: execution.code
        });
        
        return;
      }

      // Build failed, try to fix
      if (i < MAX_ITERATIONS - 1) {
        await this.executeFix(sessionId, iteration);
      } else {
        // Max iterations reached
        this.transitionTo(sessionId, States.FAILED);
        this.metrics.failed++;
        
        this.emitEvent(sessionId, "execution_failed", {
          reason: "max_iterations",
          iterations: MAX_ITERATIONS,
          errors: execution.errors
        });
      }
    }
  }

  /**
   * Execute build phase
   */
  async executeBuild(sessionId, iteration) {
    const execution = this.executions.get(sessionId);
    
    this.transitionTo(sessionId, States.BUILDING);
    this.emitEvent(sessionId, "building_start", { 
      iteration: iteration.number,
      plan: execution.plan 
    });

    console.log(`[Orchestrator] Building (iteration ${iteration.number}) for session ${sessionId}`);

    try {
      // Invoke builder agent with approved plan
      const buildPrompt = iteration.number === 1 
        ? execution.prompt 
        : `Previous attempt had errors. Fix them and try again.\n\nErrors:\n${iteration.errors.join('\n')}\n\nOriginal request: ${execution.prompt}`;

      const buildResult = await execution.agents.builder(buildPrompt, execution.plan);
      
      execution.code = buildResult.content;
      iteration.result = buildResult;
      
      this.emitEvent(sessionId, "building_complete", {
        iteration: iteration.number,
        tokens: buildResult.tokenCount || 0,
        codeLength: execution.code.length
      });

      // Write code to sandbox
      await this.writeCodeToSandbox(sessionId, execution.code);

      // Create snapshot
      const snapshot = await sandboxManager.createSnapshot(sessionId);
      iteration.snapshot = snapshot;
      execution.snapshots.push(snapshot);
      
      this.emitEvent(sessionId, "snapshot_created", {
        iteration: iteration.number,
        snapshotName: snapshot.snapshotName
      });

      // Test the code
      const testResult = await this.testCode(sessionId);
      
      if (testResult.success) {
        iteration.state = "success";
        return true;
      } else {
        iteration.state = "error";
        iteration.errors = testResult.errors;
        execution.errors.push(...testResult.errors);
        
        this.emitEvent(sessionId, "build_errors", {
          iteration: iteration.number,
          errors: testResult.errors
        });
        
        return false;
      }
    } catch (error) {
      iteration.state = "error";
      iteration.errors = [error.message];
      execution.errors.push(error.message);
      
      this.emitEvent(sessionId, "building_failed", {
        iteration: iteration.number,
        error: error.message
      });
      
      return false;
    }
  }

  /**
   * Execute fix phase
   */
  async executeFix(sessionId, iteration) {
    const execution = this.executions.get(sessionId);
    
    this.transitionTo(sessionId, States.FIXING);
    this.emitEvent(sessionId, "fixing_start", {
      iteration: iteration.number,
      errors: iteration.errors
    });

    console.log(`[Orchestrator] Fixing (iteration ${iteration.number}) for session ${sessionId}`);

    try {
      // Invoke fixer agent
      const fixPrompt = `The code has errors. Analyze and fix them.\n\nErrors:\n${iteration.errors.join('\n')}\n\nOriginal code:\n${execution.code}`;
      
      const fixResult = await execution.agents.fixer(fixPrompt);
      
      this.emitEvent(sessionId, "fixing_complete", {
        iteration: iteration.number,
        tokens: fixResult.tokenCount || 0
      });

      console.log(`[Orchestrator] Fix applied for iteration ${iteration.number}`);
      
      // The next iteration will use the fixed approach
      return true;
    } catch (error) {
      this.emitEvent(sessionId, "fixing_failed", {
        iteration: iteration.number,
        error: error.message
      });
      
      return false;
    }
  }

  /**
   * Write code to sandbox
   */
  async writeCodeToSandbox(sessionId, code) {
    console.log(`[Orchestrator] Writing code to sandbox for session ${sessionId}`);
    
    // Extract files from code (look for code blocks with file paths)
    const fileRegex = /```[\w]*\n\/\/ filepath: (.+?)\n([\s\S]*?)```/g;
    let match;
    let filesWritten = 0;

    while ((match = fileRegex.exec(code)) !== null) {
      const filepath = match[1].trim();
      const content = match[2].trim();
      
      try {
        await sandboxManager.writeFile(sessionId, filepath, content);
        filesWritten++;
        console.log(`[Orchestrator] Wrote file: ${filepath}`);
      } catch (error) {
        console.error(`[Orchestrator] Failed to write ${filepath}: ${error.message}`);
      }
    }

    console.log(`[Orchestrator] Wrote ${filesWritten} files to sandbox`);
    
    return filesWritten;
  }

  /**
   * Test code in sandbox
   */
  async testCode(sessionId) {
    console.log(`[Orchestrator] Testing code for session ${sessionId}`);
    
    const errors = [];

    try {
      // Check for package.json and install dependencies
      const pkgResult = await sandboxManager.execInContainer(sessionId, "test -f package.json && echo 'found' || echo 'not found'");
      
      if (pkgResult.output.includes('found')) {
        this.emitEvent(sessionId, "installing_dependencies", { message: "Installing npm packages..." });
        
        const installResult = await sandboxManager.execInContainer(sessionId, "npm install --production", 120000);
        
        if (!installResult.success) {
          errors.push(`npm install failed: ${installResult.output}`);
        }
      }

      // Try to run basic syntax checks
      const jsFiles = await sandboxManager.execInContainer(sessionId, "find . -name '*.js' -o -name '*.ts'");
      
      if (jsFiles.success && jsFiles.output) {
        const files = jsFiles.output.split('\n').filter(f => f.trim());
        
        for (const file of files.slice(0, 10)) { // Check first 10 files
          const syntaxCheck = await sandboxManager.execInContainer(sessionId, `node --check ${file}`);
          
          if (!syntaxCheck.success) {
            errors.push(`Syntax error in ${file}: ${syntaxCheck.output}`);
          }
        }
      }

      return {
        success: errors.length === 0,
        errors
      };
    } catch (error) {
      return {
        success: false,
        errors: [error.message]
      };
    }
  }

  /**
   * Transition to new state
   */
  transitionTo(sessionId, newState, data = {}) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) return;

    const oldState = execution.state;
    execution.state = newState;

    console.log(`[Orchestrator] State transition: ${oldState} → ${newState} (session ${sessionId})`);

    this.emitEvent(sessionId, "state_change", {
      from: oldState,
      to: newState,
      ...data
    });
  }

  /**
   * Emit event
   */
  emitEvent(sessionId, type, data = {}) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) return;

    const event = {
      type,
      timestamp: Date.now(),
      data
    };

    execution.events.push(event);

    console.log(`[Orchestrator] Event: ${type} (session ${sessionId})`);

    // If there's a callback, call it
    if (execution.options.onEvent) {
      execution.options.onEvent(event);
    }
  }

  /**
   * Handle timeout
   */
  async handleTimeout(sessionId) {
    console.log(`[Orchestrator] Timeout for session ${sessionId}`);
    
    const execution = this.executions.get(sessionId);
    
    if (!execution) return;

    this.transitionTo(sessionId, States.TIMEOUT);
    this.metrics.failed++;

    this.emitEvent(sessionId, "execution_timeout", {
      duration: Date.now() - execution.startTime,
      iterations: execution.currentIteration
    });

    // Cleanup
    await sandboxManager.destroyContainer(sessionId, "timeout");
  }

  /**
   * Stop execution
   */
  async stopExecution(sessionId, reason = "manual") {
    console.log(`[Orchestrator] Stopping execution for session ${sessionId} (reason: ${reason})`);
    
    const execution = this.executions.get(sessionId);
    
    if (!execution) {
      return { success: false, error: "Execution not found" };
    }

    // Clear timeout
    if (execution.timeout) {
      clearTimeout(execution.timeout);
    }

    // Destroy container
    await sandboxManager.destroyContainer(sessionId, reason);

    // Update state
    this.transitionTo(sessionId, States.FAILED, { reason });

    return {
      success: true,
      sessionId,
      reason,
      duration: Date.now() - execution.startTime
    };
  }

  /**
   * Get execution status
   */
  getStatus(sessionId) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) {
      return { found: false };
    }

    return {
      found: true,
      sessionId: execution.sessionId,
      state: execution.state,
      currentIteration: execution.currentIteration,
      maxIterations: MAX_ITERATIONS,
      duration: Date.now() - execution.startTime,
      hasPlan: !!execution.plan,
      hasCode: !!execution.code,
      errorCount: execution.errors.length,
      snapshotCount: execution.snapshots.length,
      eventCount: execution.events.length
    };
  }

  /**
   * Get execution details
   */
  getDetails(sessionId) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) {
      return null;
    }

    return {
      sessionId: execution.sessionId,
      prompt: execution.prompt,
      state: execution.state,
      startTime: execution.startTime,
      duration: Date.now() - execution.startTime,
      currentIteration: execution.currentIteration,
      maxIterations: MAX_ITERATIONS,
      plan: execution.plan,
      code: execution.code,
      errors: execution.errors,
      iterations: execution.iterations.map(it => ({
        number: it.number,
        state: it.state,
        duration: it.result ? Date.now() - it.startTime : 0,
        errorCount: it.errors.length,
        hasSnapshot: !!it.snapshot
      })),
      snapshots: execution.snapshots,
      events: execution.events
    };
  }

  /**
   * Get orchestrator metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      active: this.executions.size,
      successRate: this.metrics.started > 0 
        ? (this.metrics.completed / this.metrics.started * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  /**
   * Cleanup execution
   */
  async cleanup(sessionId) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) return;

    if (execution.timeout) {
      clearTimeout(execution.timeout);
    }

    await sandboxManager.destroyContainer(sessionId, "cleanup");
    
    this.executions.delete(sessionId);
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

const orchestrator = new ExecutionOrchestrator();

export default orchestrator;
