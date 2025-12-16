/**
 * LLM Factory - Unified LLM client configuration
 * Provides a singleton factory with consistent settings across all nodes
 */

import { ChatOpenAI } from "@langchain/openai";

interface LLMConfig {
  temperature?: number;
  maxRetries?: number;
  timeout?: number;
}

const DEFAULT_CONFIG: Required<LLMConfig> = {
  temperature: 0.3,
  maxRetries: 3,
  timeout: 60000,
};

let cachedModel: ChatOpenAI | null = null;

/**
 * Get the LLM configuration from environment variables
 */
function getEnvConfig() {
  return {
    modelName: process.env.AI_MODEL_NAME,
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  };
}

/**
 * Get a configured ChatOpenAI instance
 * Uses singleton pattern for better resource management
 */
export function getLLM(config: LLMConfig = {}): ChatOpenAI {
  const envConfig = getEnvConfig();
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // For different temperatures, create a new instance
  if (
    cachedModel &&
    mergedConfig.temperature === DEFAULT_CONFIG.temperature
  ) {
    return cachedModel;
  }

  const model = new ChatOpenAI({
    modelName: envConfig.modelName,
    temperature: mergedConfig.temperature,
    apiKey: envConfig.apiKey,
    maxRetries: mergedConfig.maxRetries,
    timeout: mergedConfig.timeout,
    configuration: {
      baseURL: envConfig.baseURL,
    },
  });

  // Cache only default temperature instances
  if (mergedConfig.temperature === DEFAULT_CONFIG.temperature) {
    cachedModel = model;
  }

  return model;
}

/**
 * Create a new LLM instance with specific config (non-cached)
 */
export function createLLM(config: LLMConfig = {}): ChatOpenAI {
  const envConfig = getEnvConfig();
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return new ChatOpenAI({
    modelName: envConfig.modelName,
    temperature: mergedConfig.temperature,
    apiKey: envConfig.apiKey,
    maxRetries: mergedConfig.maxRetries,
    timeout: mergedConfig.timeout,
    configuration: {
      baseURL: envConfig.baseURL,
    },
  });
}

/**
 * Clear the cached LLM instance (useful for testing or config changes)
 */
export function clearLLMCache(): void {
  cachedModel = null;
}
