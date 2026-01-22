export const STORAGE_KEYS = {
  settings: {
    selectedRepos: "recaply_selected_repos",
    author: "recaply_author",
    scanRootPath: "recaply_scan_root_path",
  },
  year: {
    activeYear: "recaply_active_year",
  },
} as const;

export const LEGACY_STORAGE_KEYS = {
  settings: {
    selectedRepos: "ye_selected_repos",
    author: "ye_author",
  },
} as const;

