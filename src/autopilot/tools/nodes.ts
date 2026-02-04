/**
 * MCP tools for working with Node-RED nodes
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AutopilotMcpConfig } from "../registerAutopilotTools.js";
import { callNodeRed } from "../utils.js";

export default function registerNodeTools(
  server: McpServer,
  config: AutopilotMcpConfig
) {
  const catalog = config.nodeCatalog;

  server.tool(
    "connection-info",
    "Returns the configured Node-RED connection info and a quick connectivity check against the Admin API.",
    {},
    async () => {
      const info = {
        nodeRedUrl: config.nodeRedUrl,
        apiPrefix: config.apiPrefix || "",
        hasToken: !!config.nodeRedToken,
      };
      try {
        // `/settings` is a lightweight Admin API endpoint and proves auth/prefix are correct.
        const settings = await callNodeRed("get", "/settings", null, config);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  info,
                  settingsSummary: {
                    httpAdminRoot: (settings as any)?.httpAdminRoot,
                    version: (settings as any)?.version,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, info, error: String(e?.message || e) },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "catalog-refresh",
    "Refreshes the cached node catalog by fetching and parsing the Node-RED `/nodes` HTML.",
    {},
    async () => {
      const c = await catalog.refresh();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                refreshedAt: c.ts,
                nodeCount: c.nodes.length,
                warningCount: (c.warnings || []).length,
                warnings: c.warnings || [],
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "catalog-list",
    "Lists installed nodes in a structured, LLM-friendly format. Supports filtering to only custom Time-Line nodes.",
    {
      customOnly: z
        .boolean()
        .optional()
        .describe("If true, only include custom Time-Line nodes"),
    },
    async ({ customOnly }) => {
      const nodes = await catalog.list({ customOnly: !!customOnly });
      return {
        content: [{ type: "text", text: JSON.stringify(nodes, null, 2) }],
      };
    }
  );

  server.tool(
    "catalog-get-node",
    "Returns the full structured schema for a single node type (including defaults, help, and editor template when available).",
    {
      type: z.string().describe('Node type, e.g. "tl-output"'),
      includeHtml: z
        .boolean()
        .optional()
        .describe("If true, include raw help/template HTML (can be large)"),
    },
    async ({ type, includeHtml }) => {
      const node = await catalog.getNode(type);
      if (!node) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: `Unknown node type: ${type}` },
                null,
                2
              ),
            },
          ],
        };
      }
      const out: any = { ...node };
      if (!includeHtml) {
        if (out.help) out.help = { ...out.help, html: undefined };
        if (out.template) out.template = { ...out.template, html: undefined };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, node: out }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "catalog-search",
    "Searches installed node documentation (help text, defaults, metadata). Best for queries like 'group progress', 'OSC', 'keypoint'.",
    {
      query: z.string().describe("Search query"),
      customOnly: z
        .boolean()
        .optional()
        .describe("If true, search only custom Time-Line nodes"),
      module: z
        .string()
        .optional()
        .describe("Optional module filter substring"),
      category: z
        .string()
        .optional()
        .describe("Optional category filter substring"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max results (default 25)"),
    },
    async ({ query, customOnly, module, category, limit }) => {
      const results = await catalog.search({
        query,
        customOnly: !!customOnly,
        module,
        category,
        limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // Trigger inject node
  server.tool(
    "inject",
    "Triggers an inject node in the Node-RED instance by its ID. This tool simulates an input event for the specified inject node.",
    { id: z.string().describe("Inject node ID") },
    async ({ id }) => {
      await callNodeRed("post", `/inject/${id}`, null, config);
      return {
        content: [{ type: "text", text: `Inject node ${id} triggered` }],
      };
    }
  );

  // Get list of installed nodes (structured from cached catalog)
  server.tool(
    "get-available-nodes",
    "Retrieves a structured list of installed nodes (type/category/module/helpText). This uses the cached catalog parsed from the Node-RED `/nodes` endpoint.",
    {
      customOnly: z
        .boolean()
        .optional()
        .describe("If true, only include custom Time-Line nodes"),
    },
    async ({ customOnly }) => {
      const nodes = await catalog.getCatalog();
      const list = (
        customOnly ? nodes.nodes.filter((n: any) => n.isCustom) : nodes.nodes
      ).map((n: any) => ({
        type: n.type,
        category: n.category ?? null,
        paletteLabel: n.paletteLabel ?? null,
        module: n.module ?? null,
        modulePackage: n.modulePackage ?? null,
        isCustom: !!n.isCustom,
        inputs: n.inputs ?? null,
        outputs: n.outputs ?? null,
        defaults: n.defaults ?? null,
        helpText: n.help?.text ? String(n.help.text).slice(0, 800) : "",
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    }
  );

  // Get information about a specific module
  server.tool(
    "get-node-detailed-info",
    "Retrieves source code about a specific node module by its name. Args: module (e.g.'node-red/inject')",
    { module: z.string().describe("Node module name") },
    async ({ module }) => {
      const info = await callNodeRed("get", `/nodes/${module}`, null, config);
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    }
  );

  // Get source code about a node module set
  server.tool(
    "get-node-set-detailed-info",
    "Retrieves source code about a specific node module by its name. Args: module (e.g.'@supcon-international/node-red-function-gpt-with-memory') set (e.g.'function-gpt')",
    {
      module: z.string().describe("Node module name"),
      set: z.string().describe("Node module set name"),
    },
    async ({ module, set }) => {
      const info = await callNodeRed(
        "get",
        `/nodes/${module}/${set}`,
        null,
        config
      );
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    }
  );

  // Install node module
  server.tool(
    "install-node-module",
    "Install a specific node module in the Node-RED instance. Args: module (e.g.'node-red-dashboard')",
    { module: z.string().describe("Node module name") },
    async ({ module }) => {
      const info = await callNodeRed("post", "/nodes", { module }, config);
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    }
  );

  // Enable/disable node module
  server.tool(
    "toggle-node-module",
    "Enables or disables a specific node module in the Node-RED instance. Args: module (e.g.'node-red/inject') enabled (e.g.'true')",
    {
      module: z.string().describe("Node module name"),
      enabled: z.boolean().describe("true to enable, false to disable"),
    },
    async ({ module, enabled }) => {
      try {
        await callNodeRed("put", `/nodes/${module}`, { enabled }, config);
        return {
          content: [
            {
              type: "text",
              text: `Module ${module} ${enabled ? "enabled" : "disabled"}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            { type: "text", text: `Error: ${error?.message ?? String(error)}` },
          ],
        };
      }
    }
  );

  // Enable/disable node module set
  server.tool(
    "toggle-node-module-set",
    "Enables or disables a specific node module set in the Node-RED instance. Args: module (e.g.'@supcon-international/node-red-function-gpt-with-memory') set (e.g.'function-gpt') enabled (e.g.'true')",
    {
      module: z.string().describe("Node module name"),
      set: z.string().describe("Node module set name"),
      enabled: z.boolean().describe("true to enable, false to disable"),
    },
    async ({ module, set, enabled }) => {
      try {
        await callNodeRed(
          "put",
          `/nodes/${module}/${set}`,
          { enabled },
          config
        );
        return {
          content: [
            {
              type: "text",
              text: `Module ${module} set ${set} ${enabled ? "enabled" : "disabled"}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            { type: "text", text: `Error: ${error?.message ?? String(error)}` },
          ],
        };
      }
    }
  );

  // Find nodes by type
  server.tool(
    "find-nodes-by-type",
    "Searches for nodes in the Node-RED instance by their type. Args: nodeType (e.g.'inject')",
    { nodeType: z.string().describe("Node type to search for") },
    async ({ nodeType }) => {
      const flows = (await callNodeRed("get", "/flows", null, config)) as any[];
      const nodes = flows.filter((node) => node.type === nodeType);
      return {
        content: [
          {
            type: "text",
            text:
              nodes.length > 0
                ? `Found ${nodes.length} nodes of type "${nodeType}":\n\n${JSON.stringify(nodes, null, 2)}`
                : `No nodes of type "${nodeType}" found`,
          },
        ],
      };
    }
  );

  // Search nodes by name/properties
  server.tool(
    "search-nodes",
    "Searches for nodes in the Node-RED instance by a query string, optionally filtering by a specific property. Args: query (e.g.'inject') property (e.g.'type') (optional)",
    {
      query: z.string().describe("String to search in node name or properties"),
      property: z
        .string()
        .optional()
        .describe("Specific property to search (optional)"),
    },
    async ({ query, property }) => {
      const flows = (await callNodeRed("get", "/flows", null, config)) as any[];
      const nodes = flows.filter((node) => {
        if (property) {
          return node[property] && String(node[property]).includes(query);
        }
        return JSON.stringify(node).includes(query);
      });

      return {
        content: [
          {
            type: "text",
            text:
              nodes.length > 0
                ? `Found ${nodes.length} nodes matching query "${query}":\n\n${JSON.stringify(nodes, null, 2)}`
                : `No nodes found matching query "${query}"`,
          },
        ],
      };
    }
  );
}
