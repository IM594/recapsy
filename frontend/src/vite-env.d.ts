/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RECAPLY_BACKEND_ORIGIN?: string;
  readonly VITE_DEBUG_SSE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

