import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/** Boots the built app in a DOM and drives it the way a person on a phone would. */
describe("status app", () => {
  // execSync goes through the shell, so "npx" resolves to npx.cmd on Windows too.
  execSync("npx tsx apps/status/build.ts", { stdio: "pipe" });
  const html = readFileSync("apps/status/dist/standalone.html", "utf8");

  it("replays the October incident, explains a red route, proves the quorum and runs the agent", async () => {
    const errors: string[] = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: "https://example.org/#routes",
      beforeParse(w) {
        // Browser globals jsdom leaves out; every real browser has them.
        Object.assign(w, { TextEncoder, TextDecoder, structuredClone, crypto: globalThis.crypto, scrollTo: () => {} });
      },
    });
    dom.window.addEventListener("error", (e) => errors.push(String(e.message)));
    const doc = dom.window.document;
    const $ = (s: string) => doc.querySelector(s) as HTMLElement | null;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async (cond: () => boolean, ms = 30_000) => {
      for (let t = 0; t < ms && !cond(); t += 50) await wait(50);
    };

    await until(() => doc.querySelectorAll(".rt-item").length === 12 && !!$(".play:not([disabled])"));
    expect(errors).toEqual([]);
    expect(doc.querySelectorAll(".rt-item")).toHaveLength(12);
    expect($(".verdict h1")!.textContent).toMatch(/routes are safe|safe to use/);
    // Before the incident, $50,000 of USDT on BNB Chain into USDC on NEAR is fine.
    expect($(".sw-answer h3")!.textContent).toBe("Go ahead");

    // Seek to five minutes after the incident.
    await until(() => doc.querySelectorAll(".heat i").length === 121 && doc.querySelectorAll(".heat i.pending").length === 0);
    const scrub = $(".tl-input") as HTMLInputElement;
    scrub.value = "35";
    scrub.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await wait(50);
    expect($(".clock b")!.textContent).toBe("5 min after the incident");
    expect($(".tl-future")!.getAttribute("style")).toContain("left: 29.1");
    expect(doc.querySelectorAll(".rt-item.s-red").length).toBeGreaterThanOrEqual(3);
    expect($(".verdict h1")!.textContent).toMatch(/3 routes are unsafe right now/);
    expect($(".verdict-body")!.textContent).toMatch(/no matching deposit/);

    // The same swap now gets rerouted; following the suggestion gives a go.
    expect($(".sw-answer h3")!.textContent).toBe("Use another route");
    expect($(".sw-answer")!.textContent).toMatch(/\$0, route blocked/);
    expect($(".sw-alt")!.textContent).toMatch(/Safe, carries up to/);
    ($(".sw-alt .btn") as HTMLButtonElement).click();
    await until(() => ($("#sw-from") as HTMLSelectElement | null)?.value !== "usdt:bsc", 5_000);
    expect(($("#sw-from") as HTMLSelectElement).value).not.toBe("usdt:bsc");
    expect($(".sw-answer h3")!.textContent).toBe("Go ahead");
    // Too big for any route into USDC: send it in parts.
    const amt = $("#sw-amount") as HTMLInputElement;
    amt.value = "900,000";
    amt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await until(() => $(".sw-answer h3")?.textContent === "Send it in parts", 5_000);
    expect($(".sw-answer h3")!.textContent).toBe("Send it in parts");
    expect($(".sw-answer p")!.textContent).toMatch(/Send \d+ swaps of about/);
    expect(doc.querySelector(".rt-item.s-red .col-size")!.textContent).toBe("Blocked");

    // Open the first red route: the sheet explains it and shows three verified signatures.
    ($(".rt-item.s-red") as HTMLButtonElement).click();
    await until(() => !!$(".sheet .answer h3"), 5_000);
    expect($(".sheet .answer h3")!.textContent).toBe("Don't route through here");
    expect(doc.querySelectorAll(".sheet .sigs li")).toHaveLength(3);
    expect($(".sheet .proof .note")!.textContent).toMatch(/holds unsafe/);

    // A lying watcher cannot flip it.
    const liar = doc.querySelector(".sheet .switch input") as HTMLInputElement;
    liar.click();
    await until(() => /kept unsafe/.test($(".sheet .proof .note")?.textContent ?? ""), 5_000);
    expect($(".sheet .proof .note")!.textContent).toMatch(/kept unsafe/);
    expect($(".sheet .is-liar")).not.toBeNull();

    // French explanation.
    const sel = doc.querySelector(".sheet .lang select") as HTMLSelectElement;
    sel.value = "fr";
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await until(() => doc.documentElement.lang === "fr" && /Évitez/.test($(".sheet .answer p")?.textContent ?? ""), 5_000);
    expect($(".sheet .answer p")!.textContent).toMatch(/Évitez cette route/);
    // The whole interface follows the language, not only the explanation.
    expect(doc.documentElement.lang).toBe("fr");
    expect($(".sheet .answer h3")!.textContent).toBe("N'empruntez pas cette route");
    expect($("#swap-title")!.textContent).toBe("Vérifiez un échange avant de l'envoyer");
    expect($(".sheet .told dt")!.textContent).toBe("Sûre à utiliser ?");
    const back = doc.querySelector(".sheet .lang select") as HTMLSelectElement;
    back.value = "en";
    back.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await until(() => $("#swap-title")?.textContent === "Check a swap before you send it", 5_000);
    expect($("#swap-title")!.textContent).toBe("Check a swap before you send it");

    // Close the sheet with Escape.
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    await wait(50);
    expect($(".sheet")).toBeNull();

    // The agent reroutes away from the red route.
    dom.window.location.hash = "developers";
    await until(() => !!$(".agent"));
    $(".agent")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => !!$(".agent-result"));
    expect($(".agent-out")!.textContent).toMatch(/safe: false/);
    expect($(".agent-result")!.textContent).toMatch(/Rerouted|Blocked/);

    // Chains: hub map with a stop sign on BNB Chain, and a plain "what's happening" line.
    dom.window.location.hash = "chains";
    await until(() => !!$(".map"));
    expect(doc.querySelectorAll(".ct-row").length).toBeGreaterThan(5);
    expect(doc.querySelector(".spoke.s-red .stop")).not.toBeNull();
    expect(doc.querySelector(".ct-row.ct-headrow + .ct-row .ct-what")!.textContent).toMatch(/USDT: unbacked credit/i);

    // How it works and settings (light/dark switch).
    ($(".ghost-btn") as HTMLButtonElement).click();
    await wait(50);
    expect(doc.querySelectorAll(".steps > li")).toHaveLength(4);
    expect(doc.querySelectorAll(".meanings li")).toHaveLength(4);
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    await wait(50);
    ($(".top-icon") as HTMLButtonElement).click();
    await wait(50);
    ([...doc.querySelectorAll(".choice")][1] as HTMLButtonElement).click();
    await until(() => doc.documentElement.getAttribute("data-theme") === "dark", 5_000);
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    ([...doc.querySelectorAll(".choice")][0] as HTMLButtonElement).click();
    await until(() => doc.documentElement.getAttribute("data-theme") === "light", 5_000);
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
    // Language grid: Chinese translates the navigation and the headline, then back to English.
    ($('.lang-grid button[lang="zh-CN"]') as HTMLButtonElement).click();
    await until(() => doc.documentElement.lang === "zh-CN" && $(".tabs a")?.textContent === "路线", 5_000);
    expect(doc.documentElement.lang).toBe("zh-CN");
    expect([...doc.querySelectorAll(".tabs a")].map((x) => x.textContent)).toEqual(["路线", "链", "观察节点", "开发者"]);
    ($('.lang-grid button[lang="en"]') as HTMLButtonElement).click();
    await until(() => $(".tabs a")?.textContent === "Routes", 5_000);
    expect($(".tabs a")!.textContent).toBe("Routes");
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    await wait(50);
    dom.window.location.hash = "watchers";
    await until(() => !!$(".rules"));
    expect(doc.querySelectorAll(".watchers li")).toHaveLength(3);

    expect(errors).toEqual([]);
    dom.window.close();
  }, 120_000);
});
