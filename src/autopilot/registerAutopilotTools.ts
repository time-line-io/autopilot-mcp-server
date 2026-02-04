import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createNodeCatalog } from "./catalog/index.js";
import registerFlowTools from "./tools/flows.js";
import registerNodeTools from "./tools/nodes.js";
import registerRecipeTools from "./tools/recipes.js";
import registerSettingsTools from "./tools/settings.js";
import registerUtilityTools from "./tools/utility.js";

type MaybeEnv = Record<string, unknown> | undefined | null;

function getEnvString(env: MaybeEnv, key: string): string | undefined {
  const v = env?.[key];
  if (typeof v === "string") return v;
  return undefined;
}

function getEnvBool(env: MaybeEnv, key: string): boolean | undefined {
  const v = env?.[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
  }
  return undefined;
}

export type AutopilotMcpConfig = {
  // Connection
  nodeRedUrl: string;
  nodeRedToken?: string;
  apiPrefix?: string;
  nodeRedAPIVersion?: string;

  // Behavior
  verbose?: boolean;

  // Required by node tools + recipes
  nodeCatalog: ReturnType<typeof createNodeCatalog>;
};

/**
 * Registers the Time-Line Autopilot / Node-RED toolset onto an existing MCP server.
 *
 * Environment variables supported (prefer configuring as Worker vars):
 * - NODE_RED_URL
 * - NODE_RED_TOKEN
 * - NODE_MCP_PREFIX
 * - NODE_MCP_VERBOSE
 */
export function registerAutopilotTools(server: McpServer, env: MaybeEnv) {
  const nodeRedUrl =
    getEnvString(env, "NODE_RED_URL") ?? "http://localhost:1880";
  const nodeRedToken = getEnvString(env, "NODE_RED_TOKEN") ?? "";
  const apiPrefix = getEnvString(env, "NODE_MCP_PREFIX") ?? "";
  const verbose = getEnvBool(env, "NODE_MCP_VERBOSE") ?? false;

  const config: AutopilotMcpConfig = {
    nodeRedUrl,
    nodeRedToken,
    apiPrefix,
    nodeRedAPIVersion: "v1",
    verbose,
    // Parsed from Node-RED’s `/nodes` HTML (cached).
    nodeCatalog: createNodeCatalog({
      nodeRedUrl,
      nodeRedToken,
      apiPrefix,
      verbose,
    }),
  };

  registerFlowTools(server, config);
  registerNodeTools(server, config);
  registerSettingsTools(server, config);
  registerUtilityTools(server, config);
  registerRecipeTools(server, config);
}
