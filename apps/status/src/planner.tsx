import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Status } from "@watchtower/core";
import { describeReason, parseRoute } from "@watchtower/core";
import { preflight, type Decision, type RouteState } from "@watchtower/engine";
import { extractFacts, templateBody, type Lang } from "@watchtower/explainer";
import { chainName, routeLabel, type RouteRow, type Snapshot } from "./data.ts";
import { Token } from "./brand.tsx";
import { IArrow, IChevronDown, IClock, IRoutes, ISafe, ISplit } from "./icons.tsx";
import { k, sentences, t, tj } from "./i18n.ts";

/**
 * "Check a swap": the question a person actually has. Pick what you send, what you receive and
 * how much; get one of four answers. Same rules as check_intent() on-chain and the MCP server.
 */

const ICON: Record<Decision, typeof ISafe> = { go: ISafe, reduce: ISplit, reroute: IRoutes, wait: IClock };
const TITLE: Record<Decision, string> = { go: k("Go ahead"), reduce: k("Send it in parts"), reroute: k("Use another route"), wait: k("Don't send now") };
const PRESETS = [1_000, 10_000, 50_000, 250_000];

export function dollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function dollarsShort(n: number): string {
  if (n >= 1_000_000) return dollars(n);
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

export function whyText(row: RouteRow, lang: Lang): string {
  if (row.verdict) return templateBody(extractFacts(row.verdict), lang);
  return sentences(...row.reasons.filter((x) => describeReason(x).severity !== "info").map((x) => t(describeReason(x).plain))) || t("All checks passing.");
}

function toState(r: RouteRow): RouteState {
  const stale = r.ageSec !== undefined && r.ageSec > 300;
  return { route: r.route, status: stale ? "unknown" : r.status, score: r.score, capacityUsd: stale ? 0 : r.capacityUsd, reasons: r.reasons };
}

function TokenSelect({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const [sym, chain] = value.split(":") as [string, string];
  return (
    <div class="sw-field">
      <label class="sw-label" for={id}>{label}</label>
      <span class="sw-box sw-token">
        <Token symbol={sym} size={28} />
        <span class="sw-token-text"><b>{sym.toUpperCase()}</b><span>{chainName(chain)}</span></span>
        <IChevronDown size={16} />
        <select id={id} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          {options.map((o) => { const [s, c] = o.split(":") as [string, string]; return <option key={o} value={o}>{t("{sym} on {chain}", { sym: s.toUpperCase(), chain: chainName(c) })}</option>; })}
        </select>
      </span>
    </div>
  );
}

/** Amount against the safe size: the part that fits, the part that doesn't, and where the limit sits. */
function SizeBar({ amount, cap, status }: { amount: number; cap: number; status: Status }) {
  const scale = Math.max(amount, cap, 1);
  const fits = Math.min(amount, cap) / scale;
  const over = Math.max(0, amount - cap) / scale;
  return (
    <div class="sw-size">
      <div class="sw-size-head">
        <span>{t("Safe size right now")}</span>
        <b class={cap === 0 ? "t-red" : ""}>{cap === 0 ? t("$0, route blocked") : dollars(cap)}</b>
      </div>
      <div class={`sw-bar s-${status}`} role="img" aria-label={t("Your amount {amount}, safe size {cap}", { amount: dollars(amount), cap: dollars(cap) })}>
        <span class="sw-track">
          <i class="sw-fit" style={{ width: `${fits * 100}%` }} />
          <i class="sw-over" style={{ width: `${over * 100}%` }} />
        </span>
        {cap > 0 && <span class="sw-limit" style={{ left: `${(cap / scale) * 100}%` }} />}
      </div>
    </div>
  );
}

export function SwapCheck({ snap, lang, onDevelopers }: { snap: Snapshot; lang: Lang; onDevelopers: () => void }) {
  const routes = snap.routes;
  const sources = useMemo(() => [...new Set(routes.map((r) => parseRoute(r.route).src))].sort(), [routes]);
  const [src, setSrc] = useState(() => read("iwt-swap-src") ?? "usdt:bsc");
  const [dst, setDst] = useState(() => read("iwt-swap-dst") ?? "usdc:near");
  const [text, setText] = useState(() => read("iwt-swap-amount") ?? "50,000");

  const from = sources.includes(src) ? src : sources[0] ?? src;
  const dests = useMemo(() => routes.map((r) => parseRoute(r.route)).filter((p) => p.src === from).map((p) => p.dst), [routes, from]);
  const to = dests.includes(dst) ? dst : dests[0] ?? dst;
  useEffect(() => { if (from !== src) setSrc(from); if (to !== dst) setDst(to); }, [from, to]);

  const amount = Number(text.replace(/[^0-9.]/g, "")) || 0;
  const setAmount = (v: string) => { setText(v); keep("iwt-swap-amount", v); };
  const pickSrc = (v: string) => { setSrc(v); keep("iwt-swap-src", v); };
  const pickDst = (v: string) => { setDst(v); keep("iwt-swap-dst", v); };
  const use = (route: string) => { const p = parseRoute(route); pickSrc(p.src); pickDst(p.dst); };

  const route = `${from}->${to}`;
  const row = routes.find((r) => r.route === route);
  const p = useMemo(() => preflight(route, amount, routes.map(toState), { allowAmber: false }), [route, amount, routes]);
  const l = routeLabel(route);
  const status: Status = row?.status ?? "unknown";
  const cap = row && p.status !== "unknown" ? row.capacityUsd : 0;
  const tone: Status = p.decision === "go" ? "green" : p.decision === "wait" ? (status === "unknown" ? "unknown" : "red") : "amber";
  const Icon = ICON[p.decision];

  let body: ComponentChildren;
  if (amount <= 0) body = t("Enter how much you want to send.");
  else if (p.decision === "go") body = sentences(t("{amount} fits within what this route can safely carry right now.", { amount: dollars(amount) }), status === "green" && t("All checks are passing."));
  else if (p.decision === "reduce") body = t("This route is safe, but {amount} is more than it can carry right now. Send {n} swaps of about {part}, a few minutes apart, and check again before each one.", { amount: dollars(amount), n: p.splitInto ?? 1, part: dollars(Math.floor(amount / (p.splitInto ?? 1))) });
  else {
    const why = !row ? t("Watchtower doesn't cover this pair yet.")
      : p.status === "unknown" ? t("Watchtower can't verify this route right now, so it counts as unsafe.")
      : status === "amber" ? sentences(t("This route is marked Caution, so Watchtower won't say go."), whyText(row, lang))
      : status === "green" ? t("{amount} is more than this route can carry right now.", { amount: dollars(amount) })
      : whyText(row, lang);
    body = p.decision === "wait" ? sentences(why, t("No other route into {sym} can take {amount} right now.", { sym: l.dst, amount: dollars(amount) })) : why;
  }

  const alt = p.decision === "reroute" ? p.alternative : undefined;
  const al = alt ? routeLabel(alt.route) : null;

  return (
    <section class="card swap" aria-labelledby="swap-title">
      <div class="card-head">
        <h2 id="swap-title">{t("Check a swap before you send it")}</h2>
        {snap.kind === "replay" && <span class="hint">{t("The answer updates as the replay plays")}</span>}
      </div>
      <div class="sw-body">
        <form class="sw-form" onSubmit={(e) => e.preventDefault()}>
          <TokenSelect id="sw-from" label={t("You send")} value={from} options={sources} onChange={pickSrc} />
          <span class="sw-arrow" aria-hidden="true"><IArrow size={18} /></span>
          <TokenSelect id="sw-to" label={t("You receive")} value={to} options={dests} onChange={pickDst} />
          <div class="sw-field sw-amount">
            <label class="sw-label" for="sw-amount">{t("Amount")}</label>
            <span class="sw-box">
              <span class="sw-cur" aria-hidden="true">$</span>
              <input id="sw-amount" inputMode="decimal" autoComplete="off" value={text}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
                onBlur={() => amount > 0 && setAmount(Math.round(amount).toLocaleString("en-US"))} />
            </span>
            <div class="sw-presets" role="group" aria-label={t("Quick amounts")}>
              {PRESETS.map((v) => (
                <button key={v} type="button" class="chip" aria-pressed={Math.round(amount) === v} onClick={() => setAmount(v.toLocaleString("en-US"))}>{dollarsShort(v)}</button>
              ))}
            </div>
          </div>
        </form>

        <div key={`${p.decision}:${route}:${alt?.route ?? ""}`} class={`sw-answer s-${tone}`} aria-live="polite">
          <div class="sw-answer-top">
            <span class="sicon"><Icon size={22} /></span>
            <h3>{amount > 0 ? t(TITLE[p.decision]) : t("How much?")}</h3>
          </div>
          <p>{body}</p>
          {amount > 0 && <SizeBar amount={amount} cap={cap} status={status === "unknown" ? "unknown" : cap === 0 ? "red" : amount > cap ? "amber" : "green"} />}
          {alt && al && (
            <div class="sw-alt">
              <p class="sw-alt-lead">
                {p.alternativeKind === "same_source"
                  ? t("Keep your {src} and receive {dst} on {chain} instead:", { src: l.src, dst: al.dst, chain: al.dstChain })
                  : t("If you can pay with {src} on {chain} instead:", { src: al.src, chain: al.srcChain })}
              </p>
              <div class="sw-alt-row s-green">
                <span class="pair"><Token symbol={al.src} size={24} /><Token symbol={al.dst} size={24} /></span>
                <span class="sw-alt-text">
                  <b>{al.src} <IArrow size={12} class="arrow" /> {al.dst}</b>
                  <span>{t("Safe, carries up to {amount}", { amount: dollars(alt.capacityUsd) })}</span>
                </span>
                <button type="button" class="btn" onClick={() => use(alt.route)}>{t("Check this route")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <p class="sw-foot">
        {tj("Apps and AI agents get this same answer on-chain from {fn} and from the Watchtower MCP server.", { fn: <code>check_intent()</code> })}{" "}
        <a href="#developers" onClick={(e) => { e.preventDefault(); onDevelopers(); }}>{t("How to connect")}</a>
      </p>
    </section>
  );
}
