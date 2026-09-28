/**
 * Map wiring: which side of each card an edge leaves and enters, where on that
 * side, and the orthogonal path between them. Mirrors the terminal's port rules
 * (`autoPorts`, `routeEdge` in ui.ts) at pixel scale.
 */
import type { Edge } from "../src/model.ts";
import type { Box } from "./doc.ts";

type Side = "north" | "east" | "south" | "west";
export interface Point {
	x: number;
	y: number;
}

const OPPOSITE: Record<Side, Side> = { east: "west", west: "east", north: "south", south: "north" };
const STUB = 18;
const STEP: Record<Side, [number, number]> = { east: [STUB, 0], west: [-STUB, 0], south: [0, STUB], north: [0, -STUB] };

function facingSides(from: Box, to: Box): [Side, Side] {
	const dx = to.x + to.w / 2 - (from.x + from.w / 2);
	const dy = to.y + to.h / 2 - (from.y + from.h / 2);
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["east", "west"] : ["west", "east"];
	return dy >= 0 ? ["south", "north"] : ["north", "south"];
}

function edgeSides(edge: Edge, from: Box, to: Box): [Side, Side] {
	const out = edge.fromPort !== "auto" ? edge.fromPort : null;
	const into = edge.toPort !== "auto" ? edge.toPort : null;
	if (out && into) return [out, into];
	if (out) return [out, OPPOSITE[out]];
	if (into) return [OPPOSITE[into], into];
	return facingSides(from, to);
}

function sidePoint(box: Box, side: Side, slot: number, count: number): Point {
	const t = (slot + 1) / (count + 1);
	const x0 = box.x + 12;
	const x1 = box.x + box.w - 12;
	const y0 = box.y + 12;
	const y1 = box.y + box.h - 12;
	if (side === "east") return { x: box.x + box.w, y: y0 + (y1 - y0) * t };
	if (side === "west") return { x: box.x, y: y0 + (y1 - y0) * t };
	if (side === "south") return { x: x0 + (x1 - x0) * t, y: box.y + box.h };
	return { x: x0 + (x1 - x0) * t, y: box.y };
}

function edgePoints(from: Box, to: Box, out: Side, into: Side, outSlot: number, outCount: number, inSlot: number, inCount: number): Point[] {
	const start = sidePoint(from, out, outSlot, outCount);
	const end = sidePoint(to, into, inSlot, inCount);
	const leave = { x: start.x + STEP[out][0], y: start.y + STEP[out][1] };
	const arrive = { x: end.x + STEP[into][0], y: end.y + STEP[into][1] };
	const elbow = out === "east" || out === "west" ? { x: arrive.x, y: leave.y } : { x: leave.x, y: arrive.y };
	const points = [start, leave];
	if (elbow.x !== leave.x || elbow.y !== leave.y) points.push(elbow);
	const last = points.at(-1)!;
	if (arrive.x !== last.x || arrive.y !== last.y) points.push(arrive);
	points.push(end);
	return points;
}

/** Where a label sits: the middle of the last segment long enough to carry it. */
function labelPoint(points: Point[]): Point {
	for (let index = points.length - 1; index >= 1; index -= 1) {
		const a = points[index - 1]!;
		const b = points[index]!;
		if (Math.hypot(b.x - a.x, b.y - a.y) >= 48) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 8 };
	}
	const a = points.at(-2)!;
	const b = points.at(-1)!;
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 8 };
}

export interface RoutedEdge {
	edge: Edge;
	d: string;
	label: Point;
}

/** Every edge whose ends are on screen, with edges sharing a side spread along it. */
export function routeEdges(edges: readonly Edge[], boxes: ReadonlyMap<string, Box>): RoutedEdge[] {
	const routed = edges.flatMap(edge => {
		const from = boxes.get(edge.from);
		const to = boxes.get(edge.to);
		if (!from || !to) return [];
		const [out, into] = edgeSides(edge, from, to);
		return [{ edge, from, to, out, into }];
	});
	const slots = new Map<string, string[]>();
	for (const route of routed) {
		for (const key of [`${route.edge.from}:${route.out}`, `${route.edge.to}:${route.into}`]) {
			const list = slots.get(key);
			if (list) list.push(route.edge.id);
			else slots.set(key, [route.edge.id]);
		}
	}
	return routed.map(({ edge, from, to, out, into }) => {
		const outSlots = slots.get(`${edge.from}:${out}`)!;
		const inSlots = slots.get(`${edge.to}:${into}`)!;
		const points = edgePoints(from, to, out, into, outSlots.indexOf(edge.id), outSlots.length, inSlots.indexOf(edge.id), inSlots.length);
		return { edge, d: points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" "), label: labelPoint(points) };
	});
}

/** The wire being pulled from a card's out port to the pointer. */
export function pullPath(start: Point, end: Point): string {
	const bend = Math.max(40, Math.abs(end.x - start.x) / 2);
	return `M${start.x},${start.y} C${start.x + bend},${start.y} ${end.x - bend},${end.y} ${end.x},${end.y}`;
}
