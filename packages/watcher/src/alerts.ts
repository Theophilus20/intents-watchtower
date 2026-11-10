import type { RouteVerdict, Status } from "@watchtower/core";
import { STATUS_RANK } from "@watchtower/core";
import { explain, type AiOptions, type Lang } from "@watchtower/explainer";

export interface Alert {
  route: string;
  from: Status | null;
  to: Status;
  reasons: string[];
  texts: Partial<Record<Lang, string>>;
  source: "near-ai" | "template";
  evidence: string[];
  reportHash: string;
  atMs: number;
}

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

/**
 * Turns status transitions into alerts. Escalations always alert; recoveries alert once when a
 * route is back to green. Repeats of the same status inside the cooldown are suppressed.
 */
export class AlertManager {
  private last = new Map<string, { status: Status; atMs: number }>();
  constructor(readonly sinks: AlertSink[], readonly opts: { langs?: Lang[]; ai?: AiOptions; cooldownMs?: number } = {}) {}

  async onVerdict(v: RouteVerdict, atMs: number): Promise<Alert | null> {
    const prev = this.last.get(v.route);
    this.last.set(v.route, { status: v.status, atMs });
    if (!prev) return null; // first sight: baseline, not news
    if (prev.status === v.status) return null;
    const escalation = STATUS_RANK[v.status] > STATUS_RANK[prev.status];
    const recovered = v.status === "green";
    if (!escalation && !recovered) return null;
    if (!escalation && atMs - prev.atMs < (this.opts.cooldownMs ?? 0)) return null;
    const langs = this.opts.langs ?? ["en"];
    const texts: Alert["texts"] = {};
    let source: Alert["source"] = "template";
    let evidence: string[] = [];
    for (const lang of langs) {
      const e = await explain(v, lang, this.opts.ai);
      texts[lang] = e.text;
      if (e.source === "near-ai") source = "near-ai";
      evidence = e.facts.evidence;
    }
    const alert: Alert = { route: v.route, from: prev.status, to: v.status, reasons: v.reasons, texts, source, evidence, reportHash: v.reportHash, atMs };
    await Promise.all(this.sinks.map((s) => s.send(alert).catch(() => undefined)));
    return alert;
  }
}

export class ConsoleSink implements AlertSink {
  async send(a: Alert): Promise<void> {
    for (const [lang, text] of Object.entries(a.texts)) console.log(`[alert:${lang}] ${text}`);
  }
}
