import { useEffect, useState } from "preact/hooks";
import type { Lang } from "@watchtower/explainer";
import { IMonitor, IMoon, ISun } from "./icons.tsx";
import { LANG_OPTIONS, t } from "./i18n.ts";

export type Theme = "system" | "light" | "dark";
export type Motion = "full" | "reduced";

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked: the setting lasts for this visit */
  }
}

const systemReduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Appearance and motion preferences, applied to <html> so every component and the CSS see them. */
export function usePreferences() {
  const [theme, setThemeState] = useState<Theme>(() => (read("iwt-theme") as Theme) || "system");
  const [motion, setMotionState] = useState<Motion>(() => (read("iwt-motion") as Motion) || (systemReduced() ? "reduced" : "full"));
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", motion === "reduced");
  }, [motion]);
  return {
    theme,
    motion,
    setTheme: (t: Theme) => { setThemeState(t); write("iwt-theme", t); },
    setMotion: (m: Motion) => { setMotionState(m); write("iwt-motion", m); },
  };
}

export function motionReduced(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("reduce-motion");
}


export function SettingsPanel(props: { theme: Theme; setTheme: (t: Theme) => void; motion: Motion; setMotion: (m: Motion) => void; lang: Lang; setLang: (l: Lang) => void }) {
  const themes: { id: Theme; label: string; Icon: typeof ISun }[] = [
    { id: "light", label: t("Light"), Icon: ISun },
    { id: "dark", label: t("Dark"), Icon: IMoon },
    { id: "system", label: t("Match device"), Icon: IMonitor },
  ];
  return (
    <div class="settings">
      <fieldset>
        <legend>{t("Appearance")}</legend>
        <div class="choice-grid" role="radiogroup" aria-label={t("Appearance")}>
          {themes.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={props.theme === id} class="choice" onClick={() => props.setTheme(id)}>
              <span class={`swatch sw-${id}`} aria-hidden="true"><Icon size={18} /></span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("Language")}</legend>
        <p class="settings-help">{t("The whole page, explanations and alerts.")}</p>
        <div class="lang-grid" role="radiogroup" aria-label={t("Language")}>
          {LANG_OPTIONS.map((l) => <button key={l.id} type="button" role="radio" lang={l.html} aria-checked={props.lang === l.id} onClick={() => props.setLang(l.id)}>{l.label}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("Motion")}</legend>
        <p class="settings-help">{t("Moving dots on the map, the gliding timeline and row animations.")}</p>
        <div class="seg seg-wide" role="radiogroup" aria-label={t("Motion")}>
          <button type="button" role="radio" aria-checked={props.motion === "full"} onClick={() => props.setMotion("full")}>{t("Animated")}</button>
          <button type="button" role="radio" aria-checked={props.motion === "reduced"} onClick={() => props.setMotion("reduced")}>{t("Reduced")}</button>
        </div>
      </fieldset>
    </div>
  );
}
