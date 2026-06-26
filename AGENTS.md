# Developer & Agent Guidelines (AGENTS.md)

Welcome! This document outlines the architecture, execution mechanics, safety guardrails, and best practices for developing and maintaining the **JavaScript Code Tracer VS Code Extension**.

---

## 🏗️ Architecture Overview

The extension works by taking a JavaScript file, parsing and modifying its AST, executing it in a secure background process, and overlaying the recorded state directly in the VS Code editor:

1. **`src/extension.ts` (Host Orchestrator)**: Handles VS Code activation, file save event listeners, trigger commands, trace result formatting, and drawing decorations (`vscode.window.createTextEditorDecorationType`) or error markers.
2. **`src/instrumenter.ts` (AST Rewriter)**: Uses Babel (`@babel/parser`, `@babel/traverse`, `@babel/generator`) to parse JS, find assignments, updates, mutations, loop iteration variables (including destructuring), function parameters, standalone expression statements, returns, and conditions, and wrap/inject them with `__traceVar(line, name, val)` probes.
3. **`src/runner.ts` (Background Runner)**: Detects if Bun is installed (using it if available for sub-millisecond execution, or falling back to Node.js). It writes a hidden file in the same directory as the target, executes it under a timeout, parses stdout, and cleans up.

---

## 🛡️ Guardrails & Performance Safety

To ensure that the extension remains extremely responsive and doesn't crash VS Code or leak memory, several guardrails are in place:

### 1. CPU & Loop Guardrails (runner.ts)
* **Execution Timeout:** The execution process is capped at a strict timeout of **2000ms**. If code has an infinite loop (e.g., `while(true)`), it will be forcibly killed (`SIGKILL`) after 2 seconds.
* **Process Concurrency Management:** If a user saves a file while a trace is already running, the previous child process is immediately terminated via `SIGKILL` before the new run starts. This prevents child processes from piling up and eating CPU.

### 2. Memory & Payload Guardrails (instrumenter.ts)
* **Trace Limits:** The injected tracker caps maximum total records to `1000` (`MAX_TOTAL_TRACES`).
* **Line Frequency Capping:** A single variable at a specific line cannot log more than `20` states (`MAX_LINE_TRACES`). If a loop runs 500 times, only the first 20 mutations are tracked. This prevents massive stringified trace objects from exhausting memory (OOM) or causing lag in VS Code.
* **Safe Serialization:** `__traceVar` wraps variable values using a recursive `safeClone` helper. It safely handles functions, BigInts, undefined, circular references (replaces with `'[Circular]'`), and correctly serializes `Map` and `Set` collections into readable objects and arrays without crashing.

### 3. Module Resolution (runner.ts)
* **Hidden Local Temp Files:** The temp file `.scriptname.tracer-temp.js` is written into the **same folder** as the active script, rather than a global temp directory. This is critical so that relative imports (e.g., `import { x } from './utils'`) and `node_modules` resolves successfully during tracing.

---

## 📋 Dos and Don'ts

### Dos
* **Do** register all decoration types and listeners in `context.subscriptions` within `src/extension.ts` to prevent memory leaks in VS Code.
* **Do** run processes asynchronously (`exec` with callbacks/promises) so the extension host thread never freezes.
* **Do** keep variable formatting logic (`formatValue`) compact. Show truncated states (e.g. `[1, 2, 3, ... (10 items)]`) for cleaner UI rendering.
* **Do** use smart visual truncation (`formatVarTrace`) to automatically collapse long loop transition chains into `first → ... → last` or just `last` to keep editor comments from overflowing.
* **Do** filter out built-in global objects (like `console`, `Math`, `JSON`, `process`, `Array`, `Map`, `Set`, `Promise`) during AST traversal to avoid tracing standard library namespaces.

### Don'ts
* **Don't** store or cache large AST representations or string payloads in global memory. Always clear or garbage-collect them.
* **Don't** move the temporary execution file to a system directory (like `/tmp` or `C:\Users\...\AppData\Local\Temp`), as relative module imports and local package resolutions will fail.
* **Don't** throw errors to break loops inside `__traceVar`. Simply return early if limits are hit. Throwing errors alters user script outcomes, whereas we only want to spy on execution.
