/**
 * Parse Node-RED Admin API `/nodes` HTML into a structured node catalog.
 *
 * Node-RED renders an HTML document that includes per-module blocks:
 * <!-- --- [red-module:moduleName] --- --> ... HTML ...
 *
 * Within those blocks, node editor JS registers nodes via:
 * - RED.nodes.registerType("type", { ...options... })
 * - sometimes via small wrapper functions (e.g. reg(type,label,...))
 *
 * Help docs and edit templates live in:
 * - <script type="text/html" data-help-name="type">...</script>
 * - <script type="text/html" data-template-name="type">...</script>
 */

import * as acorn from "acorn";
import * as walk from "acorn-walk";
import * as cheerio from "cheerio";
import {
  evalAst,
  extractStringLiteral,
  isRegisterTypeCallee,
} from "./ast-eval.js";

function normalizeWhitespace(s: string) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string) {
  if (!html) return "";
  try {
    const $ = cheerio.load(String(html), { decodeEntities: true } as any);
    return normalizeWhitespace($.text());
  } catch {
    return normalizeWhitespace(String(html).replace(/<[^>]+>/g, " "));
  }
}

function splitModuleName(moduleName: string) {
  const s = String(moduleName || "");
  // moduleName typically looks like:
  // - node-red/inject
  // - @scope/pkg/set
  // - @scope/pkg
  const parts = s.split("/");
  if (s.startsWith("@") && parts.length >= 2) {
    const pkg = parts.slice(0, 2).join("/");
    const rest = parts.slice(2).join("/");
    return { module: s, modulePackage: pkg, moduleSet: rest || null };
  }
  return {
    module: s,
    modulePackage: parts[0] || s,
    moduleSet: parts.slice(1).join("/") || null,
  };
}

function extractScriptsAndDocs(moduleHtml: string) {
  const $ = cheerio.load(moduleHtml || "", { decodeEntities: false } as any);
  const js: string[] = [];
  const helpByType = new Map<string, string>();
  const templateByType = new Map<string, string>();

  $("script").each((_, el) => {
    const $el = $(el);
    const attrs = (el as any).attribs || {};
    const typeAttr = String(attrs.type || "").toLowerCase();
    const helpName = attrs["data-help-name"];
    const templateName = attrs["data-template-name"];
    const text = $el.html() ?? "";

    if (helpName) helpByType.set(String(helpName), String(text));
    if (templateName) templateByType.set(String(templateName), String(text));
    if (
      !helpName &&
      !templateName &&
      (typeAttr === "text/javascript" || typeAttr === "")
    ) {
      const code = String(text || "").trim();
      if (code) js.push(code);
    }
  });

  return { js, helpByType, templateByType };
}

function extractTemplateFields(templateHtml: string) {
  // Best-effort: locate IDs like node-input-foo / node-config-input-bar and map to field names.
  const fields: { node: string[]; config: string[]; all: string[] } = {
    node: [],
    config: [],
    all: [],
  };
  if (!templateHtml) return fields;
  try {
    const $ = cheerio.load(String(templateHtml), {
      decodeEntities: true,
    } as any);
    $("[id]").each((_, el) => {
      const id = String((el as any).attribs?.id || "");
      if (!id) return;
      let m = id.match(/^node-input-(.+)$/);
      if (m) {
        const name = m[1];
        fields.node.push(name);
        fields.all.push(name);
        return;
      }
      m = id.match(/^node-config-input-(.+)$/);
      if (m) {
        const name = m[1];
        fields.config.push(name);
        fields.all.push(name);
      }
    });
  } catch {
    // ignore
  }
  // De-dupe while preserving order
  const dedupe = (arr: string[]) => Array.from(new Set(arr.filter(Boolean)));
  fields.node = dedupe(fields.node);
  fields.config = dedupe(fields.config);
  fields.all = dedupe(fields.all);
  return fields;
}

function parseEditorJsForRegisterTypes(jsSource: string) {
  const found: Array<{ type: string; options: any; optionsSource: string }> =
    [];

  let ast: any;
  try {
    ast = (acorn as any).parse(jsSource, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
  } catch {
    return { found, warnings: ["acorn_parse_failed"] };
  }

  // Wrapper functions that directly call RED.nodes.registerType(param0, {..})
  const wrappers = new Map<
    string,
    { params: string[]; typeArg: any; optionsArg: any }
  >();

  function maybeRegisterWrapper(
    fnName: string,
    params: string[],
    bodyNode: any
  ) {
    if (!fnName || !Array.isArray(params) || !bodyNode) return;
    let innerCall: any = null;
    (walk as any).simple(
      bodyNode,
      {
        CallExpression(node: any) {
          if (innerCall) return;
          if (!isRegisterTypeCallee(node.callee)) return;
          innerCall = node;
        },
      },
      (walk as any).base
    );
    if (!innerCall) return;
    const [typeArg, optionsArg] = innerCall.arguments || [];
    // Require typeArg to be identifier referencing a param (for safe inlining).
    if (!typeArg || typeArg.type !== "Identifier") return;
    if (!params.includes(typeArg.name)) return;
    if (!optionsArg || optionsArg.type !== "ObjectExpression") return;
    wrappers.set(fnName, { params, typeArg, optionsArg });
  }

  (walk as any).simple(ast, {
    FunctionDeclaration(node: any) {
      const name = node.id?.name;
      const params = (node.params || [])
        .map((p: any) => (p && p.type === "Identifier" ? p.name : null))
        .filter(Boolean);
      maybeRegisterWrapper(name, params, node.body);
    },
    VariableDeclarator(node: any) {
      const name = node.id?.type === "Identifier" ? node.id.name : null;
      const init = node.init;
      if (!name || !init) return;
      if (
        init.type !== "FunctionExpression" &&
        init.type !== "ArrowFunctionExpression"
      )
        return;
      const params = (init.params || [])
        .map((p: any) => (p && p.type === "Identifier" ? p.name : null))
        .filter(Boolean);
      // For arrow functions with expression body we skip; wrapper needs a body block.
      if (init.body?.type !== "BlockStatement") return;
      maybeRegisterWrapper(name, params, init.body);
    },
  });

  // Direct calls + wrapper calls.
  (walk as any).simple(ast, {
    CallExpression(node: any) {
      // Direct RED.nodes.registerType("type", {...})
      if (isRegisterTypeCallee(node.callee)) {
        const [typeArg, optionsArg] = node.arguments || [];
        const type = extractStringLiteral(typeArg);
        if (!type) return;
        const optionsSource = optionsArg
          ? jsSource.slice(optionsArg.start, optionsArg.end)
          : "";
        const options = optionsArg ? evalAst(optionsArg, {}, jsSource) : null;
        found.push({ type, options, optionsSource });
        return;
      }

      // Wrapper call like reg("tl-keypoint-drop", "Drop", "#fff", "icon.svg")
      if (
        node.callee?.type === "Identifier" &&
        wrappers.has(node.callee.name)
      ) {
        const w = wrappers.get(node.callee.name)!;
        const args = node.arguments || [];

        // Map wrapper params -> argument evaluated literals (best-effort).
        const env: Record<string, unknown> = {};
        for (let i = 0; i < w.params.length; i++) {
          const p = w.params[i];
          const a = args[i];
          env[p] = a ? evalAst(a, {}, jsSource) : null;
        }

        // type is whatever value the wrapper passes via its type param.
        const typeValue = env[w.typeArg.name];
        if (typeof typeValue !== "string" || !typeValue) return;

        const optionsSource = jsSource.slice(
          w.optionsArg.start,
          w.optionsArg.end
        );
        const options = evalAst(w.optionsArg, env, jsSource);
        found.push({ type: typeValue, options, optionsSource });
      }
    },
  });

  return { found, warnings: [] as string[] };
}

export function parseNodesHtml(htmlString: string, { verbose = false } = {}) {
  const html = String(htmlString || "");
  const nodePattern =
    /<!-- --- \[red-module:([^\]]+)\] --- -->([\s\S]*?)(?=<!-- --- \[red-module:|$)/g;

  const nodesByType: Record<string, any> = {};
  const warnings: string[] = [];

  for (;;) {
    const match = nodePattern.exec(html);
    if (match === null) break;
    const moduleName = match[1];
    const moduleHtml = match[2] || "";
    const { module, modulePackage, moduleSet } = splitModuleName(moduleName);

    const { js, helpByType, templateByType } =
      extractScriptsAndDocs(moduleHtml);

    // Attach help/templates first (creates node entries even if JS parsing fails).
    for (const [type, helpHtml] of helpByType.entries()) {
      nodesByType[type] = nodesByType[type] || { type };
      Object.assign(nodesByType[type], {
        module,
        modulePackage,
        moduleSet,
        help: {
          html: helpHtml,
          text: htmlToText(helpHtml),
        },
      });
    }
    for (const [type, templateHtml] of templateByType.entries()) {
      nodesByType[type] = nodesByType[type] || { type };
      Object.assign(nodesByType[type], {
        module,
        modulePackage,
        moduleSet,
        template: {
          html: templateHtml,
          text: htmlToText(templateHtml),
        },
        templateFields: extractTemplateFields(templateHtml),
      });
    }

    // Parse JS blocks for registerType calls.
    for (const jsSource of js) {
      const { found, warnings: jsWarnings } =
        parseEditorJsForRegisterTypes(jsSource);
      for (const w of jsWarnings) warnings.push(`${module}:${w}`);

      for (const entry of found) {
        const type = entry.type;
        nodesByType[type] = nodesByType[type] || { type };
        const prev = nodesByType[type];
        const opts =
          entry.options && typeof entry.options === "object"
            ? entry.options
            : {};

        // Merge: prefer explicit values from options, but keep existing help/template.
        nodesByType[type] = {
          ...prev,
          type,
          module,
          modulePackage,
          moduleSet,
          // common fields
          category: opts.category ?? prev.category ?? null,
          paletteLabel: opts.paletteLabel ?? prev.paletteLabel ?? null,
          color: opts.color ?? prev.color ?? null,
          icon: opts.icon ?? prev.icon ?? null,
          align: opts.align ?? prev.align ?? null,
          inputs: opts.inputs ?? prev.inputs ?? null,
          outputs: opts.outputs ?? prev.outputs ?? null,
          outputLabels: opts.outputLabels ?? prev.outputLabels ?? null,
          defaults: opts.defaults ?? prev.defaults ?? null,
          options: opts,
          optionsSource: entry.optionsSource || prev.optionsSource || "",
        };
      }
    }
  }

  if (verbose) {
    // Useful to know when parsing did nothing
    if (Object.keys(nodesByType).length === 0) warnings.push("no_nodes_parsed");
  }

  const nodes = Object.values(nodesByType).sort((a: any, b: any) =>
    String(a.type).localeCompare(String(b.type))
  );

  return { nodesByType, nodes, warnings };
}
