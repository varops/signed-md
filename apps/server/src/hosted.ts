/**
 * The hosted service's control plane. Self-hosted installations never use it. HOSTED_APP_URL (a
 * hidden hosted control) points a test workspace at a test app; the default is app.signed.md.
 */
export const DEFAULT_HOSTED_APP_URL = "https://app.signed.md";

let appUrl = DEFAULT_HOSTED_APP_URL;
let workspace = "";

/** Set once at startup: the app's address, and this workspace's host for the app's links. */
export function setHostedApp(url: string, publicUrl: string): void {
  appUrl = url;
  workspace = new URL(publicUrl).host;
}

/** A link to the app for this workspace, such as /account or /billing, with ?workspace=<host>. */
export function hostedAppLink(path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ ...params, ...(workspace ? { workspace } : {}) });
  return `${appUrl}${path}?${q}`;
}
