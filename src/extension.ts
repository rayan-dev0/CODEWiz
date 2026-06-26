import * as vscode from 'vscode';
import { instrumentCode } from './instrumenter';
import { runTracedCode, TraceEvent } from './runner';

// Single decoration type for traces
const traceDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 2.5em',
    color: new vscode.ThemeColor('editorGhostText.foreground'),
    fontStyle: 'italic',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

// Decoration type for errors (red, bold)
const errorDecorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 2.5em',
    color: new vscode.ThemeColor('errorForeground'),
    fontWeight: 'bold',
    fontStyle: 'italic',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

const activeTraces = new Set<string>();

function updateEnabledContext(editor: vscode.TextEditor | undefined) {
  if (editor && editor.document.languageId === 'javascript') {
    const isEnabled = activeTraces.has(editor.document.uri.toString());
    vscode.commands.executeCommand('setContext', 'codewiz.enabled', isEnabled);
  } else {
    vscode.commands.executeCommand('setContext', 'codewiz.enabled', false);
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Command: Enable Tracing
  let traceCommand = vscode.commands.registerCommand('codewiz.enableTracing', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await runTracer(editor);
    } else {
      vscode.window.showInformationMessage('Open a JavaScript file to enable tracing.');
    }
  });

  // Command: Disable Tracing
  let clearCommand = vscode.commands.registerCommand('codewiz.disableTracing', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      clearDecorations(editor);
      activeTraces.delete(editor.document.uri.toString());
      updateEnabledContext(editor);
      vscode.window.setStatusBarMessage('$(check) CODEWiz: Disabled', 2000);
    }
  });

  // Auto-run on save
  let saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    const config = vscode.workspace.getConfiguration('codewiz');
    const runOnSave = config.get<boolean>('runOnSave', true);
    if (runOnSave && document.languageId === 'javascript') {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
      if (editor) {
        await runTracer(editor);
      }
    }
  });

  // Active Editor change listener
  let activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateEnabledContext(editor);
  });

  // Initialize context key for current active editor
  updateEnabledContext(vscode.window.activeTextEditor);

  context.subscriptions.push(
    traceDecorationType,
    errorDecorationType,
    traceCommand,
    clearCommand,
    saveListener,
    activeEditorListener
  );
}

export function deactivate() {}

async function runTracer(editor: vscode.TextEditor) {
  const document = editor.document;
  const originalCode = document.getText();
  const filePath = document.fileName;

  // Clear previous decorations before starting
  clearDecorations(editor);

  // Status bar feedback
  vscode.window.setStatusBarMessage('$(sync~spin) CODEWiz: Running...', 2000);

  // Read config settings
  const config = vscode.workspace.getConfiguration('codewiz');
  const runtime = config.get<'auto' | 'bun' | 'node'>('runtime', 'auto');
  const timeout = config.get<number>('timeout', 2000);
  const maxTotalTraces = config.get<number>('maxTotalTraces', 1000);
  const maxLineTraces = config.get<number>('maxLineTraces', 20);
  const traceMode = config.get<'all' | 'comment' | 'smart'>('traceMode', 'smart');
  const showRawInHover = config.get<boolean>('showRawInHover', false);

  // Detect lines ending with //?
  const lines = originalCode.split('\n');
  const commentLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().endsWith('//?')) {
      commentLines.push(i + 1); // 1-indexed
    }
  }

  let targetLines: number[] | undefined = undefined;
  if (traceMode === 'comment') {
    targetLines = commentLines;
  } else if (traceMode === 'smart') {
    if (commentLines.length > 0) {
      targetLines = commentLines;
    }
  }

  try {
    // 1. Instrument the code
    const instrumented = instrumentCode(originalCode, maxTotalTraces, maxLineTraces, targetLines);

    // 2. Run the instrumented code
    const result = await runTracedCode(filePath, instrumented, runtime, timeout);

    if (!result.success) {
      // Handle runner execution error
      const errorMsg = result.error || 'Unknown execution error';
      handleExecutionError(editor, errorMsg);
      activeTraces.add(document.uri.toString());
      updateEnabledContext(editor);
      return;
    }

    // 3. Process the traces
    applyTraces(editor, result.traces, maxLineTraces, showRawInHover);
    activeTraces.add(document.uri.toString());
    updateEnabledContext(editor);
    vscode.window.setStatusBarMessage('$(check) CODEWiz: Done', 2000);

  } catch (err: any) {
    vscode.window.showErrorMessage(`CODEWiz Instrumentation Error: ${err.message}`);
    activeTraces.add(document.uri.toString());
    updateEnabledContext(editor);
    vscode.window.setStatusBarMessage('$(error) CODEWiz: Failed', 2000);
  }
}

function clearDecorations(editor: vscode.TextEditor) {
  editor.setDecorations(traceDecorationType, []);
  editor.setDecorations(errorDecorationType, []);
}

function handleExecutionError(editor: vscode.TextEditor, errorMsg: string) {
  // Try to parse the line number from the error message.
  // Standard Node/Bun stack traces formats are:
  // "at file.js:line:column" or "tempFileName:line:column" or "tempFileName:line"
  const lineRegexes = [
    /:(\d+):(\d+)/, // e.g. :12:34
    /:(\d+)\b/,     // e.g. :12
  ];

  let errorLine = -1;
  for (const regex of lineRegexes) {
    const match = errorMsg.match(regex);
    if (match) {
      errorLine = parseInt(match[1], 10);
      break;
    }
  }

  // Set the error decoration
  if (errorLine > 0 && errorLine <= editor.document.lineCount) {
    // VS Code lines are 0-indexed, stack trace is 1-indexed
    const lineIndex = errorLine - 1;
    const line = editor.document.lineAt(lineIndex);
    const range = new vscode.Range(line.range.end, line.range.end);
    
    // Clean up the error message to be short for inline display
    const firstLine = errorMsg.split('\n')[0].replace(/__.*tracer-temp\.js:?/g, '');

    const decoration: vscode.DecorationOptions = {
      range,
      renderOptions: {
        after: {
          contentText: ` // ❌ Error: ${firstLine}`,
        },
      },
    };
    editor.setDecorations(errorDecorationType, [decoration]);
  } else {
    // If line is not found, fallback to status bar alert
    vscode.window.showWarningMessage(`CODEWiz: ${errorMsg}`);
  }
  vscode.window.setStatusBarMessage('$(error) CODEWiz: Error', 2000);
}

function applyTraces(editor: vscode.TextEditor, traces: TraceEvent[], maxLineTraces: number, showRawInHover: boolean) {
  // Group trace logs by line number
  const tracesByLine = new Map<number, TraceEvent[]>();
  for (const t of traces) {
    if (!tracesByLine.has(t.line)) {
      tracesByLine.set(t.line, []);
    }
    tracesByLine.get(t.line)!.push(t);
  }

  const decorations: vscode.DecorationOptions[] = [];

  for (const [lineNum, lineEvents] of tracesByLine.entries()) {
    // Line numbers in Babel AST are 1-indexed, VS Code ranges are 0-indexed
    const lineIndex = lineNum - 1;
    if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
      continue;
    }

    const line = editor.document.lineAt(lineIndex);
    const range = new vscode.Range(line.range.end, line.range.end);

    // Group updates by variable name in case a line updates multiple variables (or the same one)
    const varsMap = new Map<string, any[]>();
    for (const event of lineEvents) {
      // Skip function values to prevent '[Function]' noise
      if (event.value === '[Function]') {
        continue;
      }
      if (!varsMap.has(event.name)) {
        varsMap.set(event.name, []);
      }
      varsMap.get(event.name)!.push(event.value);
    }

    // Format strings for all variables on this line
    const varTextList: string[] = [];
    for (const [varName, values] of varsMap.entries()) {
      const formattedTrace = formatVarTrace(varName, values);
      if (formattedTrace) {
        varTextList.push(formattedTrace);
      }
    }

    if (varTextList.length > 0) {
      const endsWithQ = line.text.trim().endsWith('//?');
      const prefix = endsWithQ ? ' => ' : ' // ';
      const hoverMessage = buildHoverMessage(lineNum, varsMap, maxLineTraces, showRawInHover, lineEvents);
      decorations.push({
        range,
        hoverMessage,
        renderOptions: {
          after: {
            contentText: `${prefix}${varTextList.join(', ')}`,
          },
        },
      });
    }
  }

  editor.setDecorations(traceDecorationType, decorations);
}

function buildHoverMessage(
  lineNum: number,
  varsMap: Map<string, any[]>,
  maxLineTraces: number,
  showRawInHover: boolean,
  lineEvents: TraceEvent[]
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  
  md.appendMarkdown(`### 🔍 Traces for Line ${lineNum}\n\n`);
  
  for (const [varName, values] of varsMap.entries()) {
    const displayName = varName ? `\`${varName}\`` : 'Expression';
    const count = values.length;
    const isCapped = count >= maxLineTraces;
    const countText = count === 1 ? '1 update' : `${count} updates`;
    
    md.appendMarkdown(`---\n\n#### 📦 ${displayName} (${countText})\n\n`);
    
    if (isCapped) {
      md.appendMarkdown(`⚠️ *Truncated: showing first ${maxLineTraces} updates.*\n\n`);
    }
    
    if (count === 1) {
      const val = values[0];
      if (isComplex(val)) {
        md.appendCodeblock(JSON.stringify(val, null, 2), 'json');
      } else {
        md.appendMarkdown(`* Value: \`${formatPrimitive(val)}\`\n`);
      }
    } else {
      // Multiple updates
      const hasComplex = values.some(isComplex);
      if (hasComplex) {
        for (let i = 0; i < values.length; i++) {
          const val = values[i];
          md.appendMarkdown(`**Update #${i + 1}:**\n`);
          if (isComplex(val)) {
            md.appendCodeblock(JSON.stringify(val, null, 2), 'json');
          } else {
            md.appendMarkdown(`\`${formatPrimitive(val)}\`\n\n`);
          }
        }
      } else {
        // All simple: list them
        for (let i = 0; i < values.length; i++) {
          md.appendMarkdown(`${i + 1}. \`${formatPrimitive(values[i])}\`\n`);
        }
      }
    }
    md.appendMarkdown('\n');
  }
  
  if (showRawInHover && lineEvents.length > 0) {
    md.appendMarkdown(`---\n\n<details>\n<summary>🛠️ View Raw JSON Traces</summary>\n\n`);
    md.appendCodeblock(JSON.stringify(lineEvents, null, 2), 'json');
    md.appendMarkdown(`\n</details>\n`);
  }
  
  return md;
}

function isComplex(val: any): boolean {
  return val !== null && typeof val === 'object';
}

function formatPrimitive(val: any): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return `'${val}'`;
  return String(val);
}

function formatVarTrace(name: string, values: any[]): string {
  if (values.length === 0) return '';
  
  const formattedValues = values.map(v => formatValue(v));

  if (formattedValues.length === 1) {
    return name ? `${name}: ${formattedValues[0]}` : formattedValues[0];
  }

  // Calculate the total length of the joined string
  const totalLength = formattedValues.reduce((sum, s) => sum + s.length, 0) + (formattedValues.length - 1) * 3;

  if (totalLength <= 40) {
    const prefix = name ? `${name}: ` : '';
    return `${prefix}${formattedValues.join(' → ')}`;
  }

  const first = formattedValues[0];
  const last = formattedValues[formattedValues.length - 1];

  const compressed = `${first} → ... → ${last}`;
  if (compressed.length <= 50) {
    const prefix = name ? `${name}: ` : '';
    return `${prefix}${compressed}`;
  }

  return name ? `${name}: ${last}` : last;
}

function formatValue(val: any): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = val.map(v => formatValue(v));
    if (items.length > 4) {
      return `[${items.slice(0, 3).join(', ')}, ... (${val.length} items)]`;
    }
    return `[${items.join(', ')}]`;
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    const parts = keys.slice(0, 3).map(k => `${k}: ${formatValue(val[k])}`);
    if (keys.length > 3) {
      return `{ ${parts.join(', ')}, ... }`;
    }
    return `{ ${parts.join(', ')} }`;
  }

  if (typeof val === 'string') {
    return `'${val}'`;
  }

  return String(val);
}
