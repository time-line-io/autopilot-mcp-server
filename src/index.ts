import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import app from "./app";
import { registerAutopilotTools } from "./autopilot/registerAutopilotTools";

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Time-Line Autopilot MCP",
		version: "1.3.4",
	});

	async init() {
		// `agents/mcp` attaches Worker bindings on `this.env` at runtime.
		// We keep this loose-typed to avoid coupling to generated Wrangler types.
		registerAutopilotTools(this.server, (this as unknown as { env?: unknown }).env as any);
	}
}

// Export the OAuth handler as the default
export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: MyMCP.serve("/mcp"),
	// @ts-expect-error
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});
