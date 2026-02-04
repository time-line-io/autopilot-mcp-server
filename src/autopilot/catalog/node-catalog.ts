import { callNodeRed } from "../utils.js";
import { parseNodesHtml } from "./parse-nodes-html.js";

function truthy(v: unknown) {
	return /^(1|true|yes|on)$/i.test(String(v || ""));
}

function parseCsv(s: unknown) {
	return String(s || "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
}

function now() {
	return Date.now();
}

function defaultCustomModules() {
	return ["@time-line-autopilot/node-red-nodes", "node-red-dashboard-2-time-line-autopilot"];
}

export class NodeCatalog {
	private _config: any;
	private _ttlMs: number;
	private _customModules: Set<string>;
	private _verbose: boolean;
	private _cache: any;

	constructor(config: any) {
		this._config = config || {};

		// Workers: env vars can be present at runtime; keep reading from globalThis.process if it exists.
		const env = (globalThis as any)?.process?.env ?? {};
		const ttlEnv = env.NODE_MCP_CATALOG_TTL_MS;
		const ttlMs = ttlEnv ? Number.parseInt(ttlEnv, 10) : 60_000;
		this._ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 60_000;

		const allowEnv = env.TIME_LINE_CUSTOM_NODE_MODULES;
		this._customModules = new Set(
			(allowEnv ? parseCsv(allowEnv) : defaultCustomModules()).map(String),
		);

		this._verbose = !!this._config.verbose || truthy(env.NODE_MCP_VERBOSE_CATALOG);

		this._cache = {
			ts: 0,
			nodesByType: Object.create(null),
			nodes: [],
			warnings: [],
			nodeRedUrl: null,
		};
	}

	private _isExpired() {
		if (this._ttlMs === 0) return true;
		return now() - this._cache.ts > this._ttlMs;
	}

	private _markCustom(node: any) {
		const pkg = node?.modulePackage ? String(node.modulePackage) : "";
		const module = node?.module ? String(node.module) : "";
		const isCustom =
			(pkg && this._customModules.has(pkg)) ||
			(module && Array.from(this._customModules).some((m) => module.startsWith(m)));
		return { ...node, isCustom: !!isCustom };
	}

	async refresh() {
		const html = await callNodeRed("get", "/nodes", null, this._config);
		// Node-RED returns HTML; callNodeRed returns response body as-is.
		const parsed = parseNodesHtml(String(html), { verbose: this._verbose });
		const nodes = parsed.nodes.map((n: any) => this._markCustom(n));
		const nodesByType: Record<string, any> = Object.create(null);
		for (const n of nodes) nodesByType[n.type] = n;

		this._cache = {
			ts: now(),
			nodesByType,
			nodes,
			warnings: parsed.warnings || [],
			nodeRedUrl: this._config.nodeRedUrl || null,
		};
		return this._cache;
	}

	async getCatalog({ force = false }: { force?: boolean } = {}) {
		if (force || this._isExpired() || !this._cache.nodes.length) {
			await this.refresh();
		}
		return this._cache;
	}

	async list({ customOnly = false }: { customOnly?: boolean } = {}) {
		const c = await this.getCatalog();
		const nodes = customOnly ? c.nodes.filter((n: any) => n.isCustom) : c.nodes;
		return nodes.map((n: any) => ({
			type: n.type,
			category: n.category ?? null,
			paletteLabel: n.paletteLabel ?? null,
			module: n.module ?? null,
			modulePackage: n.modulePackage ?? null,
			moduleSet: n.moduleSet ?? null,
			isCustom: !!n.isCustom,
			inputs: n.inputs ?? null,
			outputs: n.outputs ?? null,
		}));
	}

	async getNode(type: string) {
		const c = await this.getCatalog();
		return c.nodesByType[String(type || "")] || null;
	}

	async search({
		query,
		customOnly = false,
		module,
		category,
		limit = 25,
	}: {
		query: string;
		customOnly?: boolean;
		module?: string;
		category?: string;
		limit?: number;
	}): Promise<any[]> {
		const q = String(query || "")
			.trim()
			.toLowerCase();
		const lim = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 25;
		if (!q) return [];

		const c = await this.getCatalog();
		const nodes = customOnly ? c.nodes.filter((n: any) => n.isCustom) : c.nodes.slice();

		const moduleFilter = module ? String(module).toLowerCase() : null;
		const categoryFilter = category ? String(category).toLowerCase() : null;

		function nodeHaystack(n: any) {
			const parts = [
				n.type,
				n.category,
				n.paletteLabel,
				n.module,
				n.modulePackage,
				n.moduleSet,
				n.help?.text,
			];
			try {
				if (n.defaults && typeof n.defaults === "object") {
					parts.push(Object.keys(n.defaults).join(" "));
				}
			} catch {
				// ignore
			}
			return String(parts.filter(Boolean).join("\n")).toLowerCase();
		}

		const matches: Array<{ node: any; score: number }> = [];
		for (const n of nodes) {
			if (moduleFilter) {
				const m = String(n.module || "").toLowerCase();
				if (!m.includes(moduleFilter)) continue;
			}
			if (categoryFilter) {
				const cat = String(n.category || "").toLowerCase();
				if (!cat.includes(categoryFilter)) continue;
			}
			const hay = nodeHaystack(n);
			const idx = hay.indexOf(q);
			if (idx === -1) continue;
			// crude scoring: earlier match + shorter hay
			const score = idx + Math.min(hay.length, 10_000) / 10_000;
			matches.push({ node: n, score });
		}

		matches.sort((a, b) => a.score - b.score);
		return matches.slice(0, lim).map((m) => ({
			type: m.node.type,
			category: m.node.category ?? null,
			paletteLabel: m.node.paletteLabel ?? null,
			module: m.node.module ?? null,
			modulePackage: m.node.modulePackage ?? null,
			isCustom: !!m.node.isCustom,
			snippet:
				(m.node.help?.text || "").slice(0, 400) ||
				(m.node.template?.text || "").slice(0, 400) ||
				"",
		}));
	}
}

export function createNodeCatalog(config: any) {
	return new NodeCatalog(config);
}
