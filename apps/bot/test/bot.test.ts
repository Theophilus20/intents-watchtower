import { describe, expect, it, vi } from "vitest";
import { formatTelegram, formatXPost, sendTelegram, type BotAlert } from "@watchtower/bot";

const alert: BotAlert = {
  route: "usdt:bsc->usdc:near", from: "amber", to: "red", reasons: ["GHOST_CREDIT_WITHDRAWN:usdt:bsc"],
  texts: { en: "🔴 USDT (BNB Chain) → USDC (NEAR) paused. <x>", fr: "🔴 Route USDT suspendue." },
  evidence: ["9xT"], reportHash: "ab".repeat(32), atMs: 0,
};

describe("bot", () => {
  it("formats escaped HTML with evidence links", () => {
    const t = formatTelegram(alert, { explorerTxUrl: "https://nearblocks.io/txns/", statusPageUrl: "https://example.org" });
    expect(t).toContain("&lt;x&gt;");
    expect(t).toContain('<a href="https://nearblocks.io/txns/9xT">tx1</a>');
    expect(t).toContain("<i>🔴 Route USDT suspendue.</i>");
  });
  it("keeps X posts within 280 chars", () => {
    expect(formatXPost({ ...alert, texts: { en: "x".repeat(400) } }, "https://s").length).toBeLessThanOrEqual(280);
  });
  it("calls the Telegram Bot API", async () => {
    const f = vi.fn(async () => new Response("{}"));
    await sendTelegram(alert, { token: "T", chatId: "C", fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledWith("https://api.telegram.org/botT/sendMessage", expect.objectContaining({ method: "POST" }));
  });
});
