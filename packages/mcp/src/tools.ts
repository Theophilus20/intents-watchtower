import type { RouteVerdict, Status } from "@watchtower/core";
import { STATUS_RANK } from "@watchtower/core";
import { preflight, type Preflight, type RouteState } from "@watchtower/engine";
import { LANGS, extractFacts, templateBody, templateExplain, type Lang } from "@watchtower/explainer";
import type { SafetyCheck } from "@watchtower/sdk";
import { AssetError, assetCatalog, assetLabel, resolveAsset, routeLabel } from "./assets.ts";
import type { Source } from "./source.ts";

/**
 * The four tools an agent gets.
 *
 *   check_swap     "I want to move $X from A to B": go / reduce / reroute / wait, with reasons
 *   check_route    the raw safety answer for one route (what is_safe returns on-chain, plus why)
 *   list_routes    every route, worst first, with its safe size
 *   explain_route  one plain-language paragraph, in English, French or Spanish
 *
 * Every answer starts with the source line, so a replay is never mistaken for the live network.
 */

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  run(args: Record<string, unknown>, src: Source): Promise<ToolResult>;
}

const TOKEN_HELP = 'Token as symbol:chain ("usdt:bsc", "btc:bitcoin", "usdc:near") or plain words ("USDT on BSC").';
const pair = {
  from: { type: "string", description: `Token you send. ${TOKEN_HELP}` },
  to: { type: "string", description: `Token you receive. ${TOKEN_HELP}` },
};
const allowAmber = { type: "boolean", default: false, description: "Accept routes marked caution (amber). Default false: only healthy routes pass." };

export function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const STATUS_WORD: Record<Status, string> = { green: "healthy", amber: "caution", unknown: "unverified", red: "paused" };

function plainReasons(src: Source, route: string, status: Status, reasons: string[], lang: Lang = "en"): string {
  const v: Pick<RouteVerdict, "route" | "status" | "reasons" | "components"> = src.verdict(route) ?? { route, status, reasons, components: [] };
  return templateBody(extractFacts({ ...v, status, reasons: reasons.length ? reasons : v.reasons }), lang);
}

function routeOf(args: Record<string, unknown>, catalog: string[]): string {
  const from = resolveAsset(args.from, catalog);
  const to = resolveAsset(args.to, catalog);
  if (from === to) throw new AssetError("from and to are the same token.");
  return `${from}->${to}`;
}

/** What the contract said, reduced to what pre-flight needs. Unsafe-for-any-reason means no size. */
function stateOf(c: SafetyCheck, allow: boolean): RouteState {
  let status: Status = c.status ?? "unknown";
  if (!c.safe && (c.verdict === "stale" || c.verdict === "no_data" || c.verdict === "error" || c.verdict === "paused")) status = status === "red" ? "red" : "unknown";
  const usable = c.safe || (allow && status === "amber");
  return { route: c.route_id, status, score: c.score ?? 0, capacityUsd: usable ? c.capacity_usd ?? 0 : 0, reasons: c.reasons };
}

function fail(src: Source, message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `${src.label}\n\n${message}` }] };
}

function reply(src: Source, text: string, data: Record<string, unknown>): ToolResult {
  const structured = { source: { kind: src.kind, label: src.label }, ...data };
  return { content: [{ type: "text", text: `${src.label}\n\n${text}` }, { type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function ageText(c: SafetyCheck): string {
  if (c.age_sec === null) return "";
  return c.age_sec < 90 ? `${c.age_sec}s old` : `${Math.round(c.age_sec / 60)} min old`;
}

// ---------------------------------------------------------------------------------------------

const checkSwap: ToolDef = {
  name: "check_swap",
  title: "Check a swap before sending it",
  description:
    "Call this before any NEAR Intents swap, bridge or withdrawal. Answers go, reduce, reroute or wait for moving amount_usd from one token to another, using the verdict that independent watchers signed on-chain: whether the route is backed and healthy right now, and how much it can safely carry. Only proceed when decision is \"go\". On \"reroute\", use the suggested route; on \"reduce\", split into the suggested number of parts; on \"wait\", do not send.",
  inputSchema: {
    type: "object",
    properties: { ...pair, amount_usd: { type: "number", minimum: 0, description: "Size of the swap in US dollars." }, allow_amber: allowAmber },
    required: ["from", "to", "amount_usd"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run(args, src) {
    const known = await src.routes();
    const route = routeOf(args, assetCatalog(known));
    const amount = Number(typeof args.amount_usd === "string" ? args.amount_usd.replace(/[$,\s]/g, "") : args.amount_usd);
    if (!Number.isFinite(amount) || amount < 0) throw new AssetError("amount_usd must be a non-negative number of dollars.");
    const allow = args.allow_amber === true;

    const candidates = [...new Set([route, ...known])];
    const checks = await src.client.checkMany(candidates, { allowAmber: allow });
    const states = checks.map((c) => stateOf(c, allow));
    const mine = checks.find((c) => c.route_id === route)!;
    let p: Preflight = preflight(route, amount, states, { allowAmber: allow });
    // The contract has the last word: "go" must also pass check_intent.
    const onchain = await src.client.checkIntent(route, amount, { allowAmber: allow });
    if (p.decision === "go" && !onchain.allowed) p = { ...p, decision: "wait" };

    const label = routeLabel(route);
    const status = (mine.status ?? "unknown") as Status;
    let text: string;
    if (p.decision === "go") {
      text = `GO. ${usd(amount)} via ${label} is within the safe size of ${usd(mine.capacity_usd ?? 0)}. The route is ${STATUS_WORD[status]} (score ${mine.score}/100, verdict ${ageText(mine)}).`;
    } else if (p.decision === "reroute" && p.alternative) {
      const alt = p.alternative;
      const why = mine.verdict === "over_capacity" || (mine.safe && amount > (mine.capacity_usd ?? 0))
        ? `${usd(amount)} is more than its safe size of ${usd(mine.capacity_usd ?? 0)}.`
        : mine.verdict === "no_data" ? "Watchtower has no verdict for that route." : `${plainReasons(src, route, status, mine.reasons)}`;
      const how = p.alternativeKind === "same_source"
        ? `Keep your ${assetLabel(route.split("->")[0]!)} and receive on ${assetLabel(alt.route.split("->")[1]!)} instead`
        : `If you can fund from ${assetLabel(alt.route.split("->")[0]!)} instead, use that`;
      text = `REROUTE. Don't send via ${label} now: ${why}\n${how}: ${routeLabel(alt.route)} is ${STATUS_WORD[alt.status]} (score ${alt.score}/100) and can take up to ${usd(alt.capacityUsd)}.`;
    } else if (p.decision === "reduce") {
      const part = Math.floor(amount / (p.splitInto ?? 1));
      text = `REDUCE. ${label} is ${STATUS_WORD[status]}, but ${usd(amount)} is more than its safe size of ${usd(mine.capacity_usd ?? 0)}. Split it into ${p.splitInto} swaps of about ${usd(part)} each, a few minutes apart, and check again before each one.`;
    } else {
      const why = mine.verdict === "error"
        ? "Watchtower could not be reached, so the route is treated as unsafe."
        : mine.verdict === "no_data" ? "Watchtower has no verdict for that route yet."
        : mine.verdict === "stale" ? "The latest verdict is too old to rely on."
        : plainReasons(src, route, status, mine.reasons);
      text = `WAIT. Don't send via ${label}. ${why} No other route that delivers the same token can take ${usd(amount)} right now.`;
    }
    return reply(src, text, {
      decision: p.decision,
      route,
      amount_usd: amount,
      status,
      safe_size_usd: mine.capacity_usd ?? 0,
      score: mine.score,
      reasons: mine.reasons,
      alternative: p.alternative ? { route: p.alternative.route, kind: p.alternativeKind, status: p.alternative.status, score: p.alternative.score, safe_size_usd: p.alternative.capacityUsd } : null,
      split_into: p.splitInto ?? null,
      contract_check: { method: "check_intent", allowed: onchain.allowed, verdict: onchain.verdict, report_hash: onchain.report_hash, age_sec: onchain.age_sec },
    });
  },
};

const checkRoute: ToolDef = {
  name: "check_route",
  title: "Is this route safe right now?",
  description:
    "The yes/no that the watchtower contract's is_safe() returns for a route, plus the status, score, safe size in USD, reasons in plain language, how old the verdict is and the hash of the signed report. Fail-closed: no data, stale data or an unreachable contract all mean not safe.",
  inputSchema: { type: "object", properties: { ...pair, allow_amber: allowAmber }, required: ["from", "to"], additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run(args, src) {
    const known = await src.routes();
    const route = routeOf(args, assetCatalog(known));
    const c = await src.client.check(route, { allowAmber: args.allow_amber === true });
    const status = (c.status ?? "unknown") as Status;
    const head = c.safe ? `SAFE. ${routeLabel(route)} is ${STATUS_WORD[status]}` : `NOT SAFE. ${routeLabel(route)}`;
    const detail = c.verdict === "no_data" ? "Watchtower has no verdict for this route."
      : c.verdict === "stale" ? `The latest verdict is ${ageText(c)}, too old to rely on.`
      : c.verdict === "error" ? "Watchtower could not be reached; treat the route as unsafe."
      : c.verdict === "paused" ? "The watchtower contract is paused by its guardians."
      : c.verdict === "override" ? `A guardian set this route to ${status}.`
      : plainReasons(src, route, status, c.reasons);
    const size = c.safe ? ` Safe size: ${usd(c.capacity_usd ?? 0)}.` : "";
    return reply(src, `${head}. ${detail}${size}${c.score !== null ? ` Score ${c.score}/100.` : ""}${c.age_sec !== null ? ` Verdict ${ageText(c)}.` : ""}`, {
      route, safe: c.safe, verdict: c.verdict, status: c.status, score: c.score, safe_size_usd: c.capacity_usd, reasons: c.reasons, age_sec: c.age_sec, report_hash: c.report_hash,
    });
  },
};

const listRoutes: ToolDef = {
  name: "list_routes",
  title: "All routes, worst first",
  description: "Every route Watchtower covers with its status, score and safe size in USD, sorted with problems first. Optionally only one status.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["green", "amber", "unknown", "red"], description: "Only routes with this status." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run(args, src) {
    const known = await src.routes();
    const checks = await src.client.checkMany(known, { allowAmber: true });
    const rows = checks
      .map((c) => ({ route: c.route_id, status: (c.status ?? "unknown") as Status, score: c.score ?? 0, safe_size_usd: c.safe ? c.capacity_usd ?? 0 : 0, reasons: c.reasons, verdict: c.verdict }))
      .filter((r) => !args.status || r.status === args.status)
      .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.score - b.score);
    const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    const summary = (["red", "unknown", "amber", "green"] as Status[]).filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_WORD[s]}`).join(", ");
    const lines = rows.map((r) => `- ${routeLabel(r.route)}: ${STATUS_WORD[r.status]}, score ${r.score}, safe size ${usd(r.safe_size_usd)}`);
    return reply(src, `${rows.length} routes: ${summary || "none"}.\n${lines.join("\n")}`, { routes: rows });
  },
};

const explainRoute: ToolDef = {
  name: "explain_route",
  title: "Explain a route in plain language",
  description: "One short paragraph a non-expert can read: what is wrong with a route (or that it is fine) and what to do. Built only from the signed verdict's facts, never guessed. 11 languages (see lang).",
  inputSchema: {
    type: "object",
    properties: { ...pair, lang: { type: "string", enum: Object.keys(LANGS), default: "en", description: `Language of the explanation: ${Object.entries(LANGS).map(([k, v]) => `${k} (${v})`).join(", ")}.` } },
    required: ["from", "to"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run(args, src) {
    const known = await src.routes();
    const route = routeOf(args, assetCatalog(known));
    const lang = (String(args.lang) in LANGS ? args.lang : "en") as Lang;
    const c = await src.client.check(route, { allowAmber: true });
    if (c.verdict === "no_data" || c.verdict === "error") return reply(src, `${routeLabel(route)}: Watchtower has no verdict for this route, so treat it as unsafe.`, { route, lang, verdict: c.verdict });
    const status = (c.status ?? "unknown") as Status;
    const v = src.verdict(route) ?? { route, status, reasons: c.reasons, components: [] };
    const text = templateExplain(extractFacts({ ...v, status, reasons: c.reasons }), lang);
    return reply(src, text, { route, lang, status, reasons: c.reasons, report_hash: c.report_hash });
  },
};

export const TOOLS: ToolDef[] = [checkSwap, checkRoute, listRoutes, explainRoute];

export async function callTool(name: string, args: Record<string, unknown>, src: Source): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  try {
    return await tool.run(args ?? {}, src);
  } catch (e) {
    if (e instanceof AssetError) return fail(src, e.message);
    return fail(src, `Watchtower could not answer: ${(e as Error).message}. Treat the route as unsafe.`);
  }
}
