/** Normalize the build-time deployment prefix used by Next and public assets. */
export function getBasePath(): string {
  const configured = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";
  return configured ? `/${configured.replace(/^\/+|\/+$/g, "")}` : "";
}
