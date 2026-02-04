export type NodeRedConnectionConfig = {
  nodeRedUrl: string;
  nodeRedToken?: string;
  apiPrefix?: string;
};

function joinUrl(base: string, path: string) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  if (!p) return b;
  if (p.startsWith("/")) return `${b}${p}`;
  return `${b}/${p}`;
}

/**
 * Call the Node-RED Admin API using Worker-safe `fetch`.
 */
export async function callNodeRed(
  method: string,
  path: string,
  data: unknown,
  config: NodeRedConnectionConfig
) {
  const apiPath = config.apiPrefix ? `${config.apiPrefix}${path}` : path;
  const url = joinUrl(config.nodeRedUrl, apiPath);

  const headers = new Headers();
  if (config.nodeRedToken)
    headers.set("Authorization", `Bearer ${config.nodeRedToken}`);
  if (data != null && ["post", "put", "patch"].includes(method.toLowerCase())) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers,
    body: data != null ? JSON.stringify(data) : undefined,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Node-RED API error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`
    );
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  return await res.text();
}

/**
 * Format output of Node-RED flows.
 */
export function formatFlowsOutput(flows: any[]) {
  const result = {
    tabs: flows.filter((n) => n.type === "tab"),
    nodes: flows.filter((n) => n.type !== "tab" && n.type !== "subflow"),
    subflows: flows.filter((n) => n.type === "subflow"),
  };

  const stats: any = {
    tabCount: result.tabs.length,
    nodeCount: result.nodes.length,
    subflowCount: result.subflows.length,
    nodeTypes: {},
  };

  for (const node of result.nodes) {
    if (!stats.nodeTypes[node.type]) stats.nodeTypes[node.type] = 0;
    stats.nodeTypes[node.type]++;
  }

  return {
    summary: `Node-RED project: ${stats.tabCount} tabs, ${stats.nodeCount} nodes, ${stats.subflowCount} subflows`,
    statistics: stats,
    data: result,
  };
}
