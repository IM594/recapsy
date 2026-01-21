import { getApiUrl } from "@/lib/api";
import type { RepoInfo } from "@/types/repos";
import { fetchJson } from "./http";

export async function scanRepos(rootPath: string): Promise<RepoInfo[]> {
  const search = new URLSearchParams({ rootPath });
  const data = await fetchJson<{ repos?: RepoInfo[] }>(
    getApiUrl(`/repos?${search}`)
  );
  return data.repos || [];
}

