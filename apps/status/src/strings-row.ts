/** Translation rows: r(zh, ja, ko, es, fr, pt, de, ru, tr, vi). test/i18n.test.ts checks every row is complete. */
export type Locale = "zh" | "ja" | "ko" | "es" | "fr" | "pt" | "de" | "ru" | "tr" | "vi";
export const ROW_ORDER: Locale[] = ["zh", "ja", "ko", "es", "fr", "pt", "de", "ru", "tr", "vi"];
export type Row = Partial<Record<Locale, string>>;

export function r(...values: string[]): Row {
  const row: Row = {};
  ROW_ORDER.forEach((l, i) => {
    if (values[i] !== undefined) row[l] = values[i];
  });
  return row;
}
