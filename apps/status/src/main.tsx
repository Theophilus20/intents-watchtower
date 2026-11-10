/**
 * Intents Watchtower — status app.
 *
 * Runs the real engine, contract model, watcher signatures and SDK from this monorepo. Data comes
 * from a deterministic replay (default) or from a deployed watchtower contract (live mode).
 */
import { render, type ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Status } from "@watchtower/core";
import { DEFAULT_ROUTES, STATUS_RANK, describeReason, parseRoute, reasonCode, reasonSubject } from "@watchtower/core";
import { extractFacts, templateBody, type Lang } from "@watchtower/explainer";
import { SCENARIOS, ScenarioRun, type Frame, type ReplayResult, type Scenario, type Transition } from "@watchtower/replay";
import { RouteUnsafeError, Watchtower, withWatchtower } from "@watchtower/sdk";
import {
  CHECK_TITLES, CONTRACT, LIVE_NETWORKS, WATCHERS, assetName, chainName, checkSummary, fetchLive, fmtBacking, fmtUsd, mirrorFor, quorumDemo, routeLabel, snapshotFromFrame, worst,
  chainNodes, type ChainNode, type RouteRow, type Snapshot,
} from "./data.ts";
import { Brand, CHAIN_TOKEN, Token, TokenGlyph } from "./brand.tsx";
import { HowItWorks } from "./guide.tsx";
import { PROOF, readBacking, readHeads, routeBacking, routeBackingError, type AssetBacking } from "./proof.ts";
import { SwapCheck, dollars, dollarsShort } from "./planner.tsx";
import { LANG_OPTIONS, isLang, k, sentences, setLang as setI18nLang, span, t, tEvent, textUnits, tj } from "./i18n.ts";
import { SettingsPanel, motionReduced, usePreferences } from "./settings.tsx";
import {
  IArrow, ICare, IChains, ICheck, IChevronDown, IChevronRight, IClose, ICode, ICopy, IGear, IHelp, IHistory, IKey, IPause, IPlay, IRadio, IRestart, IRoutes, ISafe, IShield, IUnknown, IUnsafe,
} from "./icons.tsx";

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

const STATUS_LABEL: Record<Status, string> = { green: k("Safe"), amber: k("Caution"), unknown: k("Unverified"), red: k("Unsafe") };
const ANSWER: Record<Status, string> = { green: k("Safe to route"), amber: k("Usable with care"), unknown: k("Can't verify right now"), red: k("Don't route through here") };
const statusLabel = (s: Status) => t(STATUS_LABEL[s]);
type View = "routes" | "chains" | "watchers" | "developers";
const VIEWS: { id: View; label: string; Icon: typeof IRoutes }[] = [
  { id: "routes", label: k("Routes"), Icon: IRoutes },
  { id: "chains", label: k("Chains"), Icon: IChains },
  { id: "watchers", label: k("Watchers"), Icon: IShield },
  { id: "developers", label: k("Developers"), Icon: ICode },
];

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const remember = (k: string, v: string) => {
  try {
    store()?.setItem(k, v);
  } catch {
    /* storage blocked */
  }
};
const recall = (k: string) => {
  try {
    return store()?.getItem(k) ?? null;
  } catch {
    return null;
  }
};

/** Plain words for where the replay is: "12 min after the incident". */
const relLong = (m: number) => (m === 0 ? t("The incident starts") : m < 0 ? t("{span} before the incident", { span: span(m) }) : t("{span} after the incident", { span: span(m) }));
/** Compact form for lists: "+12 min", "−20 min", "Start". */
const relShort = (m: number) => (m === 0 ? t("Start") : `${m < 0 ? "−" : "+"}${span(m)}`);
const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

// ---------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------

function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  const Icon = { green: ISafe, amber: ICare, unknown: IUnknown, red: IUnsafe }[status];
  return <span class={`sicon s-${status}`}><Icon size={size} /></span>;
}

function Badge({ status }: { status: Status }) {
  return (
    <span class={`badge s-${status}`}>
      <StatusIcon status={status} size={14} />
      {statusLabel(status)}
    </span>
  );
}

function Pair({ route, size = 26 }: { route: string; size?: number }) {
  const l = routeLabel(route);
  return (
    <span class="pair">
      <Token symbol={l.src} size={size} />
      <span class="pair-2"><Token symbol={l.dst} size={size} /></span>
    </span>
  );
}

function Spark({ values, status }: { values: number[]; status: Status }) {
  if (values.length < 2) return <svg class="spark" viewBox="0 0 72 22" aria-hidden="true" />;
  const n = values.length;
  const x = (i: number) => (i / (n - 1)) * 70 + 1;
  const y = (v: number) => 20 - (v / 100) * 18;
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  return (
    <svg class={`spark s-${status}`} viewBox="0 0 72 22" aria-hidden="true">
      <path class="spark-area" d={`${d}L${x(n - 1).toFixed(1)} 21L1 21Z`} />
      <path class="spark-line" d={d} />
      <circle class="spark-dot" cx={x(n - 1)} cy={y(values[n - 1]!)} r="2.4" />
    </svg>
  );
}

function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } catch {
      // Clipboard refused: select the text next to the button so the person can copy it by hand.
      const target = ref.current?.closest(".code, .hash")?.querySelector("code, .mono");
      if (target) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };
  return (
    <button ref={ref} type="button" class="icon-btn" onClick={onClick} aria-label={done ? t("Copied") : label ?? t("Copy")} title={done ? t("Copied") : label ?? t("Copy")}>
      {done ? <ICheck size={15} /> : <ICopy size={15} />}
    </button>
  );
}

const KW = /^(import|from|const|let|await|async|return|if|new|fn|trait|use|pub|impl|self|Self|Some|None|true|false|null|type|export|function)$/;
/** Minimal highlighter for the TypeScript and Rust snippets: strings, comments, keywords, calls. */
function highlight(code: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|`[^`]*`)|(#\[[^\]]*\])|([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (m.index! > last) out.push(code.slice(last, m.index));
    const [tok, comment, str, attr, call, word] = m;
    if (comment) out.push(<span class="tk-c">{comment}</span>);
    else if (str) out.push(<span class="tk-s">{str}</span>);
    else if (attr) out.push(<span class="tk-c">{attr}</span>);
    else if (call) out.push(KW.test(call) ? <span class="tk-k">{call}</span> : <span class="tk-f">{call}</span>);
    else if (word && KW.test(word)) out.push(<span class="tk-k">{word}</span>);
    else out.push(tok);
    last = m.index! + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/** A code block with its copy button in a header bar, so the button never covers the code. */
function Code({ children, text, label, wrap }: { children: ComponentChildren; text: string; label?: string; wrap?: boolean }) {
  return (
    <div class={`code${wrap ? " code-wrap" : ""}`}>
      <div class="code-bar"><span>{label ?? ""}</span><Copy text={text} label={t("Copy code")} /></div>
      <pre><code>{children}</code></pre>
    </div>
  );
}

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [q]);
  return m;
}

function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ComponentChildren; wide?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    document.documentElement.classList.add("locked");
    return () => {
      removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("locked");
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="sheet-root" role="presentation">
      <div class="scrim" onClick={onClose} />
      <section class={`sheet${wide ? " sheet-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-head">
          <h2>{title}</h2>
          <button ref={closeRef} type="button" class="icon-btn" onClick={onClose} aria-label={t("Close")}><IClose size={18} /></button>
        </header>
        <div class="sheet-body">{children}</div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Replay engine hook
// ---------------------------------------------------------------------------------------------

interface ReplayState {
  scenario: Scenario;
  frames: Frame[];
  transitions: Transition[];
  index: number;
  computed: number;
  playing: boolean;
  speed: number;
  result: ReplayResult | null;
}

function useReplay(scenarioId: string | null) {
  const [, force] = useState(0);
  const runRef = useRef<ScenarioRun | null>(null);
  const st = useRef<ReplayState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const rerender = useCallback(() => force((x) => x + 1), []);

  useEffect(() => {
    if (!scenarioId) return;
    const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;
    const run = new ScenarioRun(scenario, { keepVerdicts: true });
    runRef.current = run;
    const start = Math.max(0, scenario.incidentAtMin - 10);
    st.current = { scenario, frames: run.frames, transitions: run.transitions, index: 0, computed: 0, playing: false, speed: Number(recall("iwt-speed") ?? 4), result: null };
    let cancelled = false;
    (async () => {
      while (!run.done && !cancelled) {
        const t0 = performance.now();
        while (!run.done && performance.now() - t0 < 20) run.step();
        const s = st.current!;
        s.computed = run.frames.length;
        if (s.index === 0 && run.frames.length > start) s.index = start;
        rerender();
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled) return;
      st.current!.result = run.finish();
      if (!motionReduced()) st.current!.playing = true;
      rerender();
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [scenarioId]);

  const s = st.current;
  useEffect(() => {
    clearTimeout(timer.current);
    if (!s?.playing) return;
    timer.current = setTimeout(() => {
      if (!s.playing) return;
      if (s.index >= s.scenario.durationMin) s.playing = false;
      else if (s.index + 1 < s.computed) s.index++;
      rerender();
    }, 1000 / s.speed);
    return () => clearTimeout(timer.current);
  });

  const api = useMemo(
    () => ({
      seek(i: number) {
        if (!st.current) return;
        st.current.index = Math.max(0, Math.min(i, st.current.computed - 1));
        rerender();
      },
      toggle() {
        const c = st.current;
        if (!c) return;
        if (!c.playing && c.index >= c.scenario.durationMin) c.index = 0;
        c.playing = !c.playing;
        rerender();
      },
      pause() {
        if (st.current?.playing) {
          st.current.playing = false;
          rerender();
        }
      },
      setSpeed(v: number) {
        if (!st.current) return;
        st.current.speed = v;
        remember("iwt-speed", String(v));
        rerender();
      },
    }),
    [],
  );
  return { state: s, ...api };
}

const BACKING_CACHE = "wt-backing-v1";
/** The last backing reading saved in this browser (at most a day old), or null. Storage can be blocked: then null. */
function loadBackingCache(contractId: string | undefined): { backing: Map<string, AssetBacking>; atMs: number } | null {
  if (!contractId) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(BACKING_CACHE) ?? "null") as { contractId: string; atMs: number; items: (Omit<AssetBacking, "owed" | "held" | "short"> & { owed?: string; held?: string; short?: string })[] } | null;
    if (!raw || raw.contractId !== contractId || Date.now() - raw.atMs > 86_400_000 || !Array.isArray(raw.items)) return null;
    const big = (v?: string) => (v === undefined ? undefined : BigInt(v));
    return { atMs: raw.atMs, backing: new Map(raw.items.map((i) => [i.asset, { ...i, owed: big(i.owed), held: big(i.held), short: big(i.short) }])) };
  } catch {
    return null;
  }
}
function saveBackingCache(contractId: string, backing: Map<string, AssetBacking>): void {
  try {
    if (![...backing.values()].some((b) => b.ppm !== null)) return; // nothing was read: keep the older reading
    const items = [...backing.values()].map((b) => ({ ...b, owed: b.owed?.toString(), held: b.held?.toString(), short: b.short?.toString() }));
    localStorage.setItem(BACKING_CACHE, JSON.stringify({ contractId, atMs: Date.now(), items }));
  } catch {
    /* storage unavailable: the page works without it */
  }
}

function backingNoteText(n: NonNullable<Snapshot["backingNote"]>): string {
  if (n.kind === "missing") return t("This page was built without the bridges' wallet list, so it can't check backing itself. Build it from the intents-watchtower folder with WATCHTOWER_LIVE set.");
  if (n.kind === "checking") return t("Checking each bridge's backing from the chains…");
  const time = new Date(n.atMs ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const base = t("Backing checked by this page from the chains at {time}: {read} of {total} bridged assets read.", { time, read: n.read ?? 0, total: n.total ?? 0 });
  if (!n.failed?.length) return base;
  return `${base} ${t("Couldn't read {list}: {why}", { list: n.failed.map((a) => a.split(":")[0]!.toUpperCase()).join(", "), why: (n.error ?? "").slice(0, 120) })}`;
}

// ---------------------------------------------------------------------------------------------
// Live contract hook
// ---------------------------------------------------------------------------------------------

interface LiveSource {
  network: keyof typeof LIVE_NETWORKS;
  contractId: string;
}

function useLive(src: LiveSource | null) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    setSnap(null);
    setError(null);
    const load = async () => {
      setLoading(true);
      try {
        const s = await fetchLive(src.network, src.contractId);
        if (alive) {
          setSnap(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message || String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [src?.network, src?.contractId]);

  // Backing, read by the page itself from the chains every 2 minutes (gentle on free endpoints).
  // The last reading is kept in the browser, so a returning visitor sees numbers at once while the fresh check runs.
  const cached = useMemo(() => loadBackingCache(src?.contractId), [src?.contractId]);
  const [backing, setBacking] = useState<Map<string, AssetBacking> | null>(cached?.backing ?? null);
  const [backingAt, setBackingAt] = useState<number | null>(cached?.atMs ?? null);
  const [heads, setHeads] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    const proof = PROOF;
    if (!src || !proof) return;
    let alive = true;
    const read = async () => {
      try {
        const [b, h] = await Promise.all([readBacking(proof), readHeads(proof)]);
        if (alive) { setBacking(b); setBackingAt(Date.now()); setHeads(h); saveBackingCache(src.contractId, b); }
      } catch {
        /* keep the last reading */
      }
    };
    void read();
    const t = setInterval(read, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [src?.network, src?.contractId]);

  // Each route's score at every refresh while the page is open, for the "Last hour" line.
  const seen = useRef(new Map<string, { atMs: number; score: number }[]>());
  useEffect(() => {
    if (!snap) return;
    const now = Date.now();
    for (const r of snap.routes) {
      const h = (seen.current.get(r.route) ?? []).filter((x) => now - x.atMs < 3_600_000);
      h.push({ atMs: now, score: r.status === "unknown" ? 0 : r.score });
      seen.current.set(r.route, h);
    }
  }, [snap]);

  const merged = useMemo(() => {
    if (!snap) return snap;
    if (!PROOF) return { ...snap, backingNote: { kind: "missing" as const } };
    const chains = heads ? snap.chains.map((c) => (heads.has(c.chain) ? { ...c, secondsSinceBlock: Math.max(0, Math.round((Date.now() - heads.get(c.chain)!) / 1000)) } : c)) : snap.chains;
    if (!backing) return { ...snap, chains, backingNote: { kind: "checking" as const } };
    const read = [...backing.values()].filter((b) => b.ppm !== null);
    let lowest: { asset: string; ppm: number } | null = null;
    for (const b of read) if (!lowest || b.ppm! < lowest.ppm) lowest = { asset: b.asset, ppm: b.ppm! };
    return {
      ...snap,
      chains,
      routes: snap.routes.map((r) => ({ ...r, backingPpm: routeBacking(r.route, backing), backingError: routeBackingError(r.route, backing) })),
      lowestBacking: lowest,
      backed: read.length ? { full: read.filter((b) => b.ppm! >= 1_000_000).length, total: read.length, short: read.filter((b) => b.ppm! < 1_000_000).map((b) => b.asset) } : undefined,
      backingNote: { kind: "done" as const, atMs: backingAt ?? Date.now(), read: read.length, total: backing.size, failed: [...backing.values()].filter((b) => b.ppm === null).map((b) => b.asset), error: [...backing.values()].find((b) => b.error)?.error },
    };
  }, [snap, backing, backingAt, heads]);
  const history = (route: string) => (seen.current.get(route) ?? []).map((x) => x.score);
  return { snap: merged, error, loading, history };
}

// ---------------------------------------------------------------------------------------------
// Routes view
// ---------------------------------------------------------------------------------------------

function verdictCopy(snap: Snapshot): { status: Status; title: string; body: string } {
  const by = (s: Status) => snap.routes.filter((r) => r.status === s);
  const red = by("red"), unk = by("unknown"), amber = by("amber");
  const n = snap.routes.length;
  const affected = (rows: RouteRow[]) => {
    const subjects = new Set<string>();
    for (const r of rows) for (const reason of r.reasons) {
      const sev = describeReason(reason).severity;
      if (sev !== r.status) continue;
      const subj = reasonSubject(reason);
      if (!subj || subj.includes("->")) continue;
      subjects.add(subj.includes(":") ? assetName(subj) : chainName(subj));
    }
    return [...subjects].slice(0, 3);
  };
  const names = (rows: RouteRow[]) => {
    const list = rows.map((r) => { const l = routeLabel(r.route); return `${l.src} → ${l.dst}`; });
    if (list.length === 1) return list[0]!;
    if (list.length === 2) return t("{a} and {b}", { a: list[0]!, b: list[1]! });
    return t("{a} and {n} more", { a: list.slice(0, 2).join(t(", ")), n: list.length - 2 });
  };
  const lead = (rows: RouteRow[]) => {
    const reason = rows.flatMap((r) => r.reasons).find((x) => describeReason(x).severity === rows[0]!.status) ?? rows[0]!.reasons[0];
    if (!reason) return "";
    const d = describeReason(reason);
    // Route-level reasons read badly in a summary ("this route"), so name the routes instead.
    if (d.check === "concentration") return rows.length === 1 ? t("{routes} relies on a few solvers for most of its liquidity.", { routes: names(rows) }) : t("{routes} rely on a few solvers for most of their liquidity.", { routes: names(rows) });
    return t(d.plain);
  };
  const affects = (rows: RouteRow[]) => { const a = affected(rows); return a.length ? t("Affects {list}.", { list: a.join(t(", ")) }) : ""; };
  if (red.length) return { status: "red", title: red.length === 1 ? t("1 route is unsafe right now") : t("{n} routes are unsafe right now", { n: red.length }), body: sentences(lead(red), affects(red)) };
  if (unk.length) return { status: "unknown", title: unk.length === 1 ? t("1 route can't be verified right now") : t("{n} routes can't be verified right now", { n: unk.length }), body: sentences(lead(unk), t("Until then, is_safe returns false.")) };
  if (amber.length) return { status: "amber", title: t("{safe} of {n} routes are safe; {care} need care", { safe: n - amber.length, n, care: amber.length }), body: sentences(lead(amber), affects(amber)) };
  return { status: "green", title: t("All {n} routes are safe to use", { n }), body: t("Every credited token is backed, every credit matches a real deposit, and no chain they depend on is in trouble.") };
}

function Verdict({ snap, context }: { snap: Snapshot; context: ComponentChildren }) {
  const v = verdictCopy(snap);
  const safe = snap.routes.filter((r) => r.status === "green").length;
  return (
    <section class={`verdict v-${v.status}`} aria-live="polite">
      <div class="verdict-main">
        <StatusIcon status={v.status} size={30} />
        <div>
          <h1>{v.title}</h1>
          <p class="verdict-body">{v.body}</p>
          <p class="verdict-meta">{context}</p>
        </div>
      </div>
      <dl class="stats">
        <div><dt>{t("Safe routes")}</dt><dd>{safe} <span>{t("of {n}", { n: snap.routes.length })}</span></dd></div>
        <div>
          <dt>{t("Lowest backing")}</dt>
          <dd class={snap.lowestBacking && snap.lowestBacking.ppm < 995_000 ? "t-red" : snap.lowestBacking && snap.lowestBacking.ppm < 1_000_000 ? "t-amber" : ""}>
            {snap.lowestBacking ? fmtBacking(snap.lowestBacking.ppm) : snap.backingNote?.kind === "checking" ? <i class="skel skel-num" aria-label={t("Checking each bridge's backing from the chains…")} /> : t("n/a")}
            {snap.lowestBacking && <span class="sub">{assetName(snap.lowestBacking.asset)}</span>}
          </dd>
        </div>
        {snap.kind === "live" ? (
          // Live: the page can't match every deposit to a credit, but it checks every bridge's wallets itself.
          <div>
            <dt>{t("Bridged assets fully backed")}</dt>
            <dd class={snap.backed && snap.backed.short.length ? "t-amber" : ""}>
              {snap.backed ? <>{snap.backed.full} <span>{t("of {n}", { n: snap.backed.total })}</span></> : snap.backingNote?.kind === "checking" ? <i class="skel skel-num" aria-hidden="true" /> : t("n/a")}
              {snap.backed && snap.backed.short.length > 0 && <span class="sub">{t("Short: {list}", { list: snap.backed.short.map((a) => a.split(":")[0]!.toUpperCase()).join(", ") })}</span>}
            </dd>
          </div>
        ) : (
          <div><dt>{t("Credited with nothing behind it")}</dt><dd class={snap.unbackedCents > 0n ? "t-red" : ""}>{fmtUsd(snap.unbackedCents)}</dd></div>
        )}
        <div><dt>{t("Watchers agreeing")}</dt><dd class={snap.watchers.agreeing < snap.watchers.total ? "t-amber" : ""}>{snap.watchers.agreeing} <span>{t("of {n}", { n: snap.watchers.total })}</span></dd></div>
      </dl>
      {snap.backingNote && <p class="verdict-meta backing-note">{backingNoteText(snap.backingNote)}</p>}
    </section>
  );
}

type Filter = "all" | Status;

function topReason(r: RouteRow): string | null {
  if (r.status === "green") return null;
  const reason = r.reasons.find((x) => describeReason(x).severity === r.status) ?? r.reasons.find((x) => describeReason(x).severity !== "info");
  return reason ? t(describeReason(reason).title) : null;
}

/**
 * Rows glide to their new place when statuses change (FLIP), and a row that just changed status
 * glows once in its new colour. Both respect the Motion setting.
 */
function useRowMotion(listRef: { current: HTMLElement | null }, rows: RouteRow[]) {
  const tops = useRef(new Map<string, number>());
  const statuses = useRef(new Map<string, Status>());
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const animate = !motionReduced();
    const nextTops = new Map<string, number>();
    for (const item of el.querySelectorAll<HTMLElement>("[data-route]")) {
      const key = item.dataset.route!;
      const top = item.offsetTop;
      nextTops.set(key, top);
      const old = tops.current.get(key);
      if (animate && old !== undefined && old !== top && typeof item.animate === "function") {
        item.animate([{ transform: `translateY(${old - top}px)` }, { transform: "translateY(0)" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }
    tops.current = nextTops;
    for (const r of rows) {
      const prev = statuses.current.get(r.route);
      if (animate && prev && prev !== r.status) {
        const glow = el.querySelector<HTMLElement>(`[data-route="${r.route}"] .glow`);
        if (glow && typeof glow.animate === "function") glow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1600, easing: "ease-out" });
      }
      statuses.current.set(r.route, r.status);
    }
  });
}

function RouteTable({ snap, history, selected, onSelect }: { snap: Snapshot; history: (route: string) => number[]; selected: string; onSelect: (r: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const listRef = useRef<HTMLDivElement>(null);
  useRowMotion(listRef, snap.routes);
  const counts = { all: snap.routes.length, red: 0, unknown: 0, amber: 0, green: 0 } as Record<Filter, number>;
  for (const r of snap.routes) counts[r.status]++;
  const rows = [...snap.routes]
    .filter((r) => filter === "all" || r.status === filter)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.score - b.score || a.route.localeCompare(b.route));
  const filters: { id: Filter; label: string }[] = [{ id: "all", label: t("All") }, { id: "red", label: statusLabel("red") }, { id: "unknown", label: statusLabel("unknown") }, { id: "amber", label: statusLabel("amber") }, { id: "green", label: statusLabel("green") }];
  return (
    <section class="card routes-card" aria-label={t("Routes")}>
      <div class="card-head">
        <h2>{t("Routes")}</h2>
        <div class="seg" role="tablist" aria-label={t("Filter routes")}>
          {filters.filter((f) => f.id === "all" || counts[f.id] > 0 || f.id === filter).map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span class="count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="rt" role="table" aria-label={t("Route safety")} ref={listRef}>
        <div class="rt-row rt-headrow" role="row">
          <span role="columnheader">{t("Route")}</span>
          <span role="columnheader">{t("Status")}</span>
          <span role="columnheader" class="num col-size">{t("Safe size")}</span>
          <span role="columnheader" class="num col-backing">{t("Backing")}</span>
          <span role="columnheader" class="col-trend">{t("Last hour")}</span>
          <span aria-hidden="true" />
        </div>
        {rows.map((r) => {
          const l = routeLabel(r.route);
          const why = topReason(r);
          return (
            <button key={r.route} data-route={r.route} type="button" role="row" class={`rt-row rt-item${r.route === selected ? " is-selected" : ""} s-${r.status}`} aria-pressed={r.route === selected} onClick={() => onSelect(r.route)}>
              <span class="glow" aria-hidden="true" />
              <span role="cell" class="rt-route">
                <Pair route={r.route} />
                <span class="rt-names">
                  <span class="rt-pair">{l.src} <IArrow size={13} class="arrow" /> {l.dst}</span>
                  <span class="rt-sub">{why ?? t("{a} to {b}", { a: l.srcChain, b: l.dstChain })}</span>
                </span>
              </span>
              <span role="cell"><Badge status={r.status} /></span>
              <span role="cell" class={`num col-size${r.capacityUsd === 0 ? (r.status === "red" ? " is-blocked" : " is-held") : ""}`}>{r.capacityUsd === 0 ? t("Blocked") : dollarsShort(r.capacityUsd)}</span>
              <span role="cell" class={`num col-backing ${r.backingPpm !== null && r.backingPpm < 995_000 ? "t-red" : ""}`} title={r.backingError ? t("Couldn't read {list}: {why}", { list: r.backingError.split(":")[0]!, why: r.backingError.slice(r.backingError.indexOf(":") + 1).trim().slice(0, 160) }) : undefined}>{r.backingPpm === null && snap.backingNote?.kind === "checking" ? <i class="skel skel-cell" aria-hidden="true" /> : fmtBacking(r.backingPpm)}</span>
              <span role="cell" class="col-trend"><Spark values={history(r.route)} status={r.status} /></span>
              <span class="rt-chev" aria-hidden="true"><IChevronRight size={16} /></span>
            </button>
          );
        })}
        {rows.length === 0 && <p class="empty">{t("No routes with this status right now.")}</p>}
      </div>
    </section>
  );
}

function BackingChart({ frames, index, assets, incidentAt, duration }: { frames: Frame[]; index: number; assets: string[]; incidentAt: number; duration: number }) {
  const W = 340, H = 132, L = 44, R = 8, T = 10, B = 20;
  const series = assets.map((a) => frames.slice(0, index + 1).map((f) => f.assets.find((x) => x.asset === a)?.backingPpm ?? null));
  const vals = series.flat().filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  let lo = Math.min(993_000, ...vals), hi = Math.max(1_007_000, ...vals);
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const x = (i: number) => L + (i / Math.max(1, duration)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const span = hi - lo;
  const step = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000].find((s) => span / s <= 4) ?? 200_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return (
    <figure class="chart-fig">
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("Backing over time for {assets}", { assets: assets.map(assetName).join(t(", ")) })}>
        {ticks.map((t) => (
          <g key={t}>
            <line class="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text x={L - 6} y={y(t) + 3.5} text-anchor="end">{(t / 10_000).toFixed(step < 10_000 ? 1 : 0)}%</text>
          </g>
        ))}
        <line class="limit" x1={L} x2={W - R} y1={y(995_000)} y2={y(995_000)} />
        <text class="limit-label" x={W - R} y={y(995_000) - 4} text-anchor="end">{t("Unsafe below 99.5%")}</text>
        <line class="incident" x1={x(incidentAt)} x2={x(incidentAt)} y1={T} y2={H - B} />
        <text x={x(incidentAt)} y={H - 5} text-anchor="middle">{t("Incident")}</text>
        {series.map((ser, k) => {
          let d = "", pen = false;
          ser.forEach((v, i) => {
            if (v === null) return void (pen = false);
            d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
            pen = true;
          });
          const last = ser[ser.length - 1];
          return (
            <g key={k} class={`series c${k}`}>
              <path d={d} />
              {last != null && <circle cx={x(ser.length - 1)} cy={y(last)} r="3.5" />}
            </g>
          );
        })}
      </svg>
      <figcaption class="legend">
        {assets.map((a, k) => {
          const v = frames[index]?.assets.find((x) => x.asset === a)?.backingPpm ?? null;
          return <span key={a}><i class={`c${k}`} />{assetName(a)} <b class={v !== null && v < 995_000 ? "t-red" : ""}>{fmtBacking(v)}</b></span>;
        })}
      </figcaption>
    </figure>
  );
}

function QuorumBlock({ row, snap, lying, setLying, compact }: { row: RouteRow; snap: Snapshot; lying: boolean; setLying: (v: boolean) => void; compact?: boolean }) {
  const q = useMemo(() => (snap.kind === "replay" ? quorumDemo(row, snap.epoch, snap.asOfMs, lying) : null), [row.reportHash, row.route, snap.epoch, lying, snap.kind]);
  if (!q) {
    return (
      <div class="proof">
        <div class="kv"><span>{t("Report hash")}</span><span class="hash"><span class="mono">{row.reportHash}</span><Copy text={row.reportHash} label={t("Copy report hash")} /></span></div>
        <p class="note">{sentences(t("Watchers who signed: {n}.", { n: row.signers ?? 0 }), row.ageSec !== undefined && t("Observed {s} s ago.", { s: row.ageSec }))}</p>
      </div>
    );
  }
  return (
    <div class="proof">
      <div class="kv"><span>{t("Report hash")}</span><span class="hash"><span class="mono">{row.reportHash}</span><Copy text={row.reportHash} label={t("Copy report hash")} /></span></div>
      <ul class="sigs">
        {q.attestations.map((a) => (
          <li key={a.watcher.id} class={a.lying ? "is-liar" : ""}>
            <StatusIcon status={a.lying ? "red" : "green"} size={15} />
            <span class="sig-who">{t("Watcher {n}", { n: a.watcher.n })}</span>
            <span class="sig-what">{a.lying ? t("signed a forged green") : t("signed {status}", { status: statusLabel(q.payload.status).toLowerCase() })}</span>
            {!compact && <span class="mono sig-val" title={a.att.signature}>{a.att.signature}</span>}
          </li>
        ))}
      </ul>
      <label class="switch">
        <input type="checkbox" checked={lying} onChange={(e) => setLying((e.target as HTMLInputElement).checked)} />
        <span class="switch-ui" aria-hidden="true" />
        <span>{t("Give watcher 3 a lying data source")}</span>
      </label>
      <p class="note">
        {lying && q.liar
          ? sentences(t("The contract kept {status}. The forged green had {votes} of the {needed} signatures it needs.", { status: statusLabel(q.stored ?? "unknown").toLowerCase(), votes: q.liar.votes, needed: q.liar.needed }), q.disagreement && t("The disagreement was logged on-chain."))
          : t("The contract verified {votes} signatures ({needed} needed to store {status}) and holds {stored}.", { votes: q.honest.votes, needed: q.honest.needed, status: statusLabel(q.payload.status).toLowerCase(), stored: statusLabel(q.stored ?? "unknown").toLowerCase() })}
      </p>
    </div>
  );
}

function RouteDetail({ row, snap, frames, index, scenario, lang, setLang, lying, setLying }: {
  row: RouteRow; snap: Snapshot; frames: Frame[] | null; index: number; scenario: Scenario | null; lang: Lang; setLang: (l: Lang) => void; lying: boolean; setLying: (v: boolean) => void;
}) {
  const l = routeLabel(row.route);
  const p = parseRoute(row.route);
  const facts = row.verdict ? extractFacts(row.verdict) : null;
  const text = facts ? templateBody(facts, lang) : sentences(...row.reasons.filter((x) => describeReason(x).severity !== "info").map((x) => t(describeReason(x).plain))) || t("All checks passing.");
  // One line per (check, subject), worst first.
  const comps = row.verdict ? [...row.verdict.components].filter((c, i, all) => all.findIndex((x) => x.check === c.check && x.subject === c.subject) === i).sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]) : [];
  const bridged = [p.src, p.dst].filter((a) => frames?.[index]?.assets.some((x) => x.asset === a && x.backingPpm !== null));
  const code = `await wt.isSafe("${row.route}")   // ${row.status === "green"}`;
  const safeWord = row.status === "green" ? t("Yes") : row.status === "amber" ? t("Only with care") : row.status === "unknown" ? t("No, can't verify") : t("No");
  return (
    <div class="detail">
      <header class="detail-head">
        <Pair route={row.route} size={32} />
        <div>
          <h2>{l.src} <IArrow size={16} class="arrow" /> {l.dst}</h2>
          <p>{t("{src} on {srcChain} to {dst} on {dstChain}", { src: l.src, srcChain: l.srcChain, dst: l.dst, dstChain: l.dstChain })}</p>
        </div>
        <span class="detail-score"><b>{row.score}</b><span>{t("score")}</span></span>
      </header>

      <div class={`answer s-${row.status}`}>
        <div class="answer-top">
          <StatusIcon status={row.status} size={20} />
          <h3>{t(ANSWER[row.status])}</h3>
        </div>
        <p>{text}</p>
        <p class="answer-size">
          {row.capacityUsd > 0
            ? row.status === "amber" ? tj("Safe size right now: {amount} per swap, halved while on caution.", { amount: <b>{dollars(row.capacityUsd)}</b> }) : tj("Safe size right now: {amount} per swap.", { amount: <b>{dollars(row.capacityUsd)}</b> })
            : tj("Safe size right now: {amount}. Nothing should move through this route.", { amount: <b>$0</b> })}
        </p>
        {facts && (
          <label class="lang">
            <span>{t("Language")}</span>
            <select value={lang} onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)}>
              {LANG_OPTIONS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <IChevronDown size={14} />
          </label>
        )}
      </div>

      {comps.length > 0 && (
        <section class="block">
          <h3 class="block-title">{t("Checks")}</h3>
          <ul class="checks">
            {comps.map((c) => (
              <li key={`${c.check}:${c.subject}`}>
                <StatusIcon status={c.status} size={16} />
                <div>
                  <span class="check-name">{t(CHECK_TITLES[c.check])}<span class="check-subj">{c.subject.includes("->") ? t("this route") : c.subject.includes(":") ? assetName(c.subject) : chainName(c.subject)}</span></span>
                  <span class="check-val">{checkSummary(c)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {frames && scenario && bridged.length > 0 && (
        <section class="block">
          <h3 class="block-title">{t("Backing over time")}</h3>
          <BackingChart frames={frames} index={index} assets={bridged} incidentAt={scenario.incidentAtMin} duration={scenario.durationMin} />
        </section>
      )}

      <section class="block">
        <h3 class="block-title">{t("What apps and AI agents are told")}</h3>
        <dl class={`told s-${row.status}`}>
          <div><dt>{t("Safe to use?")}</dt><dd>{safeWord}</dd></div>
          <div><dt>{t("Most per swap")}</dt><dd>{dollars(row.capacityUsd)}</dd></div>
        </dl>
        <p class="told-note">{t("An app gets this answer with one line of code before it moves any money:")}</p>
        <Code text={code} label="TypeScript" wrap>
          <span class="tk-k">await</span> wt.<span class="tk-f">isSafe</span>(<span class="tk-s">"{row.route}"</span>)   <span class="tk-c">{"// "}{String(row.status === "green")}</span>
        </Code>
      </section>

      <section class="block">
        <h3 class="block-title">{t("Proof")}</h3>
        <p class="told-note">{t("The report hash is a fingerprint of the full report the watchers signed. Anyone with the same data can recompute it, so nobody can quietly change a verdict.")}</p>
        <QuorumBlock row={row} snap={snap} lying={lying} setLying={setLying} compact />
      </section>
    </div>
  );
}

interface ActivityItem {
  t: number;
  minute: number;
  kind: "event" | "status";
  status?: Status;
  text: string;
  sub?: string;
}

function activityItems(scenario: Scenario, transitions: Transition[], index: number, lang: Lang): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const e of scenario.events) if (e.atMin <= index) items.push({ t: e.atMin - scenario.incidentAtMin, minute: e.atMin, kind: "event", text: tEvent(e.label) });
  const groups = new Map<string, { tr: Transition; routes: string[] }>();
  for (const tr of transitions) {
    if (tr.minute > index) continue;
    const key = `${tr.minute}|${tr.from}|${tr.to}|${tr.reasons[0] ?? ""}`;
    const g = groups.get(key) ?? { tr, routes: [] };
    g.routes.push(tr.route);
    groups.set(key, g);
  }
  for (const { tr, routes } of groups.values()) {
    const facts = extractFacts(tr.verdict);
    const names = routes.map((r) => { const l = routeLabel(r); return `${l.src}→${l.dst}`; });
    const n = routes.length;
    const st = statusLabel(tr.to).toLowerCase();
    const head = tr.to === "green" ? (n === 1 ? t("1 route back to safe") : t("{n} routes back to safe", { n })) : n === 1 ? t("1 route now {status}", { status: st }) : t("{n} routes now {status}", { n, status: st });
    items.push({ t: tr.t, minute: tr.minute, kind: "status", status: tr.to, text: tr.to === "green" ? head : t("{head}. {body}", { head, body: templateBody(facts, lang) }), sub: names.join(t(", ")) });
  }
  return items.sort((a, b) => b.minute - a.minute || (a.kind === "status" ? -1 : 1));
}

function Activity({ items }: { items: ActivityItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <section class="card" aria-label={t("Activity")}>
      <div class="card-head"><h2>{t("Activity")}</h2>{items.length > 5 && <button class="link-btn" onClick={() => setAll(!all)}>{all ? t("Show recent") : t("Show all {n}", { n: items.length })}</button>}</div>
      {items.length === 0 ? (
        <p class="empty">{t("Nothing has changed yet. Status changes and incident events appear here as the replay runs.")}</p>
      ) : (
        <ol class="feed">
          {shown.map((it, i) => (
            <li key={i} class={it.kind}>
              <span class="feed-t">{relShort(it.t)}</span>
              <span class="feed-dot">{it.kind === "status" ? <StatusIcon status={it.status!} size={15} /> : <i class="ev" />}</span>
              <div class="feed-body">
                <p>{it.text}</p>
                {it.sub && <span class="feed-sub">{it.sub}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Chains view
// ---------------------------------------------------------------------------------------------

const NODES: Record<string, [number, number]> = { near: [220, 158], bitcoin: [84, 56], ethereum: [356, 56], bsc: [360, 238], solana: [220, 292], litecoin: [80, 238] };
const NODE_WORD: Record<Status, string> = { green: k("Healthy"), amber: k("Caution"), unknown: k("No data"), red: k("Unsafe") };

/**
 * A live view of the network. Every swap settles on NEAR, so it is a hub: one spoke per chain.
 * Packets travel along healthy spokes; a stop sign blocks unsafe ones; a radar sweep shows the
 * watchers are looking. All motion turns off with the Motion setting.
 */
function ChainMap({ nodes, focus, onFocus }: { nodes: ChainNode[]; focus: string | null; onFocus: (c: string | null) => void }) {
  const hub = NODES.near!;
  const by = new Map(nodes.map((n) => [n.chain, n]));
  return (
    <svg class={`map${focus ? " has-focus" : ""}`} viewBox="0 0 440 340" role="img" aria-label={t("Live map of chains connected through NEAR")}>
      <defs>
        <radialGradient id="map-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity=".16" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity=".22" />
        </linearGradient>
        <filter id="lift" x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0e1622" flood-opacity=".14" />
        </filter>
        <filter id="glow-red" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>

      <g class="radar" aria-hidden="true">
        <circle cx={hub[0]} cy={hub[1]} r="150" fill="url(#map-glow)" />
        {[58, 104, 150].map((r) => <circle key={r} class="ring" cx={hub[0]} cy={hub[1]} r={r} />)}
        <g class="sweep" style={{ transformOrigin: `${hub[0]}px ${hub[1]}px` }}>
          <path d={`M${hub[0]} ${hub[1]}L${hub[0] + 150} ${hub[1]}A150 150 0 0 0 ${hub[0] + 150 * Math.cos(-Math.PI / 5)} ${hub[1] + 150 * Math.sin(-Math.PI / 5)}Z`} fill="url(#sweep)" />
        </g>
      </g>

      {nodes.filter((n) => n.chain !== "near" && NODES[n.chain]).map((n, i) => {
        const [x, y] = NODES[n.chain]!;
        const mx = (x + hub[0]) / 2, my = (y + hub[1]) / 2;
        const d = `M${x} ${y}L${hub[0]} ${hub[1]}`;
        const back = `M${hub[0]} ${hub[1]}L${x} ${y}`;
        const w = 2 + Math.min(3, n.routes.length);
        const flowing = n.status === "green" || n.status === "amber";
        return (
          <g key={n.chain} class={`spoke s-${n.status}${focus === n.chain ? " is-focus" : ""}`} style={{ "--delay": `${-i * 0.37}s` }}>
            {n.status === "red" && <path class="spoke-halo" d={d} stroke-width={w + 10} filter="url(#glow-red)" />}
            <path class="spoke-base" d={d} stroke-width={w + 5} />
            {flowing && <path class="spoke-flow" d={d} stroke-width={w + 1} />}
            {flowing && <path class="spoke-flow spoke-flow-back" d={back} stroke-width={w - 1} />}
            {n.status === "red" && (
              <g class="stop" transform={`translate(${mx} ${my})`}>
                <circle r="12" />
                <path d="M-4.5 -4.5L4.5 4.5M4.5 -4.5L-4.5 4.5" />
              </g>
            )}
            {n.status === "unknown" && (
              <g class="stop stop-unk" transform={`translate(${mx} ${my})`}>
                <circle r="12" />
                <text y="4.5" text-anchor="middle">?</text>
              </g>
            )}
          </g>
        );
      })}

      {Object.entries(NODES).map(([id, [x, y]]) => {
        const n = by.get(id);
        if (!n) return null;
        const label = chainName(id);
        const isHub = id === "near";
        // A chain whose token has a named problem says it ("BTC: Partly verified"), not just "No data".
        const word = isHub ? t("Settles every swap") : n.status !== "green" && n.what && n.what !== t("Healthy") && n.what !== t("Some routes need care") ? n.what : t(NODE_WORD[n.status]);
        const w = Math.max(96, textUnits(label) * 8.4 + 52, textUnits(word) * 6.2 + 52);
        const h = 46;
        return (
          <g key={id} class={`node s-${n.status}${isHub ? " hub" : ""}${focus === id ? " is-focus" : ""}`} transform={`translate(${x - w / 2} ${y - h / 2})`} onClick={() => onFocus(focus === id ? null : id)} role="button" tabIndex={0} aria-label={`${label}: ${t(NODE_WORD[n.status])}. ${n.what}`} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onFocus(focus === id ? null : id)}>
            {n.status === "red" && <rect class="pulse" width={w} height={h} rx="14" />}
            <rect class="node-card" width={w} height={h} rx="14" filter="url(#lift)" />
            <g transform="translate(23 23)"><TokenGlyph symbol={CHAIN_TOKEN[id] ?? id} r={12} /></g>
            <text class="node-name" x="42" y="20">{label}</text>
            <circle class="node-dot" cx="45" cy="31.5" r="3" />
            <text class="node-word" x="52" y="35">{word}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MapLegend() {
  return (
    <ul class="map-legend">
      <li><svg viewBox="0 0 40 10" aria-hidden="true"><path class="lg-flow" d="M2 5H38" /></svg>{t("Swaps can flow")}</li>
      <li><svg viewBox="0 0 22 22" aria-hidden="true" class="lg-stop"><circle cx="11" cy="11" r="9" /><path d="M7.5 7.5l7 7M14.5 7.5l-7 7" /></svg>{t("Watchtower says stop")}</li>
      <li><svg viewBox="0 0 40 10" aria-hidden="true"><path class="lg-unk" d="M2 5H38" /></svg>{t("Can't verify right now")}</li>
    </ul>
  );
}

function ChainsView({ snap }: { snap: Snapshot }) {
  const [focus, setFocus] = useState<string | null>(null);
  const nodes = chainNodes(snap);
  const rows = [...nodes].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.chain.localeCompare(b.chain));
  return (
    <div class="stack">
      <header class="page-head">
        <h1>{t("Chains")}</h1>
        <p>{t("Every swap passes through NEAR. If a chain, or a token on it, has a problem, every route that touches it is affected. Tap a chain to see its routes.")}</p>
      </header>
      <section class="card map-card">
        <ChainMap nodes={nodes} focus={focus} onFocus={setFocus} />
        <MapLegend />
      </section>
      <section class="card" aria-label={t("Chain health")}>
        <div class="ct" role="table">
          <div class="ct-row ct-headrow" role="row"><span role="columnheader">{t("Chain")}</span><span role="columnheader">{t("Status")}</span><span role="columnheader">{t("What's happening")}</span><span role="columnheader" class="num">{t("Routes")}</span></div>
          {rows.map((c) => (
            <div key={c.chain} class={`ct-row${focus === c.chain ? " is-focus" : ""}`} role="row" onClick={() => setFocus(focus === c.chain ? null : c.chain)}>
              <span role="cell" class="ct-name"><b>{chainName(c.chain)}</b><span class="rt-sub">{c.secondsSinceBlock === null ? t("Block time unknown") : t("Last block {age} ago", { age: c.secondsSinceBlock < 90 ? t("{s} s", { s: c.secondsSinceBlock }) : span(Math.round(c.secondsSinceBlock / 60)) })}</span></span>
              <span role="cell"><Badge status={c.status} /></span>
              <span role="cell" class="ct-what">{c.what}</span>
              <span role="cell" class="num">{c.routes.length}</span>
            </div>
          ))}
        </div>
      </section>
      {focus && (
        <section class="card" aria-label={t("Routes touching {chain}", { chain: chainName(focus) })}>
          <div class="card-head"><h2>{t("Routes touching {chain}", { chain: chainName(focus) })}</h2><button class="link-btn" onClick={() => setFocus(null)}>{t("Clear")}</button></div>
          <ul class="mini-routes">
            {nodes.find((n) => n.chain === focus)!.routes.map((r) => {
              const l = routeLabel(r.route);
              return <li key={r.route}><Pair route={r.route} size={22} /><span><b>{l.src} → {l.dst}</b><span class="rt-sub">{t("{a} to {b}", { a: l.srcChain, b: l.dstChain })}</span></span><Badge status={r.status} /></li>;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Watchers view
// ---------------------------------------------------------------------------------------------

const CHECKS_EXPLAINED: { title: string; body: string }[] = [
  { title: k("Backing"), body: k("Custody on the home chain divided by everything owed on NEAR: credited supply, withdrawals not yet paid, and deposits not yet credited. Unsafe below 99.5%, or below 100% and falling fast.") },
  { title: k("Deposits behind credits"), body: k("Every credit on NEAR must pair with a real deposit. Unpaired after the chain's window is unsafe. Unpaired and already being withdrawn is unsafe at once.") },
  { title: k("Withdrawal patterns"), body: k("Outflow far above the 30-day norm, a hot wallet draining, brand-new accounts withdrawing, money credited and pulled out within minutes. One signal means caution; two mean unsafe.") },
  { title: k("Solver competition"), body: k("How much of a route's last 24 hours one solver filled (Herfindahl index). Above 2,500, or one solver above 70%, means a single exit breaks the route.") },
  { title: k("Chain health"), body: k("Stalls, reorganisations, security advisories and stablecoin depegs on any chain the route touches. A route takes the worst of them.") },
  { title: k("Safe size"), body: k("The most one swap should move right now: half of what the bridge's hot wallets can pay out, or the depth solvers actually showed in the last 24 hours, whichever is smaller. Halved on caution, zero when unsafe.") },
];

function WatchersView({ snap, selected, lying, setLying }: { snap: Snapshot; selected: RouteRow; lying: boolean; setLying: (v: boolean) => void }) {
  const l = routeLabel(selected.route);
  return (
    <div class="stack">
      <header class="page-head">
        <h1>{t("Watchers")}</h1>
        <p>{t("Three independent watchers compute every verdict from the same public data and sign it. The contract only believes signatures, and it is easy to raise the alarm but hard to lower it.")}</p>
      </header>
      <section class="rules">
        <div><b>{t("1 signature")}</b><span>{t("raises the alarm. One honest watcher can always stop traffic.")}</span></div>
        <div><b>{t("2 of 3 signatures")}</b><span>{t("to recover, or to keep a route marked safe. One compromised watcher can never silence the alarm.")}</span></div>
        <div><b>{t("5 minutes")}</b><span>{t("without fresh signatures and the route reads as not safe. Silence is never mistaken for safety.")}</span></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("Signatures for {route}", { route: `${l.src} → ${l.dst}` })}</h2><Badge status={selected.status} /></div>
        <ul class="watchers">
          {WATCHERS.map((w) => (
            <li key={w.id}>
              <span class="w-icon"><IKey size={16} /></span>
              <div><b>{t("Watcher {n}", { n: w.n })}</b><span class="mono w-key">{w.key.publicKey}</span></div>
              <span class="w-id mono">{w.id}</span>
            </li>
          ))}
        </ul>
        <QuorumBlock row={selected} snap={snap} lying={lying} setLying={setLying} />
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("How each verdict is decided")}</h2></div>
        <dl class="explain">
          {CHECKS_EXPLAINED.map((c) => <div key={c.title}><dt>{t(c.title)}</dt><dd>{t(c.body)}</dd></div>)}
        </dl>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Developers view
// ---------------------------------------------------------------------------------------------

const SNIPPET_CHECK = `import { Watchtower } from "@intents-watchtower/sdk";

const wt = new Watchtower({ network: "mainnet" });

if (!(await wt.isSafe("btc:bitcoin->usdc:near"))) {
  const why = await wt.check("btc:bitcoin->usdc:near");
  return skip(why.reasons);          // fail-closed by default
}

// Size-aware: is it safe to move $50,000 right now?
const c = await wt.checkIntent("btc:bitcoin->usdc:near", 50_000);
if (!c.allowed) return split(c.capacity_usd);   // verdict "over_capacity"`;

const SNIPPET_MCP = `# Claude Code
claude mcp add watchtower -- node packages/mcp/dist/watchtower-mcp.mjs

# Claude Desktop, Cursor: mcpServers in the client's config
"watchtower": { "command": "node", "args": ["…/packages/mcp/dist/watchtower-mcp.mjs"] }

# Codex: ~/.codex/config.toml
[mcp_servers.watchtower]
command = "node"
args = ["…/packages/mcp/dist/watchtower-mcp.mjs"]`;

const SNIPPET_AGENT = `import { withWatchtower } from "@intents-watchtower/sdk";

const safeAgent = withWatchtower(agent, {
  client: wt,
  alternatives: (route) => routesInto(route),
  withRoute: (args, route) => [{ ...args[0], route }],
});

await safeAgent.swap({ route: "usdt:bsc->usdc:near", amount });
// unsafe → rerouted to the safest alternative, or RouteUnsafeError`;

const SNIPPET_RUST = `#[ext_contract(watchtower)]
trait Watchtower {
    fn is_safe(&self, route_id: String, max_age_sec: Option<u64>,
               allow_amber: Option<bool>) -> bool;
}

watchtower::ext("watchtower.near".parse().unwrap())
    .is_safe(route_id, Some(300), Some(false))
    .then(Self::ext(env::current_account_id()).swap_if_safe(...))`;

const METHODS: [string, string, string][] = [
  ["is_safe(route_id, max_age_sec?, allow_amber?)", "view", k("True only when the route is safe and fresh")],
  ["check_route(route_id, ...)", "view", k("The answer plus status, score, safe size, reasons and age")],
  ["check_intent(route_id, amount_usd, ...)", "view", k("Allowed only if safe and the amount fits the signed safe size")],
  ["safest_route(candidates, ...)", "view", k("Highest-scoring safe route, or null")],
  ["get_route_health(route_id)", "view", k("Stored verdict and report hash")],
  ["submit_report(route_id, report, attestations)", "call", k("Watcher signatures in; anyone can relay")],
  ["record_receipt(route_id, intent_hash)", "call", k("Records the route's state at swap time")],
];

interface AgentStep {
  route: string;
  safe: boolean;
  verdict: string;
  status: string | null;
  reason?: string;
  rerouted?: string | null;
}

function DevelopersView({ snap }: { snap: Snapshot }) {
  const [route, setRoute] = useState("usdt:bsc->usdc:near");
  const [steps, setSteps] = useState<AgentStep[] | null>(null);
  const [outcome, setOutcome] = useState<string>("");
  const run = async (e: Event) => {
    e.preventDefault();
    const mirror = mirrorFor(snap);
    const wt = new Watchtower({ source: { view: async (m, a) => mirror.view(m, a) as never }, cacheMs: 0 });
    const dst = parseRoute(route).dst;
    const alternatives = snap.routes.map((r) => r.route).filter((r) => r !== route && parseRoute(r).dst === dst);
    const log: AgentStep[] = [];
    const agent = { async swap(req: { route: string }) { return req.route; } };
    const guarded = withWatchtower(agent, {
      client: wt,
      alternatives: () => alternatives,
      withRoute: (args, r) => [{ ...(args[0] as object), route: r }],
      onDecision: (d) => log.push({ route: d.requested, safe: d.check.safe, verdict: d.check.verdict, status: d.check.status, reason: d.check.reasons[0], rerouted: d.check.safe ? undefined : d.used }),
    });
    try {
      const used = await guarded.swap({ route });
      const l = routeLabel(used);
      setOutcome(used === route ? t("Swapped $25,000 through {route}.", { route: `${l.src} → ${l.dst}` }) : t("Rerouted and swapped $25,000 through {route}. The unsafe route was never touched.", { route: `${l.src} (${l.srcChain}) → ${l.dst}` }));
    } catch (err) {
      setOutcome(err instanceof RouteUnsafeError ? t("Blocked. No safe route into {sym} right now, so no money moved.", { sym: dst.split(":")[0]!.toUpperCase() }) : String(err));
    }
    setSteps(log);
  };
  return (
    <div class="stack">
      <header class="page-head">
        <h1>{t("Developers")}</h1>
        <p>{t("One call before every swap. The SDK has no dependencies, fails closed when the oracle can't be reached, and wraps any agent so unsafe swaps are rerouted or blocked.")}</p>
      </header>
      <section class="card">
        <div class="card-head"><h2>{t("Try it with an agent")}</h2></div>
        <form class="agent" onSubmit={run}>
          <label for="agent-route">{t("The agent wants to swap $25,000 on")}</label>
          <div class="agent-row">
            <span class="select">
              <select id="agent-route" value={route} onChange={(e) => setRoute((e.target as HTMLSelectElement).value)}>
                {DEFAULT_ROUTES.map((r) => { const l = routeLabel(r); const st = snap.routes.find((x) => x.route === r)?.status ?? "unknown"; return <option key={r} value={r}>{l.src} → {l.dst} ({t("{a} to {b}", { a: l.srcChain, b: l.dstChain })}): {statusLabel(st)}</option>; })}
              </select>
              <IChevronDown size={16} />
            </span>
            <button class="btn btn-primary" type="submit">{t("Run agent")}</button>
          </div>
        </form>
        {steps && (
          <div class="agent-out" aria-live="polite">
            {steps.map((s, i) => (
              <div key={i} class="code code-out">
                <pre><code>
                  <span class="tk-k">await</span> wt.<span class="tk-f">check</span>(<span class="tk-s">"{s.route}"</span>){"\n"}
                  <span class="tk-c">{"// "}safe: </span><span class={s.safe ? "tk-ok" : "tk-bad"}>{String(s.safe)}</span><span class="tk-c">, verdict: {s.verdict}{s.status ? `, status: ${s.status}` : ""}{s.reason ? `, ${s.reason}` : ""}</span>
                  {!s.safe && <>{"\n"}<span class="tk-k">await</span> wt.<span class="tk-f">safestRoute</span>(alternatives){"\n"}<span class="tk-c">{"// "}{s.rerouted ? `"${s.rerouted}"` : "null"}</span></>}
                </code></pre>
              </div>
            ))}
            <p class="agent-result">{outcome}</p>
          </div>
        )}
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("Check a route")}</h2><span class="hint">TypeScript</span></div>
        <Code text={SNIPPET_CHECK}>{highlight(SNIPPET_CHECK)}</Code>
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("Give an AI agent a safety check")}</h2><span class="hint">MCP</span></div>
        <p class="card-lead">{tj("Any agent that speaks the Model Context Protocol (Claude, Codex, Cursor) gets four read-only tools: {tools}. Before it moves money it asks, and gets go, send in parts, use another route, or don't send. Build it once with {cmd}.", { tools: <><code>check_swap</code>, <code>check_route</code>, <code>list_routes</code>, <code>explain_route</code></>, cmd: <code>npm run build:mcp</code> })}</p>
        <Code text={SNIPPET_MCP}>{highlight(SNIPPET_MCP)}</Code>
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("Guard an agent")}</h2><span class="hint">TypeScript</span></div>
        <Code text={SNIPPET_AGENT}>{highlight(SNIPPET_AGENT)}</Code>
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("From a NEAR contract")}</h2><span class="hint">Rust</span></div>
        <Code text={SNIPPET_RUST}>{highlight(SNIPPET_RUST)}</Code>
      </section>
      <section class="card">
        <div class="card-head"><h2>{t("Contract methods")}</h2><span class="hint mono">{CONTRACT}</span></div>
        <div class="methods">
          {METHODS.map(([sig, kind, what]) => (
            <div key={sig}><code>{sig}</code><span class={`kind k-${kind}`}>{kind}</span><span>{t(what)}</span></div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Player and source picker
// ---------------------------------------------------------------------------------------------

/** Group events that land within a few minutes of each other into one marker. */
function eventMarks(sc: Scenario): { atMin: number; labels: string[] }[] {
  const out: { atMin: number; labels: string[] }[] = [];
  for (const e of [...sc.events].sort((x, y) => x.atMin - y.atMin)) {
    const last = out[out.length - 1];
    if (last && e.atMin - last.atMin <= 3) last.labels.push(tEvent(e.label));
    else out.push({ atMin: e.atMin, labels: [tEvent(e.label)] });
  }
  return out;
}

/**
 * The replay timeline. Colours show how safe the affected routes were each minute; the part you
 * haven't played yet stays grey so the ending isn't spoiled. While playing, the playhead and the
 * reveal glide linearly across each minute, so motion reads as continuous time, not jumps.
 */
function Timeline({ s, onSeek }: { s: ReplayState; onSeek: (i: number) => void }) {
  const total = s.scenario.durationMin;
  const pct = (m: number) => `${(m / total) * 100}%`;
  const cells = [];
  for (let m = 0; m <= total; m++) {
    const fr = s.frames[m];
    const status = fr ? worst(fr.routes.filter((x) => s.scenario.focusRoutes.includes(x.route)).map((x) => x.status)) : null;
    cells.push(<i key={m} class={status ? `s-${status}` : "pending"} />);
  }
  const step = s.playing && !motionReduced() ? Math.round(1000 / s.speed) : 0;
  const f = s.frames[s.index];
  return (
    <div class="tl" style={{ "--step": `${step}ms` }}>
      <div class="tl-flags" aria-hidden="true">
        <span class="tl-flag" style={{ left: pct(s.scenario.incidentAtMin) }}>{t("Incident")}</span>
      </div>
      <div class="tl-track">
        <div class="tl-heat" aria-hidden="true">{cells}</div>
        <div class="tl-future" style={{ left: pct(s.index) }} aria-hidden="true" />
        {eventMarks(s.scenario).map((m) => (
          <span key={m.atMin} class={`tl-mark${m.atMin <= s.index ? " is-past" : ""}${m.atMin === s.scenario.incidentAtMin ? " is-incident" : ""}`} style={{ left: pct(m.atMin) }} title={m.labels.join("\n")} aria-hidden="true" />
        ))}
        <span class="tl-head" style={{ left: pct(s.index) }} aria-hidden="true" />
        <input
          class="tl-input"
          type="range"
          min={0}
          max={total}
          value={s.index}
          aria-label={t("Replay position")}
          aria-valuetext={f ? relLong(f.t) : ""}
          onInput={(e) => onSeek(Number((e.target as HTMLInputElement).value))}
        />
      </div>
    </div>
  );
}

function Player({ r, onPick }: { r: ReturnType<typeof useReplay>; onPick: () => void }) {
  const s = r.state;
  if (!s) return null;
  const f = s.frames[s.index];
  const done = s.index >= s.scenario.durationMin && !s.playing;
  const latest = s.scenario.events.filter((e) => e.atMin <= s.index).at(-1);
  const speeds = [1, 4, 10];
  const nextSpeed = speeds[(speeds.indexOf(s.speed) + 1) % speeds.length]!;
  return (
    <div class="player" role="region" aria-label={t("Replay controls")}>
      <div class="player-in">
        <button type="button" class="play" onClick={r.toggle} aria-label={s.playing ? t("Pause") : done ? t("Replay from the start") : t("Play")} disabled={s.computed === 0}>
          {s.playing ? <IPause size={18} /> : done ? <IRestart size={18} /> : <IPlay size={18} />}
        </button>
        <div class="clock" aria-live="off">
          <b>{f ? relLong(f.t) : t("Preparing replay")}</b>
          <span>{f ? t("Replay clock {time}", { time: utc(f.asOfMs) }) : t("Computing every minute")}</span>
        </div>
        <div class="scrub">
          <Timeline s={s} onSeek={(i) => { r.pause(); r.seek(i); }} />
          <p class="player-event">
            {latest ? <><b>{relShort(latest.atMin - s.scenario.incidentAtMin)}</b> {tEvent(latest.label)}</> : t("Normal traffic. Watchers check every route every minute.")}
          </p>
        </div>
        <div class="speed seg" role="radiogroup" aria-label={t("Playback speed")}>
          {speeds.map((v) => <button key={v} type="button" role="radio" aria-checked={s.speed === v} onClick={() => r.setSpeed(v)} title={v === 1 ? t("1 replay minute per second") : t("{n} replay minutes per second", { n: v })}>{v}×</button>)}
        </div>
        <button type="button" class="speed-cycle" onClick={() => r.setSpeed(nextSpeed)} aria-label={t("Speed {a}×, tap for {b}×", { a: s.speed, b: nextSpeed })}>{s.speed}×</button>
        <button type="button" class="source-btn player-source" onClick={onPick}>
          <IHistory size={16} />
          <span>{t(SHORT[s.scenario.id] ?? s.scenario.title)}</span>
          <IChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}

const SHORT: Record<string, string> = { "oct-2026-ghost-credit": k("1 Oct ghost credits"), "apr-2026-litecoin-zero-day": k("Litecoin zero-day"), "whale-day": k("Whale withdrawal"), "stale-custody-feed": k("Silent custody feed"), "usdt-bsc-depeg": k("USDT depeg") };

function SourcePicker({ open, onClose, source, onReplay, onLive }: { open: boolean; onClose: () => void; source: Source; onReplay: (id: string) => void; onLive: (s: LiveSource) => void }) {
  const [network, setNetwork] = useState<keyof typeof LIVE_NETWORKS>("testnet");
  const [contract, setContract] = useState<string>(LIVE_NETWORKS.testnet.contractId);
  const current = SCENARIOS.find((s) => source.kind === "replay" && s.id === source.id);
  return (
    <Sheet open={open} onClose={onClose} title={t("Data source")} wide>
      <h3 class="sheet-sub">{t("Replay an incident")}</h3>
      <p class="sheet-note">{t("Simulations modelled on public reports, run through the real engine minute by minute. Same inputs, same result, every time.")}</p>
      <ul class="scenarios">
        {SCENARIOS.map((s) => (
          <li key={s.id}>
            <button type="button" class={source.kind === "replay" && source.id === s.id ? "is-current" : ""} onClick={() => onReplay(s.id)}>
              <span class="sc-text"><b>{t(s.title)}</b><span>{t(s.summary)}</span></span>
              {source.kind === "replay" && source.id === s.id ? <ICheck size={18} /> : <IChevronRight size={18} />}
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <details class="basis">
          <summary>{t("What is real in “{name}”", { name: t(SHORT[current.id] ?? current.title) })}</summary>
          <ul>
            {current.basis.facts.map((f) => <li key={f}>{t(f)}</li>)}
            {current.basis.assumptions.map((a) => <li key={a} class="assumed">{t("Modelled: {text}", { text: t(a) })}</li>)}
            {current.basis.sources.map((x) => <li key={x.url}><a href={x.url} target="_blank" rel="noopener">{x.title}</a></li>)}
          </ul>
        </details>
      )}
      <h3 class="sheet-sub">{t("Read a live contract")}</h3>
      <p class="sheet-note">{t("Live mode has no play button: the page shows the contract's current verdicts and refreshes every 20 seconds.")}</p>
      <form class="live-form" onSubmit={(e) => { e.preventDefault(); onLive({ network, contractId: contract.trim() }); }}>
        <div class="seg" role="radiogroup" aria-label={t("Network")}>
          {(["testnet", "mainnet"] as const).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={network === n} onClick={() => { setNetwork(n); setContract(LIVE_NETWORKS[n].contractId); }}>{n === "testnet" ? t("Testnet") : t("Mainnet")}</button>
          ))}
        </div>
        <label class="field">
          <span>{t("Contract account")}</span>
          <input id="live-contract" value={contract} onInput={(e) => setContract((e.target as HTMLInputElement).value)} spellcheck={false} autocomplete="off" />
        </label>
        <button class="btn btn-primary" type="submit" disabled={!contract.trim()}>{t("Connect")}</button>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------------------------

type Source = { kind: "replay"; id: string } | ({ kind: "live" } & LiveSource);

/** Set at build time with WATCHTOWER_LIVE=network:contract; the page then opens on the live contract. */
declare const __DEFAULT_LIVE__: LiveSource | null | undefined;
const DEFAULT_LIVE: LiveSource | null = typeof __DEFAULT_LIVE__ === "object" && __DEFAULT_LIVE__ ? __DEFAULT_LIVE__ : null;

function useView(): [View, (v: View) => void] {
  const read = (): View => {
    const h = location.hash.slice(1);
    return (VIEWS.some((v) => v.id === h) ? h : "routes") as View;
  };
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const on = () => setView(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (v: View) => {
    if (location.hash !== `#${v}`) location.hash = v;
    setView(v);
    scrollTo({ top: 0, behavior: motionReduced() ? "auto" : "smooth" });
  };
  return [view, go];
}

function App() {
  const prefs = usePreferences();
  const [view, setView] = useView();
  const [guide, setGuide] = useState(false);
  const [settings, setSettings] = useState(false);
  const [guideSeen, setGuideSeen] = useState(() => recall("iwt-guide-seen") === "1");
  const dismissGuide = () => { setGuideSeen(true); remember("iwt-guide-seen", "1"); };
  const narrow = useMedia("(max-width: 420px)");
  const [source, setSource] = useState<Source>(() => (DEFAULT_LIVE ? { kind: "live", ...DEFAULT_LIVE } : { kind: "replay", id: recall("iwt-scenario") ?? SCENARIOS[0]!.id }));
  const replay = useReplay(source.kind === "replay" ? source.id : null);
  const live = useLive(source.kind === "live" ? source : null);
  const [picker, setPicker] = useState(false);
  const [lang, setLangState] = useState<Lang>(() => { const l = recall("iwt-lang"); return isLang(l) ? l : "en"; });
  const setLang = (l: Lang) => { setLangState(l); remember("iwt-lang", l); };
  // Every t() call below reads the language set here, so the whole tree renders in it.
  setI18nLang(lang);
  const [lying, setLying] = useState(false);
  const [selected, setSelected] = useState<string>("usdt:bsc->usdc:near");
  const [sheet, setSheet] = useState(false);
  const wide = useMedia("(min-width: 1024px)");

  const rs = replay.state;
  const frame = source.kind === "replay" && rs ? rs.frames[rs.index] : undefined;
  const snap: Snapshot | null = useMemo(() => (source.kind === "replay" ? (frame ? snapshotFromFrame(frame, lying ? 2 : 3) : null) : live.snap), [frame, lying, source.kind, live.snap]);

  useEffect(() => {
    if (source.kind === "replay") {
      const sc = SCENARIOS.find((s) => s.id === source.id);
      if (sc) setSelected(sc.focusRoutes[0]!);
    }
  }, [source.kind === "replay" ? source.id : ""]);

  // Keyboard: space plays/pauses, arrows step the replay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (source.kind !== "replay" || sheet || picker || /INPUT|SELECT|TEXTAREA|BUTTON/.test(t.tagName)) return;
      if (e.key === " ") { e.preventDefault(); replay.toggle(); }
      if (e.key === "ArrowRight") { replay.pause(); replay.seek((rs?.index ?? 0) + 1); }
      if (e.key === "ArrowLeft") { replay.pause(); replay.seek((rs?.index ?? 0) - 1); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const row = snap?.routes.find((r) => r.route === selected) ?? snap?.routes[0];
  const history = (route: string) => (source.kind === "live" ? live.history(route) : rs ? rs.frames.slice(Math.max(0, rs.index - 60), rs.index + 1).map((f) => f.routes.find((x) => x.route === route)?.score ?? 0) : []);
  const onSelect = (r: string) => { setSelected(r); if (!wide) setSheet(true); };
  const pickReplay = (id: string) => { remember("iwt-scenario", id); setSource({ kind: "replay", id }); setPicker(false); setLying(false); };
  const pickLive = (s: LiveSource) => { setSource({ kind: "live", ...s }); setPicker(false); };

  const tryReplay = () => {
    setGuide(false);
    dismissGuide();
    setView("routes");
    if (source.kind === "replay" && source.id === SCENARIOS[0]!.id) {
      replay.seek(0);
      if (!rs?.playing) replay.toggle();
    } else pickReplay(SCENARIOS[0]!.id);
  };

  const context = source.kind === "replay" && rs && frame
    ? t("Simulated replay, {when} ({time}). Signed by {n} of 3 watchers.", { when: frame.t === 0 ? t("as the incident starts") : relLong(frame.t), time: utc(frame.asOfMs), n: lying ? 2 : 3 })
    : source.kind === "live" && snap
      ? tj("Live from {contract} on {network}. Refreshes every 20 seconds.", { contract: <span class="mono">{source.contractId}</span>, network: source.network === "testnet" ? t("Testnet") : t("Mainnet") })
      : null;

  const detail = row && snap ? <RouteDetail row={row} snap={snap} frames={rs?.frames ?? null} index={rs?.index ?? 0} scenario={rs?.scenario ?? null} lang={lang} setLang={setLang} lying={lying} setLying={setLying} /> : null;

  return (
    <div class={`app${source.kind === "replay" ? " has-player" : ""}`}>
      <header class="top">
        <div class="top-in">
          <a class="brand" href="#routes" onClick={(e) => { e.preventDefault(); setView("routes"); }}>
            <Brand compact={narrow} />
          </a>
          <nav class="tabs" aria-label={t("Sections")}>
            {VIEWS.map((v) => <a key={v.id} href={`#${v.id}`} aria-current={view === v.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView(v.id); }}>{t(v.label)}</a>)}
          </nav>
          <div class="top-actions">
            <button type="button" class="ghost-btn" onClick={() => setGuide(true)} aria-label={t("How it works")}>
              <IHelp size={18} />
              <span class="ghost-label">{t("How it works")}</span>
            </button>
            <button type="button" class={`source-btn top-source${source.kind === "live" ? " is-live" : ""}`} onClick={() => setPicker(true)}>
              {source.kind === "live" ? <IRadio size={16} /> : <IHistory size={16} />}
              <span>{source.kind === "live" ? source.contractId : wide ? t("Data source") : t(SHORT[source.id] ?? "Replay")}</span>
              <IChevronDown size={14} />
            </button>
            <button type="button" class="icon-btn top-icon" onClick={() => setSettings(true)} aria-label={t("Settings")} title={t("Settings")}>
              <IGear size={18} />
            </button>
          </div>
        </div>
      </header>

      <main class="main">
        {!snap && source.kind === "live" && live.error && (
          <section class="card error-card" role="alert">
            <h2>{t("Couldn't read {contract} on {network}", { contract: source.contractId, network: source.network === "testnet" ? t("Testnet") : t("Mainnet") })}</h2>
            <p>{live.error}</p>
            <p>{tj("Check the contract account and network. Inside an embedded preview the page may not be allowed to reach NEAR RPC; the standalone build in the repository ({file}) can.", { file: <span class="mono">apps/status/dist/standalone.html</span> })}</p>
            <div class="btn-row"><button class="btn" onClick={() => setPicker(true)}>{t("Change source")}</button><button class="btn btn-primary" onClick={() => pickReplay(SCENARIOS[0]!.id)}>{t("Back to the replay")}</button></div>
          </section>
        )}
        {!snap && !(source.kind === "live" && live.error) && <Skeleton />}
        {snap && view === "routes" && (
          <div class="stack">
            {!guideSeen && (
              <div class="intro" role="note">
                <IHelp size={20} />
                <p><b>{t("New to Watchtower?")}</b> {t("It checks whether money moving through NEAR Intents is really backed, and warns apps before they use a broken route.")}</p>
                <div class="intro-actions">
                  <button type="button" class="btn btn-primary" onClick={() => setGuide(true)}>{t("How it works")}</button>
                  <button type="button" class="icon-btn" onClick={dismissGuide} aria-label={t("Dismiss")}><IClose size={16} /></button>
                </div>
              </div>
            )}
            <Verdict snap={snap} context={context} />
            <SwapCheck snap={snap} lang={lang} onDevelopers={() => setView("developers")} />
            <div class={`split${wide ? "" : " single"}`}>
              <div class="stack">
                <RouteTable snap={snap} history={history} selected={row?.route ?? ""} onSelect={onSelect} />
                {rs && <Activity items={activityItems(rs.scenario, rs.transitions, rs.index, lang)} />}
              </div>
              {wide && <aside class="card detail-card" aria-label="Route detail">{detail}</aside>}
            </div>
          </div>
        )}
        {snap && view === "chains" && <ChainsView snap={snap} />}
        {snap && view === "watchers" && row && <WatchersView snap={snap} selected={row} lying={lying} setLying={setLying} />}
        {snap && view === "developers" && <DevelopersView snap={snap} />}
        <footer class="foot">
          <span>{t("Intents Watchtower is open source. The engine, contract rules, watcher signatures and SDK on this page are the production code; replay market data is simulated.")}</span>
          <a href="https://docs.near-intents.org/integration/verifier-contract/events" target="_blank" rel="noopener">{t("NEAR Intents docs")}</a>
        </footer>
      </main>

      {source.kind === "replay" && <Player r={replay} onPick={() => setPicker(true)} />}

      <nav class="tabbar" aria-label={t("Sections")}>
        {VIEWS.map((v) => (
          <a key={v.id} href={`#${v.id}`} aria-current={view === v.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView(v.id); }}>
            <v.Icon size={20} />
            <span>{t(v.label)}</span>
          </a>
        ))}
      </nav>

      {!wide && row && <Sheet open={sheet} onClose={() => setSheet(false)} title={t("Route detail")}>{detail}</Sheet>}
      <SourcePicker open={picker} onClose={() => setPicker(false)} source={source} onReplay={pickReplay} onLive={pickLive} />
      <Sheet open={guide} onClose={() => { setGuide(false); dismissGuide(); }} title={t("How Watchtower works")} wide>
        <HowItWorks onTry={tryReplay} />
      </Sheet>
      <Sheet open={settings} onClose={() => setSettings(false)} title={t("Settings")} wide>
        <SettingsPanel theme={prefs.theme} setTheme={prefs.setTheme} motion={prefs.motion} setMotion={prefs.setMotion} lang={lang} setLang={setLang} />
      </Sheet>
    </div>
  );
}

function Skeleton() {
  return (
    <div class="stack" aria-busy="true" aria-label={t("Loading")}>
      <div class="skel skel-hero" />
      <div class="skel skel-table" />
    </div>
  );
}

render(<App />, document.getElementById("app")!);

void reasonCode;
