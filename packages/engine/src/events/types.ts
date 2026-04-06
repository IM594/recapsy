export type EngineEventMap = {
  "db:connected": { url: string };
  "db:disconnected": { reason: string };
  "migration:applied": { version: number; name: string; durationMs: number };
  "migration:failed": { version: number; name: string; error: string };
};
