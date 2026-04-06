export const API_PORT = 21890 as const;
export const MCP_PORT = 21891 as const;
export const API_PREFIX = "/api/v1" as const;
export const WS_PATH = "/ws" as const;

export const ROUTES = {
  HEALTH: "/health",
  INGEST_SCREENSHOT: "/ingest/screenshot",
  INGEST_BATCH: "/ingest/batch",
  SEARCH: "/search",
  SEARCH_SUGGEST: "/search/suggest",
  TIMELINE: "/timeline",
  TIMELINE_SUMMARY: "/timeline/summary",
  ENTITIES: "/entities",
  ENTITY_DETAIL: "/entities/:id",
  SETTINGS: "/settings",
  COLLECTOR_CONFIG: "/collector/config",
  COLLECTOR_HEARTBEAT: "/collector/heartbeat",
  BACKUP_TRIGGER: "/backup/trigger",
  BACKUP_STATUS: "/backup/status",
  EXPORT: "/export",
  CHAT: "/chat",
  CHAT_SESSION: "/chat/:sessionId",
} as const;
