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
import logger, { createSessionLogger, createExecutionLogger, logError, logPerformance } from "./logger.js";
import { recordAgentInvocation, recordRetry, recordFixerResult, executionDuration } from "./metrics.js";

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
    const sessionLogger = createSessionLogger(sessionId);
    const startTime = Date.now();
    
    sessionLogger.info({
      type: 'orchestrator_start',
      promptLength: prompt.length
    }, `Starting execution orchestration for session ${sessionId}`);
    
    if (this.executions.has(sessionId)) {
      throw new Error(`Execution already running for session ${sessionId}`);
    }

    const execution = {
      sessionId,
      prompt,
      agents, // { planner, builder, fixer }
      state: States.IDLE,
      startTime,
      iterations: [],
      currentIteration: 0,
      plan: null,
      code: null,
      errors: [],
      snapshots: [],
      events: [],
      options,
      logger: sessionLogger
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
      logError(sessionLogger, error, {
        type: 'orchestrator_failed',
        duration_ms: Date.now() - startTime
      });
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

    const sessionLogger = execution.logger;

    sessionLogger.info({
      type: 'workflow_start',
      maxIterations: MAX_ITERATIONS
    }, 'Running autonomous workflow');

    // Create sandbox container
    this.emitEvent(sessionId, "sandbox_creating", { message: "Creating isolated sandbox..." });
    
    try {
      const container = await sandboxManager.createContainer(sessionId);
      execution.containerId = container.id;
      this.emitEvent(sessionId, "sandbox_created", { containerId: container.id });
      
      sessionLogger.info({
        type: 'sandbox_created',
        containerId: container.id.substring(0, 12)
      }, 'Sandbox container created');
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
    const sessionLogger = execution.logger;
    const phaseLogger = createExecutionLogger(sessionId, 'planning');
    const startTime = Date.now();
    
    this.transitionTo(sessionId, States.PLANNING);
    this.emitEvent(sessionId, "planning_start", { prompt: execution.prompt });

    phaseLogger.info({
      type: 'planning_start',
      promptLength: execution.prompt.length
    }, 'Starting planning phase');

    try {
      // Invoke planner agent
      const recordAgent = recordAgentInvocation('planner', 'microsoft');
      const planResult = await execution.agents.planner(execution.prompt);
      recordAgent('success');
      
      execution.plan = planResult.content;
      
      const duration = Date.now() - startTime;
      executionDuration.observe({ phase: 'planning', status: 'success' }, duration / 1000);
      
      logPerformance(phaseLogger, 'planning_phase', duration, {
        planLength: execution.plan.length,
        tokens: planResult.tokenCount || 0
      });
      
      this.emitEvent(sessionId, "planning_complete", { 
        plan: execution.plan,
        tokens: planResult.tokenCount || 0
      });

      phaseLogger.info({
        type: 'planning_complete',
        planLength: execution.plan.length,
        duration_ms: duration
      }, `Planning completed in ${duration}ms`);
      
      return execution.plan;
    } catch (error) {
      const duration = Date.now() - startTime;
      executionDuration.observe({ phase: 'planning', status: 'failed' }, duration / 1000);
      
      this.emitEvent(sessionId, "planning_failed", { error: error.message });
      
      logError(phaseLogger, error, {
        type: 'planning_failed',
        duration_ms: duration
      });
      
      throw new Error(`Planning failed: ${error.message}`);
    }
  }

  /**
   * Execute build loop with auto-fixing
   */
  async executeBuildLoop(sessionId) {
    const execution = this.executions.get(sessionId);
    const sessionLogger = execution.logger;
    
    sessionLogger.info({
      type: 'build_loop_start',
      maxIterations: MAX_ITERATIONS
    }, `Starting build loop (max ${MAX_ITERATIONS} iterations)`);

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

      sessionLogger.info({
        type: 'iteration_start',
        iteration: i + 1,
        maxIterations: MAX_ITERATIONS
      }, `Starting iteration ${i + 1}/${MAX_ITERATIONS}`);

      // Build phase
      const buildSuccess = await this.executeBuild(sessionId, iteration);
      
      if (buildSuccess) {
        // Success!
        this.transitionTo(sessionId, States.SUCCESS);
        this.metrics.completed++;
        
        const totalDuration = Date.now() - execution.startTime;
        executionDuration.observe({ phase: 'total', status: 'success' }, totalDuration / 1000);
        
        this.emitEvent(sessionId, "execution_complete", {
          iterations: i + 1,
          duration: totalDuration,
          code: execution.code
        });
        
        sessionLogger.info({
          type: 'build_loop_success',
          iterations: i + 1,
          duration_ms: totalDuration
        }, `Build loop completed successfully after ${i + 1} iterations`);
        
        return;
      }

      // Build failed, try to fix
      if (i < MAX_ITERATIONS - 1) {
        // Record retry
        recordRetry(i + 1, 'failed');
        
        sessionLogger.warn({
          type: 'iteration_failed',
          iteration: i + 1,
          errorCount: iteration.errors.length
        }, `Iteration ${i + 1} failed, attempting fix`);
        
        await this.executeFix(sessionId, iteration);
      } else {
        // Max iterations reached
        this.transitionTo(sessionId, States.FAILED);
        this.metrics.failed++;
        
        const totalDuration = Date.now() - execution.startTime;
        executionDuration.observe({ phase: 'total', status: 'failed' }, totalDuration / 1000);
        
        this.emitEvent(sessionId, "execution_failed", {
          reason: "max_iterations",
          iterations: MAX_ITERATIONS,
          errors: execution.errors
        });
        
        sessionLogger.error({
          type: 'build_loop_failed',
          reason: 'max_iterations',
          iterations: MAX_ITERATIONS,
          errorCount: execution.errors.length
        }, `Build loop failed after ${MAX_ITERATIONS} iterations`);
      }
    }
  }

  /**
   * Execute build phase
   */
  async executeBuild(sessionId, iteration) {
    const execution = this.executions.get(sessionId);
    const phaseLogger = createExecutionLogger(sessionId, `building-${iteration.number}`);
    const startTime = Date.now();
    
    this.transitionTo(sessionId, States.BUILDING);
    this.emitEvent(sessionId, "building_start", { 
      iteration: iteration.number,
      plan: execution.plan 
    });

    phaseLogger.info({
      type: 'building_start',
      iteration: iteration.number
    }, `Starting build phase (iteration ${iteration.number})`);

    try {
      // Invoke builder agent with approved plan
      const buildPrompt = iteration.number === 1 
        ? execution.prompt 
        : `Previous attempt had errors. Fix them and try again.\n\nErrors:\n${iteration.errors.join('\n')}\n\nOriginal request: ${execution.prompt}`;

      const recordAgent = recordAgentInvocation('builder', 'microsoft');
      const buildResult = await execution.agents.builder(buildPrompt, execution.plan);
      recordAgent('success');
      
      execution.code = buildResult.content;
      iteration.result = buildResult;
      
      const buildDuration = Date.now() - startTime;
      executionDuration.observe({ phase: 'building', status: 'success' }, buildDuration / 1000);
      
      this.emitEvent(sessionId, "building_complete", {
        iteration: iteration.number,
        tokens: buildResult.tokenCount || 0,
        codeLength: execution.code.length
      });

      phaseLogger.info({
        type: 'building_complete',
        iteration: iteration.number,
        codeLength: execution.code.length,
        duration_ms: buildDuration
      }, `Build completed in ${buildDuration}ms`);

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
        
        phaseLogger.info({
          type: 'build_success',
          iteration: iteration.number,
          duration_ms: Date.now() - startTime
        }, `Build iteration ${iteration.number} succeeded`);
        
        return true;
      } else {
        iteration.state = "error";
        iteration.errors = testResult.errors;
        execution.errors.push(...testResult.errors);
        
        this.emitEvent(sessionId, "build_errors", {
          iteration: iteration.number,
          errors: testResult.errors
        });
        
        phaseLogger.warn({
          type: 'build_errors',
          iteration: iteration.number,
          errorCount: testResult.errors.length,
          errors: testResult.errors
        }, `Build iteration ${iteration.number} has ${testResult.errors.length} errors`);
        
        return false;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      executionDuration.observe({ phase: 'building', status: 'failed' }, duration / 1000);
      
      iteration.state = "error";
      iteration.errors = [error.message];
      execution.errors.push(error.message);
      
      this.emitEvent(sessionId, "building_failed", {
        iteration: iteration.number,
        error: error.message
      });
      
      logError(phaseLogger, error, {
        type: 'building_failed',
        iteration: iteration.number,
        duration_ms: duration
      });
      
      return false;
    }
  }

  /**
   * Execute fix phase
   */
  async executeFix(sessionId, iteration) {
    const execution = this.executions.get(sessionId);
    const phaseLogger = createExecutionLogger(sessionId, `fixing-${iteration.number}`);
    const startTime = Date.now();
    
    this.transitionTo(sessionId, States.FIXING);
    this.emitEvent(sessionId, "fixing_start", {
      iteration: iteration.number,
      errors: iteration.errors
    });

    phaseLogger.info({
      type: 'fixing_start',
      iteration: iteration.number,
      errorCount: iteration.errors.length
    }, `Starting fix phase (iteration ${iteration.number})`);

    try {
      // Invoke fixer agent
      const fixPrompt = `The code has errors. Analyze and fix them.\n\nErrors:\n${iteration.errors.join('\n')}\n\nOriginal code:\n${execution.code}`;
      
      const recordAgent = recordAgentInvocation('fixer', 'microsoft');
      const fixResult = await execution.agents.fixer(fixPrompt);
      recordAgent('success');
      
      const duration = Date.now() - startTime;
      executionDuration.observe({ phase: 'fixing', status: 'success' }, duration / 1000);
      
      this.emitEvent(sessionId, "fixing_complete", {
        iteration: iteration.number,
        tokens: fixResult.tokenCount || 0
      });

      recordFixerResult('fixed');
      
      logPerformance(phaseLogger, 'fixing_phase', duration, {
        iteration: iteration.number,
        tokens: fixResult.tokenCount || 0
      });

      phaseLogger.info({
        type: 'fixing_complete',
        iteration: iteration.number,
        duration_ms: duration
      }, `Fix applied for iteration ${iteration.number}`);
      
      // The next iteration will use the fixed approach
      return true;
    } catch (error) {
      const duration = Date.now() - startTime;
      executionDuration.observe({ phase: 'fixing', status: 'failed' }, duration / 1000);
      
      recordFixerResult('failed');
      
      this.emitEvent(sessionId, "fixing_failed", {
        iteration: iteration.number,
        error: error.message
      });
      
      logError(phaseLogger, error, {
        type: 'fixing_failed',
        iteration: iteration.number,
        duration_ms: duration
      });
      
      return false;
    }
  }

  /**
   * Write code to sandbox
   */
  async writeCodeToSandbox(sessionId, code) {
    const execution = this.executions.get(sessionId);
    const sessionLogger = execution.logger;
    
    sessionLogger.debug({
      type: 'write_code_start',
      codeLength: code.length
    }, 'Writing code to sandbox');
    
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
        
        sessionLogger.debug({
          type: 'file_written',
          filepath,
          size: content.length
        }, `Wrote file: ${filepath}`);
      } catch (error) {
        logError(sessionLogger, error, {
          type: 'file_write_failed',
          filepath
        });
      }
    }

    sessionLogger.info({
      type: 'write_code_complete',
      filesWritten
    }, `Wrote ${filesWritten} files to sandbox`);
    
    return filesWritten;
  }

  /**
   * Test code in sandbox
   */
  async testCode(sessionId) {
    const execution = this.executions.get(sessionId);
    const sessionLogger = execution.logger;
    
    sessionLogger.debug({
      type: 'test_code_start'
    }, 'Testing code in sandbox');
    
    const errors = [];

    try {
      // Check for package.json and install dependencies
      const pkgResult = await sandboxManager.execInContainer(sessionId, "test -f package.json && echo 'found' || echo 'not found'");
      
      if (pkgResult.output.includes('found')) {
        this.emitEvent(sessionId, "installing_dependencies", { message: "Installing npm packages..." });
        
        sessionLogger.info({
          type: 'installing_dependencies'
        }, 'Installing npm dependencies');
        
        const installResult = await sandboxManager.execInContainer(sessionId, "npm install --production", 120000);
        
        if (!installResult.success) {
          errors.push(`npm install failed: ${installResult.output}`);
        }
      }

      // Try to run basic syntax checks
      const jsFiles = await sandboxManager.execInContainer(sessionId, "find . -name '*.js' -o -name '*.ts'");
      
      if (jsFiles.success && jsFiles.output) {
        const files = jsFiles.output.split('\n').filter(f => f.trim());
        
        sessionLogger.debug({
          type: 'syntax_check_start',
          fileCount: files.length
        }, `Checking syntax for ${files.length} files`);
        
        for (const file of files.slice(0, 10)) { // Check first 10 files
          const syntaxCheck = await sandboxManager.execInContainer(sessionId, `node --check ${file}`);
          
          if (!syntaxCheck.success) {
            errors.push(`Syntax error in ${file}: ${syntaxCheck.output}`);
          }
        }
      }

      const success = errors.length === 0;
      
      sessionLogger.info({
        type: 'test_code_complete',
        success,
        errorCount: errors.length
      }, success ? 'Code tests passed' : `Code tests failed with ${errors.length} errors`);

      return {
        success,
        errors
      };
    } catch (error) {
      logError(sessionLogger, error, {
        type: 'test_code_failed'
      });
      
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

    execution.logger.info({
      type: 'state_transition',
      from: oldState,
      to: newState,
      ...data
    }, `State transition: ${oldState} → ${newState}`);

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

    execution.logger.debug({
      type: 'event_emitted',
      eventType: type,
      eventData: data
    }, `Event: ${type}`);

    // If there's a callback, call it
    if (execution.options.onEvent) {
      execution.options.onEvent(event);
    }
  }

  /**
   * Handle timeout
   */
  async handleTimeout(sessionId) {
    const execution = this.executions.get(sessionId);
    
    if (!execution) return;

    const sessionLogger = execution.logger;
    const duration = Date.now() - execution.startTime;
    
    sessionLogger.error({
      type: 'execution_timeout',
      duration_ms: duration,
      iterations: execution.currentIteration
    }, `Execution timeout after ${Math.round(duration / 1000)}s`);

    this.transitionTo(sessionId, States.TIMEOUT);
    this.metrics.failed++;

    this.emitEvent(sessionId, "execution_timeout", {
      duration,
      iterations: execution.currentIteration
    });

    // Cleanup
    await sandboxManager.destroyContainer(sessionId, "timeout");
  }

  /**
   * Stop execution
   */
  async stopExecution(sessionId, reason = "manual") {
    const execution = this.executions.get(sessionId);
    
    if (!execution) {
      logger.warn({
        type: 'stop_execution_failed',
        sessionId,
        reason: 'not_found'
      }, `Cannot stop execution - not found for session ${sessionId}`);
      return { success: false, error: "Execution not found" };
    }

    const sessionLogger = execution.logger;
    
    sessionLogger.warn({
      type: 'stop_execution',
      reason,
      duration_ms: Date.now() - execution.startTime
    }, `Stopping execution (reason: ${reason})`);

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

    execution.logger.debug({
      type: 'cleanup_execution'
    }, 'Cleaning up execution');

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
