import { getApiUrl } from "@/lib/api";
import { API_ROUTES, QUERY_KEYS } from "@recaply/shared";
import type { RepoInfo } from "@/types/repos";
import { fetchJson } from "./http";

export async function scanRepos(rootPath: string): Promise<RepoInfo[]> {
  const search = new URLSearchParams({ [QUERY_KEYS.rootPath]: rootPath });
  const data = await fetchJson<{ repos?: RepoInfo[] }>(
    getApiUrl(`${API_ROUTES.repos}?${search}`)
  );
  return data.repos || [];
}
