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
  if (cachedModel && mergedConfig.temperature === DEFAULT_CONFIG.temperature) {
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

export function clearLLMCache(): void {
  cachedModel = null;
}

import logger from "./logger";

/**
 * Invoke model with retry logic for robust API calls
 */
export async function invokeWithRetry(
  model: ChatOpenAI,
  prompt: string,
  retries = 3,
  initialDelay = 2000
): Promise<string> {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await model.invoke(prompt);
      return String(response.content);
    } catch (error) {
      lastError = error;
      const errMsg = error instanceof Error ? error.message : String(error);

      // Check if it's a 401 error (Authentication) - sometimes transient, sometimes fatal
      // If it's 401, we might want to retry if it's due to concurrency/rate limiting masquerading as 401
      // But usually 401 is invalid token.
      // However, user specifically asked for retry mechanism for "401 Invalid Token".
      // So we will retry it.

      if (i < retries - 1) {
        const waitTime = initialDelay * Math.pow(2, i);
        logger.warn(
          `Model invocation failed (Attempt ${i + 1}/${retries}): ${errMsg}`
        );
        logger.warn(`Retrying in ${waitTime}ms...`);

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  throw lastError;
}
