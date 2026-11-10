import type { Status } from "@watchtower/core";
import { ICare, IChains, IPulse, ISafe, IScale, IShield, IUnknown, IUnsafe, IUsers } from "./icons.tsx";
import { Token } from "./brand.tsx";
import { k, t, tj } from "./i18n.ts";

const MEANINGS: { status: Status; Icon: typeof ISafe; title: string; body: string }[] = [
  { status: "green", Icon: ISafe, title: k("Safe"), body: k("Every check passes. Apps and agents can route money here.") },
  { status: "amber", Icon: ICare, title: k("Caution"), body: k("Something is unusual but the money is still backed. Fine for small amounts; large swaps should wait.") },
  { status: "unknown", Icon: IUnknown, title: k("Unverified"), body: k("Watchtower can't see enough data to vouch for this route right now, so it is treated as not safe.") },
  { status: "red", Icon: IUnsafe, title: k("Unsafe"), body: k("Real risk detected, such as tokens with nothing behind them. Don't route through here.") },
];

const CHECKS: { Icon: typeof ISafe; q: string; a: string }[] = [
  { Icon: IScale, q: k("Is every token on NEAR backed by real coins?"), a: k("We compare what the bridge holds on the home chain with what it has handed out on NEAR.") },
  { Icon: IShield, q: k("Did every new token come from a real deposit?"), a: k("Each credit on NEAR must match a deposit on its home chain. A credit with nothing behind it is the October exploit pattern.") },
  { Icon: IPulse, q: k("Is money leaving in a strange way?"), a: k("Sudden withdrawals far above normal, a draining hot wallet, or brand-new accounts cashing out.") },
  { Icon: IUsers, q: k("Are enough traders competing on this route?"), a: k("If one trader fills almost every swap, the route breaks the moment they leave.") },
  { Icon: IChains, q: k("Are the blockchains it depends on healthy?"), a: k("A stalled chain, a security alert or a stablecoin losing its $1 price affects every route that touches it.") },
];

export function StatusLegend() {
  return (
    <ul class="meanings">
      {MEANINGS.map(({ status, Icon, title, body }) => (
        <li key={status} class={`s-${status}`}>
          <span class="sicon"><Icon size={20} /></span>
          <div><b>{t(title)}</b><span>{t(body)}</span></div>
        </li>
      ))}
    </ul>
  );
}

/** The plain-language walkthrough. Steps are a real sequence, so they are numbered. */
export function HowItWorks({ onTry }: { onTry: () => void }) {
  return (
    <div class="guide">
      <p class="guide-lead">{t("Watchtower is a safety check for NEAR Intents. Before an app or AI agent moves money across blockchains, it asks Watchtower: is this route safe right now, and how much can it carry?")}</p>
      <ol class="steps">
        <li>
          <span class="step-n">1</span>
          <div>
            <h3>{t("You swap between blockchains")}</h3>
            <p>{t("When you send Bitcoin into NEAR Intents, the bridge keeps your Bitcoin and gives you a matching token on NEAR. That token is only worth something if the real Bitcoin is still there.")}</p>
            <div class="flow-demo" aria-hidden="true">
              <span class="fd-node"><Token symbol="btc" size={22} />Bitcoin</span>
              <svg viewBox="0 0 80 12" class="fd-line"><path d="M2 6H78" /></svg>
              <span class="fd-node fd-hub">NEAR</span>
              <svg viewBox="0 0 80 12" class="fd-line"><path d="M2 6H78" /></svg>
              <span class="fd-node"><Token symbol="usdc" size={22} />USDC</span>
            </div>
          </div>
        </li>
        <li>
          <span class="step-n">2</span>
          <div>
            <h3>{t("Watchtower checks every route, every minute")}</h3>
            <ul class="qa">
              {CHECKS.map(({ Icon, q, a }) => (
                <li key={q}><span class="qa-icon"><Icon size={17} /></span><div><b>{t(q)}</b><span>{t(a)}</span></div></li>
              ))}
            </ul>
          </div>
        </li>
        <li>
          <span class="step-n">3</span>
          <div>
            <h3>{t("Independent watchers sign the answer")}</h3>
            <p>{t("Three separate watchers work out the same answer and sign it. One signature is enough to raise the alarm. Two are needed to call a route safe again, so a single bad actor can never hide a problem.")}</p>
          </div>
        </li>
        <li>
          <span class="step-n">4</span>
          <div>
            <h3>{t("You, your app or your AI agent ask before every swap")}</h3>
            <p>{tj("Tell “Check a swap” what you send, what you receive and how much. You get one of four answers: go ahead, send it in parts, use another route, or don't send now. Watchers also sign a {size} for every route: the most it can carry right now. Apps get the same answer on-chain with {fn}, and AI agents through the Watchtower MCP server.", { size: <b>{t("safe size")}</b>, fn: <code>check_intent(route, amount)</code> })}</p>
          </div>
        </li>
      </ol>
      <h3 class="guide-sub">{t("What the colours mean")}</h3>
      <StatusLegend />
      <div class="guide-cta">
        <button type="button" class="btn btn-primary" onClick={onTry}>{t("Watch a replay")}</button>
        <span>{t("Play back the 1 October incident and see each route change colour as it happens.")}</span>
      </div>
    </div>
  );
}
