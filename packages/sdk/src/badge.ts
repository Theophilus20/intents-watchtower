/**
 * <watchtower-badge route="eth:ethereum->usdc:near"></watchtower-badge>
 *
 * Attributes: route (required), network ("mainnet" | "testnet"), contract, rpc, allow-amber, refresh (seconds).
 * Renders "● Safe · score 100 · 1 min ago" in a shadow root; fail-closed on errors.
 */
import { Watchtower, type SafetyCheck } from "./index.ts";

const COLORS: Record<string, string> = { green: "#1a7f37", amber: "#9a6700", unknown: "#57606a", red: "#cf222e" };
const LABEL: Record<string, string> = { green: "Safe", amber: "Caution", unknown: "Unverified", red: "Unsafe" };

export class WatchtowerBadge extends HTMLElement {
  static observedAttributes = ["route", "network", "contract", "rpc", "allow-amber"];
  private timer?: ReturnType<typeof setInterval>;
  private root = this.attachShadow({ mode: "open" });

  connectedCallback(): void {
    void this.refresh();
    const every = Number(this.getAttribute("refresh") ?? 30) * 1000;
    this.timer = setInterval(() => void this.refresh(), Math.max(10_000, every));
  }

  disconnectedCallback(): void {
    if (this.timer) clearInterval(this.timer);
  }

  attributeChangedCallback(): void {
    if (this.isConnected) void this.refresh();
  }

  private async refresh(): Promise<void> {
    const route = this.getAttribute("route");
    if (!route) return;
    const wt = new Watchtower({
      network: (this.getAttribute("network") as "mainnet" | "testnet") ?? "mainnet",
      contractId: this.getAttribute("contract") ?? undefined,
      rpcUrl: this.getAttribute("rpc") ?? undefined,
    });
    this.render(await wt.check(route, { allowAmber: this.hasAttribute("allow-amber") }));
  }

  private render(c: SafetyCheck): void {
    const status = c.status ?? "unknown";
    const color = COLORS[status] ?? COLORS.unknown;
    const age = c.age_sec == null ? "" : c.age_sec < 90 ? " · just now" : ` · ${Math.round(c.age_sec / 60)} min ago`;
    const title = c.reasons.join("\n") || "All checks passing";
    this.root.innerHTML = `<style>:host{display:inline-flex;font:500 12px/1.2 system-ui,sans-serif}span{display:inline-flex;gap:6px;align-items:center;padding:4px 8px;border-radius:999px;border:1px solid ${color}40;color:${color};background:${color}10}i{width:8px;height:8px;border-radius:50%;background:${color}}</style><span title="${escapeHtml(title)}"><i></i>${c.safe ? LABEL.green : LABEL[status] ?? "Unverified"}${c.score != null ? ` · ${c.score}` : ""}${age}</span>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

if (typeof customElements !== "undefined" && !customElements.get("watchtower-badge")) customElements.define("watchtower-badge", WatchtowerBadge);
