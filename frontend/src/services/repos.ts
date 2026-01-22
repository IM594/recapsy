import { getApiUrl } from "@/lib/api";
import { API_ROUTES, QUERY_KEYS } from "@recaply/shared";
import type { RepoInfo } from "@/types/repos";
import { fetchJson, type RequestOptions } from "./http";

export async function scanRepos(
  rootPath: string,
  opts?: RequestOptions
): Promise<RepoInfo[]> {
  const search = new URLSearchParams({ [QUERY_KEYS.rootPath]: rootPath });
  const data = await fetchJson<{ repos?: RepoInfo[] }>(
    getApiUrl(`${API_ROUTES.repos}?${search}`),
    { signal: opts?.signal }
  );
  return data.repos || [];
}
