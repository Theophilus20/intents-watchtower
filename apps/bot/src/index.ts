/**
 * Alert delivery: Telegram (Bot API sendMessage) and an X-ready post formatter.
 * Status decisions never happen here; this app only formats and delivers signed verdicts.
 */
export interface BotAlert {
  route: string;
  from: string | null;
  to: string;
  reasons: string[];
  texts: Record<string, string | undefined>;
  evidence: string[];
  reportHash: string;
  atMs: number;
}

export interface TelegramOptions {
  token: string;
  chatId: string;
  /** Link base for evidence, e.g. "https://nearblocks.io/txns/" */
  explorerTxUrl?: string;
  statusPageUrl?: string;
  fetch?: typeof fetch;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function formatTelegram(a: BotAlert, opts: Pick<TelegramOptions, "explorerTxUrl" | "statusPageUrl"> = {}): string {
  const lines: string[] = [];
  const order = ["en", "zh", "ja", "ko", "es", "fr", "pt", "de", "ru", "tr", "vi"];
  for (const lang of order) {
    const t = a.texts[lang];
    if (t) lines.push(lang === "en" ? `<b>${esc(t)}</b>` : `<i>${esc(t)}</i>`);
  }
  lines.push("");
  lines.push(`<code>${esc(a.route)}</code>  ${a.from ?? "—"} → <b>${a.to}</b>`);
  if (a.reasons.length) lines.push(`Reasons: <code>${esc(a.reasons.slice(0, 4).join(", "))}</code>`);
  if (a.evidence.length && opts.explorerTxUrl) lines.push(`Evidence: ${a.evidence.slice(0, 3).map((e, i) => `<a href="${opts.explorerTxUrl}${encodeURIComponent(e)}">tx${i + 1}</a>`).join(" · ")}`);
  lines.push(`Report <code>${a.reportHash.slice(0, 16)}…</code>${opts.statusPageUrl ? ` · <a href="${opts.statusPageUrl}">status page</a>` : ""}`);
  return lines.join("\n");
}

export async function sendTelegram(a: BotAlert, opts: TelegramOptions): Promise<void> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await f(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: opts.chatId, text: formatTelegram(a, opts), parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

/** <= 280 chars, English line + route + tag. Posting needs the X API (OAuth 1.0a); this formats only. */
export function formatXPost(a: BotAlert, statusPageUrl?: string): string {
  const base = a.texts.en ?? `${a.route} is ${a.to}`;
  const tail = `\n#NEARIntents ${statusPageUrl ?? ""}`.trimEnd();
  const room = 280 - tail.length;
  return (base.length > room ? `${base.slice(0, room - 1)}…` : base) + tail;
}

/** An AlertSink for the watcher's AlertManager. */
export function telegramSink(opts: TelegramOptions) {
  return { send: (a: BotAlert) => sendTelegram(a, opts) };
}
