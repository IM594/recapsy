export const HTTP_HEADERS = {
  contentType: "Content-Type",
  requestId: "x-request-id",
} as const;

export const CONTENT_TYPES = {
  json: "application/json",
} as const;

export const QUERY_KEYS = {
  year: "year",
  type: "type",
  repo: "repo",
  rootPath: "rootPath",
} as const;

export const BODY_KEYS = {
  year: "year",
  selectedRepos: "selectedRepos",
  since: "since",
  until: "until",
  summaryType: "summaryType",
  author: "author",
  type: "type",
  id: "id",
  repo: "repo",
  customPrompt: "customPrompt",
} as const;

