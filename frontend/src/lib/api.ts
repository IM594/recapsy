const DEFAULT_BACKEND_ORIGIN = "http://localhost:3456";

function getEnvBackendOrigin(): string | undefined {
  const value = import.meta.env.VITE_RECAPLY_BACKEND_ORIGIN;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getBackendOrigin(): string {
  return getEnvBackendOrigin() || DEFAULT_BACKEND_ORIGIN;
}

export function getApiUrl(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${getBackendOrigin()}/api${normalized}`;
}

export function getSummaryApiUrl(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${getBackendOrigin()}/api/summary${normalized}`;
}
