import * as fs from 'fs';
import * as path from 'path';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TraceEvent {
  line: number;
  name: string;
  value: any;
}

export interface RunnerResult {
  success: boolean;
  traces: TraceEvent[];
  error?: string;
}

let isBunCached: boolean | null = null;
const runningProcesses = new Map<string, ChildProcess>();

async function checkBunAvailable(): Promise<boolean> {
  if (isBunCached !== null) {
    return isBunCached;
  }
  try {
    await execAsync('bun --version');
    isBunCached = true;
  } catch {
    isBunCached = false;
  }
  return isBunCached;
}

/**
 * Runs the instrumented code in the background and returns parsed trace logs.
 * Writes a temporary file in the same directory as originalFilePath to ensure
 * relative imports and require paths work correctly.
 */
export async function runTracedCode(
  originalFilePath: string,
  instrumentedCode: string,
  runtime: 'auto' | 'bun' | 'node' = 'auto',
  timeoutMs: number = 2000
): Promise<RunnerResult> {
  const dir = path.dirname(originalFilePath);
  const ext = path.extname(originalFilePath);
  const baseName = path.basename(originalFilePath, ext);
  // Hidden temporary file
  const tempFileName = `.${baseName}.tracer-temp${ext}`;
  const tempFilePath = path.join(dir, tempFileName);

  // 1. Cancel previous execution for the same file if still running
  const existingProcess = runningProcesses.get(originalFilePath);
  if (existingProcess) {
    try {
      existingProcess.kill('SIGKILL');
    } catch (e) {
      // Ignore process kill errors
    }
    runningProcesses.delete(originalFilePath);
  }

  // 2. Write the instrumented code to the temp file
  try {
    fs.writeFileSync(tempFilePath, instrumentedCode, 'utf8');
  } catch (err: any) {
    return {
      success: false,
      traces: [],
      error: `Failed to write instrumented temporary file: ${err.message}`,
    };
  }

  // 3. Determine whether to run with Bun or Node.js
  let useBun = false;
  if (runtime === 'auto') {
    useBun = await checkBunAvailable();
  } else if (runtime === 'bun') {
    useBun = true;
  }
  const runnerCmd = useBun ? 'bun run' : 'node';
  // Escape filepath in case it contains spaces
  const command = `${runnerCmd} "${tempFilePath}"`;

  // 4. Execute with a timeout to prevent infinite loops
  return new Promise<RunnerResult>((resolve) => {
    const processTimeout = timeoutMs;
    
    const child = exec(
      command,
      { cwd: dir, timeout: processTimeout },
      (execError, stdout, stderr) => {
        // Remove from active processes map
        if (runningProcesses.get(originalFilePath) === child) {
          runningProcesses.delete(originalFilePath);
        }

        // Always clean up temp file
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }

        if (execError) {
          if (execError.killed) {
            return resolve({
              success: false,
              traces: [],
              error: `Execution timed out (limit: ${processTimeout}ms). Please check for infinite loops.`,
            });
          }
          // Do not report error if we deliberately killed it to restart execution
          if (execError.signal === 'SIGKILL') {
            return resolve({
              success: false,
              traces: [],
              error: 'Execution cancelled (new execution started).',
            });
          }
          return resolve({
            success: false,
            traces: [],
            error: stderr || execError.message,
          });
        }

        // 5. Parse the traces from stdout
        const marker = '__TRACE_RESULT__:';
        const markerIndex = stdout.indexOf(marker);

        if (markerIndex === -1) {
          return resolve({
            success: false,
            traces: [],
            error: stderr || 'Execution finished but trace marker was not found in console output.',
          });
        }

        try {
          const traceJsonStr = stdout.substring(markerIndex + marker.length).trim();
          const traces: TraceEvent[] = JSON.parse(traceJsonStr);
          return resolve({
            success: true,
            traces,
          });
        } catch (parseError: any) {
          return resolve({
            success: false,
            traces: [],
            error: `Failed to parse trace data: ${parseError.message}`,
          });
        }
      }
    );

    // Register running process
    runningProcesses.set(originalFilePath, child);
  });
}
