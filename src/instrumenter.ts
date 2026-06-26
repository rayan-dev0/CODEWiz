import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

export function instrumentCode(code: string, maxTotal: number = 1000, maxLine: number = 20, targetLines?: number[]): string {
  // Parse code into AST. We enable common plugins to support modern JS/TS syntax.
  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
    errorRecovery: true,
  });

  const shouldTraceLine = (line: number): boolean => {
    if (!targetLines || targetLines.length === 0) return true;
    return targetLines.includes(line);
  };

  // Traverse AST and inject traces
  traverse(ast, {
    // 1. Variable Declarations
    VariableDeclaration(path) {
      if (isSkipped(path)) return;

      const parent = path.parent;
      // Handle loop iteration variables for for, for...in, for...of loops
      if (t.isForInStatement(parent) || t.isForOfStatement(parent) || (t.isForStatement(parent) && parent.init === path.node)) {
        const line = parent.loc?.start.line || 0;
        if (!shouldTraceLine(line)) return;

        const declarations = path.node.declarations;
        const traceStatements: t.Statement[] = [];

        for (const decl of declarations) {
          const bindings = t.getBindingIdentifiers(decl.id);
          for (const name of Object.keys(bindings)) {
            traceStatements.push(
              t.expressionStatement(
                t.callExpression(t.identifier('__traceVar'), [
                  t.numericLiteral(line),
                  t.stringLiteral(name),
                  t.identifier(name),
                ])
              )
            );
          }
        }

        if (traceStatements.length > 0) {
          const bodyPath = path.parentPath.get('body') as NodePath;
          if (bodyPath.isBlockStatement()) {
            bodyPath.unshiftContainer('body', traceStatements);
          } else {
            const originalBodyNode = bodyPath.node as t.Statement;
            bodyPath.replaceWith(t.blockStatement([
              ...traceStatements,
              originalBodyNode
            ]));
          }
        }
        return;
      }

      const declarations = path.node.declarations;
      const traceStatements: t.Statement[] = [];

      for (const decl of declarations) {
        if (t.isIdentifier(decl.id) && decl.init) {
          // Skip functions and classes to prevent '[Function]' noise
          if (
            t.isFunctionExpression(decl.init) ||
            t.isArrowFunctionExpression(decl.init) ||
            t.isClassExpression(decl.init)
          ) {
            continue;
          }

          const name = decl.id.name;
          const line = decl.loc?.start.line || 0;
          if (shouldTraceLine(line)) {
            traceStatements.push(
              t.expressionStatement(
                t.callExpression(t.identifier('__traceVar'), [
                  t.numericLiteral(line),
                  t.stringLiteral(name),
                  t.identifier(name),
                ])
              )
            );
          }
        }
      }

      if (traceStatements.length > 0) {
        // Insert after the declaration statement if it's in a body list
        if (path.parentPath && (path.parentPath.isBlockStatement() || path.parentPath.isProgram())) {
          path.insertAfter(traceStatements);
        }
      }
    },

    // 2. Assignment Expressions (e.g. x = 5, arr[i] = 10, obj.prop = val)
    AssignmentExpression(path) {
      if (isSkipped(path)) return;

      // Check if expression contains await or yield to avoid wrapping issues
      if (containsAwaitOrYield(path)) return;

      const left = path.node.left;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;

      let baseName: string | null = null;
      let baseIdentifier: t.Identifier | null = null;

      if (t.isIdentifier(left)) {
        baseName = left.name;
        baseIdentifier = left;
      } else if (t.isMemberExpression(left)) {
        let current: t.Expression = left;
        while (t.isMemberExpression(current)) {
          current = current.object;
        }
        if (t.isIdentifier(current)) {
          baseName = current.name;
          baseIdentifier = current;
        }
      }

      if (baseName && baseIdentifier) {
        const wrapper = createTraceWrapper(line, baseName, baseIdentifier, path.node);
        path.replaceWith(wrapper);
        path.skip();
      }
    },

    // 3. Update Expressions (e.g. i++, ++i)
    UpdateExpression(path) {
      if (isSkipped(path)) return;
      if (containsAwaitOrYield(path)) return;

      const argument = path.node.argument;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;

      if (t.isIdentifier(argument)) {
        const name = argument.name;
        const wrapper = createTraceWrapper(line, name, argument, path.node);
        path.replaceWith(wrapper);
        path.skip();
      }
    },

    // 4. Call Expressions on Member Expressions (e.g. arr.push(1))
    CallExpression(path) {
      if (isSkipped(path)) return;
      if (containsAwaitOrYield(path)) return;

      const callee = path.node.callee;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;

      if (t.isMemberExpression(callee)) {
        let current: t.Expression = callee.object;
        while (t.isMemberExpression(current)) {
          current = current.object;
        }
        if (t.isIdentifier(current)) {
          const name = current.name;

          const ignored = [
            'console', 'Math', 'JSON', 'process', 'window', 'document',
            'Array', 'Object', 'String', 'Number', 'Boolean', 'RegExp',
            'Date', 'Promise', 'Map', 'Set', 'Error', 'Symbol', 'Reflect', 'Proxy'
          ];
          if (!ignored.includes(name)) {
            const wrapper = createTraceWrapper(line, name, current, path.node);
            path.replaceWith(wrapper);
            path.skip();
          }
        }
      }
    },

    // 5. Function Declarations / Expressions (tracing input parameters at function entry)
    Function(path) {
      if (isSkipped(path)) return;

      const params = path.node.params;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;
      const traceStatements: t.Statement[] = [];

      for (const param of params) {
        let name: string | null = null;
        if (t.isIdentifier(param)) {
          name = param.name;
        } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
          name = param.left.name;
        }

        if (name) {
          traceStatements.push(
            t.expressionStatement(
              t.callExpression(t.identifier('__traceVar'), [
                t.numericLiteral(line),
                t.stringLiteral(name),
                t.identifier(name),
              ])
            )
          );
        }
      }

      if (traceStatements.length > 0) {
        const bodyPath = path.get('body');
        if (bodyPath.isBlockStatement()) {
          bodyPath.unshiftContainer('body', traceStatements);
        } else if (bodyPath.isExpression()) {
          // Expression-body arrow function: (x) => expr
          // Transform to: (x) => (__traceVar(line, "x", x), expr)
          const sequenceExprs: t.Expression[] = [];
          for (const stmt of traceStatements) {
            if (t.isExpressionStatement(stmt)) {
              sequenceExprs.push(stmt.expression);
            }
          }
          sequenceExprs.push(bodyPath.node);
          bodyPath.replaceWith(t.sequenceExpression(sequenceExprs));
          bodyPath.skip();
        }
      }
    },

    // 6. Expression Statements (tracing the final value of standalone expressions)
    ExpressionStatement(path) {
      if (isSkipped(path)) return;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;

      const expr = path.node.expression;
      // Skip if it is already wrapped or it's a traceVar function call
      if (t.isCallExpression(expr)) {
        if (t.isArrowFunctionExpression(expr.callee)) return;
        if (t.isIdentifier(expr.callee) && expr.callee.name === '__traceVar') return;
      }
      // Skip declarations and assignments, which are handled by their own visitors
      if (t.isAssignmentExpression(expr) || t.isUpdateExpression(expr)) {
        return;
      }

      const wrapper = createExpressionWrapper(line, '', expr);
      path.get('expression').replaceWith(wrapper);
      path.skip();
    },

    // 7. Return Statements (tracing returning values)
    ReturnStatement(path) {
      if (isSkipped(path)) return;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;

      const arg = path.node.argument;
      if (arg) {
        if (t.isCallExpression(arg) && t.isArrowFunctionExpression(arg.callee)) return;

        const wrapper = createExpressionWrapper(line, '', arg);
        const argPath = path.get('argument');
        argPath.replaceWith(wrapper);
        argPath.skip();
      }
    },

    // 8. If Statements (tracing conditional test results)
    IfStatement(path) {
      if (isSkipped(path)) return;
      const line = path.node.loc?.start.line || 0;
      if (!shouldTraceLine(line)) return;

      const test = path.node.test;
      if (t.isCallExpression(test) && t.isArrowFunctionExpression(test.callee)) return;

      const wrapper = createExpressionWrapper(line, '', test);
      const testPath = path.get('test');
      testPath.replaceWith(wrapper);
      testPath.skip();
    },
  });

  // Injection of tracer setup code
  const preamble = `
const __trace = [];
const __traceCount = {};
const MAX_TOTAL_TRACES = ${maxTotal};
const MAX_LINE_TRACES = ${maxLine};

function safeClone(val, seen = new Set()) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'function') return '[Function]';
  if (typeof val === 'bigint') return val.toString();
  if (typeof val !== 'object') return val;
  
  if (seen.has(val)) return '[Circular]';
  seen.add(val);
  
  if (val instanceof Map) {
    const obj = {};
    val.forEach((v, k) => {
      obj[String(k)] = safeClone(v, seen);
    });
    seen.delete(val);
    return obj;
  }
  
  if (val instanceof Set) {
    const arr = Array.from(val).map(v => safeClone(v, seen));
    seen.delete(val);
    return arr;
  }
  
  if (Array.isArray(val)) {
    const arr = val.map(v => safeClone(v, seen));
    seen.delete(val);
    return arr;
  }
  
  const obj = {};
  for (const k in val) {
    if (Object.prototype.hasOwnProperty.call(val, k)) {
      obj[k] = safeClone(val[k], seen);
    }
  }
  seen.delete(val);
  return obj;
}

function __traceVar(line, name, value) {
  try {
    if (__trace.length >= MAX_TOTAL_TRACES) return;

    const key = line + ":" + name;
    __traceCount[key] = (__traceCount[key] || 0) + 1;
    if (__traceCount[key] > MAX_LINE_TRACES) return;

    __trace.push({ line, name, value: safeClone(value) });
  } catch (e) {
    __trace.push({ line, name, value: String(value) });
  }
}
`;

  // Output trace results at the end
  const epilogue = `
\nconsole.log("\\n__TRACE_RESULT__:" + JSON.stringify(__trace));
`;

  const output = generate(ast, {}, code);
  return preamble + output.code + epilogue;
}

function isSkipped(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (t.isArrowFunctionExpression(current.node)) {
      const body = current.node.body;
      if (t.isSequenceExpression(body)) {
        for (const expr of body.expressions) {
          if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && expr.callee.name === '__traceVar') {
            return true;
          }
        }
      }
    }
    current = current.parentPath;
  }
  return false;
}

function containsAwaitOrYield(path: NodePath): boolean {
  let found = false;
  path.traverse({
    AwaitExpression() { found = true; },
    YieldExpression() { found = true; }
  });
  return found;
}

function createTraceWrapper(line: number, name: string, baseIdentifier: t.Identifier, originalNode: t.Expression): t.Expression {
  const param = t.identifier('_val');
  const traceCall = t.callExpression(t.identifier('__traceVar'), [
    t.numericLiteral(line),
    t.stringLiteral(name),
    baseIdentifier,
  ]);
  const arrowFunction = t.arrowFunctionExpression(
    [param],
    t.sequenceExpression([traceCall, param])
  );
  return t.callExpression(arrowFunction, [originalNode]);
}

function createExpressionWrapper(line: number, name: string, originalNode: t.Expression): t.Expression {
  const param = t.identifier('_val');
  const traceCall = t.callExpression(t.identifier('__traceVar'), [
    t.numericLiteral(line),
    t.stringLiteral(name),
    param,
  ]);
  const arrowFunction = t.arrowFunctionExpression(
    [param],
    t.sequenceExpression([traceCall, param])
  );
  return t.callExpression(arrowFunction, [originalNode]);
}
