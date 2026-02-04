/**
 * MCP tools for turning intent -> Node-RED flow guidance.
 *
 * Keep this conservative: suggest wiring + message mappings, without auto-deploy.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AutopilotMcpConfig } from "../registerAutopilotTools.js";

function parseHost(intent: string) {
	const s = String(intent || "");
	const ipMatch = s.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
	if (ipMatch) return ipMatch[1];
	const localhost = s.match(/\blocalhost\b/i);
	if (localhost) return "127.0.0.1";
	return null;
}

function parsePort(intent: string) {
	const s = String(intent || "");
	const m1 = s.match(/\bport\s+(\d{2,5})\b/i);
	if (m1) return Number.parseInt(m1[1], 10);
	const m2 = s.match(/:(\d{2,5})\b/);
	if (m2) return Number.parseInt(m2[1], 10);
	return null;
}

function parseOscAddress(intent: string) {
	const s = String(intent || "");
	const m = s.match(/(\/[A-Za-z0-9_/\-.:]+)\b/);
	if (m) return m[1];
	// Default addresses based on common phrases.
	if (/\bgroup\b/i.test(s) && /\bprogress\b/i.test(s)) return "/group/progress";
	if (/\bkeypoint\b/i.test(s) && /\bprogress\b/i.test(s)) return "/keypoint/progress";
	if (/\bbpm\b/i.test(s)) return "/bpm";
	if (/\bbeat\b/i.test(s)) return "/beat";
	return "/tl";
}

function wantsMidi(intent: string) {
	return /\bmidi\b/i.test(String(intent || ""));
}

function wantsGroupProgress(intent: string) {
	const s = String(intent || "");
	return /\bgroup\b/i.test(s) && /\bprogress\b/i.test(s);
}

function wantsKeypointProgress(intent: string) {
	const s = String(intent || "");
	return /\bkeypoint\b/i.test(s) && /\bprogress\b/i.test(s);
}

function wantsBpm(intent: string) {
	return /\bbpm\b/i.test(String(intent || ""));
}

function wantsBeat(intent: string) {
	return /\bbeat\b/i.test(String(intent || ""));
}

function wantsSongDetailsWidget(intent: string) {
	const s = String(intent || "").toLowerCase();
	return s.includes("song details") || s.includes("now playing") || s.includes("playhead");
}

function wantsKeypointDetailsWidget(intent: string) {
	const s = String(intent || "").toLowerCase();
	return s.includes("keypoint details") || s.includes("current keypoint widget");
}

function wantsUpcomingKeypointsWidget(intent: string) {
	const s = String(intent || "").toLowerCase();
	return s.includes("upcoming keypoints") || s.includes("next keypoints widget");
}

function wantsEnter(intent: string) {
	const s = String(intent || "").toLowerCase();
	return (
		s.includes("enter") ||
		s.includes("on start") ||
		s.includes("when it starts") ||
		s.includes("when it begins")
	);
}

function wantsExit(intent: string) {
	const s = String(intent || "").toLowerCase();
	return (
		s.includes("exit") ||
		s.includes("leave") ||
		s.includes("on end") ||
		s.includes("when it ends")
	);
}

function wantsContinuous(intent: string) {
	const s = String(intent || "").toLowerCase();
	return (
		s.includes("while") ||
		s.includes("continuous") ||
		s.includes("stream") ||
		s.includes("progress") ||
		s.includes("every") ||
		s.includes("animate")
	);
}

function wantsThrottle(intent: string) {
	const s = String(intent || "").toLowerCase();
	return (
		s.includes("debounce") ||
		s.includes("throttle") ||
		s.includes("quantize") ||
		s.includes("grid") ||
		s.includes("tick")
	);
}

function parseDivision(intent: string) {
	// Accept 1, 1/2, 1/4, 1/8
	const s = String(intent || "");
	const m = s.match(/\b(1\/8|1\/4|1\/2|1)\b/);
	return m ? m[1] : null;
}

function parseKeypointId(intent: string) {
	// Order matters: prefer longer/multiword matches first.
	const s = String(intent || "").toLowerCase();
	const rules = [
		{ re: /\brhythmic\s+build\b/, id: "rhythmic-build" },
		{ re: /\bdrive\s+break\b/, id: "drive-break" },
		{ re: /\bpre[\s-]?drop\b/, id: "pre-drop" },
		{ re: /\bfake\s+drop\b/, id: "fake-drop" },
		{ re: /\bdrop\s+break\b/, id: "drop-break" },
		{ re: /\bbreak\s*down\b/, id: "breakdown" },
		{ re: /\bcurrent\s+keypoint\b/, id: "current" },
		{ re: /\bnext\s+keypoint\b/, id: "next" },
		{ re: /\bcurrent\s+(track|song)\b/, id: "current-track" },
		{ re: /\bdrive\b/, id: "drive" },
		{ re: /\bbuild\b/, id: "build" },
		{ re: /\bdrop\b/, id: "drop" },
		{ re: /\bsolo\b/, id: "solo" },
		{ re: /\boutro\b/, id: "outro" },
		{ re: /\bunknown\b/, id: "unknown" },
	];
	for (const r of rules) {
		if (r.re.test(s)) return r.id;
	}
	return null;
}

function keypointIdToNodeType(id: string | null) {
	if (!id) return null;
	if (id === "current") return "tl-keypoint-current";
	if (id === "next") return "tl-keypoint-next";
	if (id === "current-track") return "tl-current-track";
	return `tl-keypoint-${id}`;
}

function pickValueMapping(intent: string, triggerType: string) {
	// Returns {label, payloadExpr, topic}
	const address = parseOscAddress(intent);
	if (wantsGroupProgress(intent)) {
		return {
			label: "group progress (0..1)",
			payloadExpr: "msg.payload.currentKeypointGroupProgress",
			topic: address,
			vizType: "progress",
		};
	}
	if (wantsKeypointProgress(intent)) {
		return {
			label: "keypoint progress (0..1)",
			payloadExpr: "msg.payload.currentKeypointProgress",
			topic: address,
			vizType: "progress",
		};
	}
	if (wantsBpm(intent)) {
		// tl-beat outputs bpm at msg.payload.bpm; current-track also contains bpm.
		const expr = triggerType === "tl-beat" ? "msg.payload.bpm" : "msg.payload.bpm";
		return { label: "BPM", payloadExpr: expr, topic: address, vizType: "text" };
	}
	if (wantsBeat(intent)) {
		return {
			label: "beat (beatInMeasure)",
			payloadExpr: "msg.payload.beatInMeasure",
			topic: address,
			vizType: "text",
		};
	}
	// Default: pass through original payload, set topic.
	return {
		label: "pass-through payload",
		payloadExpr: "msg.payload",
		topic: address,
		vizType: "led",
	};
}

export default function registerRecipeTools(server: McpServer, config: AutopilotMcpConfig) {
	server.tool(
		"suggest-flow",
		"Suggests a Node-RED wiring plan (nodes + message mappings) for a natural-language automation intent. Uses the running Node-RED instance’s installed nodes, with special support for Time-Line custom nodes.",
		{
			intent: z
				.string()
				.describe(
					"Natural language intent, e.g. 'on a drop send osc to 127.0.0.1 with the group progress'",
				),
			customOnly: z
				.boolean()
				.optional()
				.describe(
					"If true, restrict node suggestions to custom Time-Line nodes when possible.",
				),
		},
		async ({ intent, customOnly }) => {
			const cat = config.nodeCatalog;
			// Ensure catalog is warm (but don’t force refresh unless needed).
			await cat.getCatalog();

			const host = parseHost(intent) || "127.0.0.1";
			const port = parsePort(intent) || 8000;
			const oscAddress = parseOscAddress(intent);
			const protocol = wantsMidi(intent) ? "midi" : "osc";

			const keypointId = parseKeypointId(intent);
			const triggerType =
				(wantsBeat(intent) && "tl-beat") ||
				keypointIdToNodeType(keypointId) ||
				"tl-keypoint-current";

			const timing = (() => {
				if (triggerType === "tl-beat") return { mode: "stream", output: "output" };
				if (triggerType === "tl-current-track") return { mode: "stream", output: "stream" };
				// Keypoint nodes: prefer stream for progress/continuous; else event.
				const continuous = wantsContinuous(intent);
				const enter = wantsEnter(intent);
				const exit = wantsExit(intent);
				if (continuous || wantsGroupProgress(intent) || wantsKeypointProgress(intent)) {
					return { mode: "stream", output: "stream" };
				}
				if (enter || exit)
					return {
						mode: "event",
						output: "event",
						event: exit ? "exit" : "enter",
					};
				// Default: event enter (common “on drop …”)
				return { mode: "event", output: "event", event: "enter" };
			})();

			const valueMapping = pickValueMapping(intent, triggerType);

			const outputType = "tl-output";
			const outputServerType = "tl-output-server";
			const debounceType = "tl-bpm-debounce";

			const trigger = await cat.getNode(triggerType);
			const output = await cat.getNode(outputType);
			const outputServer = await cat.getNode(outputServerType);
			const debounce = await cat.getNode(debounceType);

			const missing: string[] = [];
			if (!trigger) missing.push(triggerType);
			if (!output) missing.push(outputType);
			if (!outputServer) missing.push(outputServerType);

			const steps: any[] = [];

			// Dashboard widget intents (display-only) are also supported.
			if (wantsSongDetailsWidget(intent)) {
				steps.push({
					step: "1",
					node: "ui-tl-song-details",
					role: "dashboard",
					notes: "Wire a TL keypoint node’s *stream* output (or any msg.payload currentTrack snapshot) into this widget.",
				});
			}
			if (wantsKeypointDetailsWidget(intent)) {
				steps.push({
					step: "1",
					node: "ui-tl-keypoint-details",
					role: "dashboard",
					notes: "Wire any tl-keypoint-* node’s *event* output into this widget (it listens to enter/exit edges).",
				});
			}
			if (wantsUpcomingKeypointsWidget(intent)) {
				steps.push({
					step: "1",
					node: "ui-tl-upcoming-keypoints",
					role: "dashboard",
					notes: "Wire tl-current-track output (or any msg.payload currentTrack snapshot) into this widget. It uses payload.keypoints and payload.currentPositionMs.",
				});
			}

			steps.push({
				step: String(steps.length + 1),
				node: triggerType,
				role: "trigger",
				notes:
					triggerType === "tl-beat"
						? "Emits on beat changes (topic tl/beat)."
						: triggerType === "tl-current-track"
							? "Use output 2 (*stream*) for ~30fps snapshots; output 1 (*change*) only when metadata changes."
							: timing.mode === "stream"
								? "Use the *stream* output for continuous snapshots while active."
								: `Use the *event* output and filter for msg.payload.event === "${(timing as any).event}".`,
				output: (timing as any).output,
			});

			if ((timing as any).mode === "event" && triggerType.startsWith("tl-keypoint")) {
				steps.push({
					step: String(steps.length + 1),
					node: "switch",
					role: "filter",
					notes: `Only pass through ${(timing as any).event} edges.`,
					filter: {
						property: "payload.event",
						equals: (timing as any).event,
					},
				});
			}

			steps.push({
				step: String(steps.length + 1),
				node: "change",
				role: "mapping",
				notes: `Set msg.payload to ${valueMapping.label}. Set msg.topic to OSC address.`,
				mapping: {
					set: [
						{ target: "msg.payload", value: valueMapping.payloadExpr },
						{ target: "msg.topic", value: oscAddress },
					],
				},
			});

			// Optional BPM-quantized throttle for high-frequency streams.
			const shouldThrottle =
				(timing as any).mode === "stream" &&
				(wantsThrottle(intent) ||
					wantsGroupProgress(intent) ||
					wantsKeypointProgress(intent));
			if (shouldThrottle && debounce) {
				const division = parseDivision(intent) || "1/4";
				steps.push({
					step: String(steps.length + 1),
					node: debounceType,
					role: "throttle",
					notes:
						`Optional: quantize to BPM grid (${division}). ` +
						"This buffers the latest message and emits only on tick; a null/undefined payload clears pending values.",
					config: { division },
				});
			}

			if (protocol === "osc") {
				steps.push({
					step: String(steps.length + 1),
					node: outputServerType,
					role: "config",
					notes: `Create/reuse an OSC server config: host=${host}, port=${port}, udpFamily=udp4.`,
					config: { protocol: "osc", host, port, udpFamily: "udp4" },
				});
				steps.push({
					step: String(steps.length + 1),
					node: outputType,
					role: "sink",
					notes: "Wire into tl-output. Leave Address blank to use msg.topic as OSC address, or set Address to a fixed address.",
					config: {
						server: "(select your tl-output-server)",
						address: "(blank to use msg.topic)",
						vizType: valueMapping.vizType || "led",
					},
				});
			} else {
				steps.push({
					step: String(steps.length + 1),
					node: outputServerType,
					role: "config",
					notes: "Create/reuse a MIDI server config: set protocol=midi and pick midiPort. Then send msg.payload as raw bytes (e.g. [144,60,127]) or msg.midi (type/channel/data).",
					config: { protocol: "midi", midiPort: 0 },
				});
				steps.push({
					step: String(steps.length + 1),
					node: outputType,
					role: "sink",
					notes: "Wire into tl-output. For MIDI, msg.topic is ignored; msg.payload must be bytes/Buffer or msg.midi object.",
					config: {
						server: "(select your tl-output-server)",
						vizType: valueMapping.vizType || "led",
					},
				});
			}

			const wiring: any[] = [];
			const triggerOut =
				triggerType === "tl-current-track"
					? "output(stream)"
					: triggerType === "tl-beat"
						? "output"
						: (timing as any).mode === "stream"
							? "output(stream)"
							: "output(event)";

			let current = `${triggerType}:${triggerOut}`;
			if ((timing as any).mode === "event" && triggerType.startsWith("tl-keypoint")) {
				wiring.push({ from: current, to: "switch" });
				current = "switch";
			}
			wiring.push({ from: current, to: "change" });
			current = "change";
			if (shouldThrottle && debounce) {
				wiring.push({ from: current, to: debounceType });
				current = debounceType;
			}
			wiring.push({ from: current, to: outputType });

			const response: any = {
				intent,
				trigger: { type: triggerType, timing },
				action:
					protocol === "osc"
						? { type: "osc", host, port, address: oscAddress }
						: { type: "midi" },
				missingNodes: missing,
				steps,
				wiring,
				dataNotes: triggerType.startsWith("tl-keypoint")
					? {
							keypointStreamHas: [
								"currentKeypointProgress",
								"currentKeypointGroupProgress",
								"currentKeypointGroupStep",
								"currentKeypointGroupTotalSteps",
								"currentPositionMs",
								"durationMs",
								"bpm",
							],
							keypointEventHas: [
								"event (enter/exit)",
								"reason (optional)",
								"currentKeypointProgress",
								"currentKeypointGroupProgress",
							],
						}
					: triggerType === "tl-beat"
						? {
								beatPayloadHas: [
									"deckId",
									"beatInMeasure",
									"beat",
									"bpm",
									"pitch",
									"currentPositionMs",
									"ts",
								],
							}
						: triggerType === "tl-current-track"
							? {
									currentTrackChangePayload: [
										"deckId",
										"trackId",
										"title",
										"artist",
										"isPlaying",
										"isOnAir",
										"bpm",
										"durationMs",
									],
								}
							: null,
			};

			if (customOnly) {
				try {
					response.customNodes = await cat.list({ customOnly: true });
				} catch {
					// ignore
				}
			}

			return {
				content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
			};
		},
	);
}
