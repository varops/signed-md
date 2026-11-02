/**
 * Contract font families. Accounts pick a default; each document can override it.
 * Change the faces here: the PDF uses `pdf` (bundled fonts in assets/fonts), the signing page uses `css`.
 */
export const CONTRACT_FONTS = {
  serif: { label: "Serif", pdf: "Source Serif 4", css: "smd-font-serif" },
  "sans-serif": { label: "Sans-serif", pdf: "Inter", css: "smd-font-sans" },
} as const;

export type ContractFont = keyof typeof CONTRACT_FONTS;
export const CONTRACT_FONT_NAMES = Object.keys(CONTRACT_FONTS) as ContractFont[];

export function isContractFont(v: unknown): v is ContractFont {
  return typeof v === "string" && v in CONTRACT_FONTS;
}

export function fontOf(v: string | null | undefined): ContractFont {
  return isContractFont(v) ? v : "serif";
}
