export const LLM_ENV_KEYS = {
  modelName: "AI_MODEL_NAME",
  openaiBaseUrl: "OPENAI_BASE_URL",
  openaiApiKey: "OPENAI_API_KEY",
  modelFast: "AI_MODEL_FAST",
  baseUrlFast: "AI_BASEURL_FAST",
  modelBalanced: "AI_MODEL_BALANCED",
  baseUrlBalanced: "AI_BASEURL_BALANCED",
  modelQuality: "AI_MODEL_QUALITY",
  baseUrlQuality: "AI_BASEURL_QUALITY",
} as const;

export const LLM_ENV_PREFIXES = {
  tierModel: "AI_MODEL_",
  tierBaseUrl: "AI_BASEURL_",
  tierApiKey: "AI_APIKEY_",
} as const;

export const LLM_DEBUG_ENV_KEYS = {
  promptPreview: "DEBUG_LLM_PROMPT_PREVIEW",
} as const;
