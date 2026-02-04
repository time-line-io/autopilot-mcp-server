/**
 * Lightweight AST evaluator for Node-RED registerType option objects.
 *
 * Goal: extract structured-ish JSON from node editor JS without executing it.
 * We intentionally keep this conservative and fall back to source strings for
 * dynamic expressions and functions.
 */

import type { Node as AcornNode } from "acorn";

function isPropertyKeyToString(prop: any) {
  if (!prop) return null;
  if (prop.computed) return null;
  if (prop.key && prop.key.type === "Identifier") return prop.key.name;
  if (prop.key && prop.key.type === "Literal") return String(prop.key.value);
  return null;
}

function sliceSource(src: string, node: any) {
  if (
    !src ||
    !node ||
    typeof node.start !== "number" ||
    typeof node.end !== "number"
  ) {
    return "";
  }
  return src.slice(node.start, node.end);
}

/**
 * Evaluate an expression node into a JSON-compatible value when possible.
 * For non-literal/dynamic nodes, returns an object with a `kind` and optional `source`.
 */
export function evalAst(
  node: AcornNode | any,
  env: Record<string, unknown> = {},
  src = ""
): any {
  if (!node) return null;

  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier": {
      if (Object.hasOwn(env, node.name)) return env[node.name];
      return { kind: "ref", name: node.name };
    }
    case "ArrayExpression":
      return (node.elements || []).map((el: any) => evalAst(el, env, src));
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties || []) {
        if (!prop || prop.type !== "Property") continue;
        const key = isPropertyKeyToString(prop);
        if (!key) continue;
        out[key] = evalAst(prop.value, env, src);
      }
      return out;
    }
    case "UnaryExpression": {
      const v = evalAst(node.argument, env, src);
      if (typeof v === "number" && node.operator === "-") return -v;
      if (typeof v === "number" && node.operator === "+") return +v;
      if (typeof v === "boolean" && node.operator === "!") return !v;
      return { kind: "expr", source: sliceSource(src, node) };
    }
    case "TemplateLiteral": {
      // Best-effort only when all expressions resolve to primitives.
      let s = "";
      for (let i = 0; i < node.quasis.length; i++) {
        s += node.quasis[i].value?.cooked ?? "";
        if (i < node.expressions.length) {
          const ev = evalAst(node.expressions[i], env, src);
          if (
            typeof ev === "string" ||
            typeof ev === "number" ||
            typeof ev === "boolean"
          ) {
            s += String(ev);
          } else {
            return { kind: "template", source: sliceSource(src, node) };
          }
        }
      }
      return s;
    }
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return { kind: "function", source: sliceSource(src, node) };
    case "CallExpression":
    case "MemberExpression":
    case "BinaryExpression":
    case "LogicalExpression":
    case "ConditionalExpression":
    case "NewExpression":
      return { kind: "expr", source: sliceSource(src, node) };
    default:
      return {
        kind: "unknown",
        type: node.type,
        source: sliceSource(src, node),
      };
  }
}

export function isRegisterTypeCallee(callee: any) {
  // Matches RED.nodes.registerType
  if (!callee || callee.type !== "MemberExpression") return false;
  const prop = callee.property;
  const propName =
    prop?.type === "Identifier"
      ? prop.name
      : prop?.type === "Literal"
        ? String(prop.value)
        : "";
  if (propName !== "registerType") return false;

  const obj = callee.object;
  if (!obj || obj.type !== "MemberExpression") return false;
  const objProp = obj.property;
  const objPropName =
    objProp?.type === "Identifier"
      ? objProp.name
      : objProp?.type === "Literal"
        ? String(objProp.value)
        : "";
  if (objPropName !== "nodes") return false;

  const root = obj.object;
  return root?.type === "Identifier" && root.name === "RED";
}

export function extractStringLiteral(node: any) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return null;
}
