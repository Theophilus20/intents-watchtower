import type { JSX } from "preact";

type P = { size?: number; class?: string; title?: string };
const base = (size = 16, cls = "") => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round" as const, "stroke-linejoin": "round" as const, class: `ic ${cls}`, "aria-hidden": "true" as const });
const make = (children: JSX.Element) => ({ size, class: cls }: P) => <svg {...base(size, cls)}>{children}</svg>;

export const ISafe = make(<><circle cx="12" cy="12" r="9.5" /><path d="m8.5 12.2 2.4 2.4 4.6-4.9" /></>);
export const ICare = make(<><path d="M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20.3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4" /><path d="M12 17h.01" /></>);
export const IUnsafe = make(<><path d="M8.7 2.5h6.6l4.7 4.7v6.6l-4.7 4.7H8.7L4 13.8V7.2Z" transform="translate(0 1.5)" /><path d="m14.6 9.9-5.2 5.2" /><path d="m9.4 9.9 5.2 5.2" /></>);
export const IUnknown = make(<><circle cx="12" cy="12" r="9.5" stroke-dasharray="3.2 2.6" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" /></>);
export const IPlay = ({ size = 18 }: P) => <svg {...base(size)} fill="currentColor" stroke="none"><path d="M7 4.6v14.8a1 1 0 0 0 1.5.9l12-7.4a1 1 0 0 0 0-1.8l-12-7.4A1 1 0 0 0 7 4.6Z" /></svg>;
export const IPause = ({ size = 18 }: P) => <svg {...base(size)} fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1.2" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" /></svg>;
export const IRestart = make(<><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /></>);
export const IChevronRight = make(<path d="m9 6 6 6-6 6" />);
export const IChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IClose = make(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const ICopy = make(<><rect x="8.5" y="8.5" width="12" height="12" rx="2.2" /><path d="M15.5 8.5V5.7a2.2 2.2 0 0 0-2.2-2.2H5.7a2.2 2.2 0 0 0-2.2 2.2v7.6a2.2 2.2 0 0 0 2.2 2.2h2.8" /></>);
export const ICheck = make(<path d="M20 6 9 17l-5-5" />);
export const IRoutes = make(<><circle cx="6" cy="18.5" r="2.5" /><path d="M8.5 18.5h8a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7h8" /><circle cx="18" cy="4.5" r="2.5" /></>);
export const IChains = make(<><rect x="3" y="3" width="7" height="7" rx="1.6" /><rect x="14" y="14" width="7" height="7" rx="1.6" /><path d="M10 6.5h4a3.5 3.5 0 0 1 3.5 3.5v4" /><path d="M14 17.5h-4A3.5 3.5 0 0 1 6.5 14v-4" /></>);
export const IShield = make(<><path d="M12 2.8 4.5 5.6v6.1c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V5.6Z" /><path d="m8.8 12 2.2 2.2 4.3-4.4" /></>);
export const ICode = make(<><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>);
export const IHistory = make(<><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /><path d="M12 7.5V12l3 1.8" /></>);
export const IRadio = make(<><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="M7.8 16.2a6 6 0 0 1 0-8.4" /><path d="M19 5a10 10 0 0 1 0 14" /><path d="M5 19A10 10 0 0 1 5 5" /></>);
export const IKey = make(<><circle cx="7.5" cy="15.5" r="4" /><path d="m10.5 12.5 9-9" /><path d="m17 6 2.5 2.5" /><path d="m14.5 8.5 2 2" /></>);
export const IArrow = make(<><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>);
export const IBolt = make(<path d="M13 2.5 4.5 13.5h6.5L10 21.5l8.5-11H12Z" />);

export function Mark({ size = 22 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" class="mark">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--ink)" />
      <path d="M12.2 25.5 14 13.4h4l1.8 12.1" stroke="var(--surface)" stroke-width="2" stroke-linejoin="round" />
      <path d="M11 13.4h10l-1.6-3.8h-6.8Z" fill="var(--surface)" />
      <path d="M16 5.6v2.3" stroke="var(--surface)" stroke-width="2" stroke-linecap="round" />
      <path d="M8.3 8.6 6.6 7.6M23.7 8.6l1.7-1M8 12.4H6M24 12.4h2" stroke="var(--signal)" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}
export const IGear = make(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>);
export const IHelp = make(<><circle cx="12" cy="12" r="9.5" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" /><path d="M12 17h.01" /></>);
export const ISun = make(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></>);
export const IMoon = make(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />);
export const IMonitor = make(<><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>);
export const IScale = make(<><path d="M12 3v18" /><path d="M5 7h14" /><path d="m5 7-3 7a3.5 3.5 0 0 0 6 0Z" /><path d="m19 7-3 7a3.5 3.5 0 0 0 6 0Z" /><path d="M8 21h8" /></>);
export const ILink = make(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>);
export const IPulse = make(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />);
export const IUsers = make(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>);
export const ISplit = make(<><path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M12 22v-8.3a4 4 0 0 0-1.2-2.9L3 3" /><path d="m15 9 6-6" /></>);
export const IClock = make(<><circle cx="12" cy="12" r="9.5" /><path d="M12 7v5l3 2" /></>);
