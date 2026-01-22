/**
 * LLM Factory - Unified LLM client configuration
 * Provides a factory with different model tiers for different use cases
 */

import { ChatOpenAI } from "@langchain/openai";
import {
  LLM_DEBUG_ENV_KEYS,
  LLM_ENV_KEYS,
  LLM_ENV_PREFIXES,
} from "../config/llm-env";

/**
 * Model Tier for different use cases:
 * - fast: High concurrency, lower quality (for daily summaries ~365 calls)
 * - balanced: Medium concurrency, medium quality (for weekly summaries ~52 calls)
 * - quality: Low concurrency, highest quality (for monthly/yearly summaries ~12 calls)
 */
export type ModelTier = "fast" | "balanced" | "quality";

interface LLMConfig {
  temperature?: number;
  maxRetries?: number;
  timeout?: number;
  tier?: ModelTier;
}

const DEFAULT_CONFIG: Required<Omit<LLMConfig, "tier">> = {
  temperature: 1.0,
  maxRetries: 3,
  timeout: 120000, // Default 2 minutes
};

// Tier-specific timeout configuration
const TIER_TIMEOUTS: Record<ModelTier, number> = {
  fast: 60000, // 1 minute - for quick, simple tasks
  balanced: 120000, // 2 minutes - for medium complexity
  quality: 300000, // 5 minutes - for complex, long-running tasks (e.g., year-end summaries)
};

// Cache by tier + temperature combination
const modelCache = new Map<string, ChatOpenAI>();

/**
 * Tier-specific configuration
 * Each tier can have its own model, baseURL, and apiKey
 *
 * Environment variables:
 * - AI_MODEL_FAST / AI_BASEURL_FAST / AI_APIKEY_FAST
 * - AI_MODEL_BALANCED / AI_BASEURL_BALANCED / AI_APIKEY_BALANCED
 * - AI_MODEL_QUALITY / AI_BASEURL_QUALITY / AI_APIKEY_QUALITY
 *
 * Fallback chain: tier-specific -> general (AI_MODEL_NAME etc) -> default
 */
interface TierConfig {
  modelName: string;
  baseURL?: string;
  apiKey?: string;
}

function getTierConfig(tier: ModelTier): TierConfig {
  const tierUpper = tier.toUpperCase();

  // Try tier-specific first
  const tierModel = process.env[`${LLM_ENV_PREFIXES.tierModel}${tierUpper}`];
  const tierBaseURL = process.env[`${LLM_ENV_PREFIXES.tierBaseUrl}${tierUpper}`];
  const tierApiKey = process.env[`${LLM_ENV_PREFIXES.tierApiKey}${tierUpper}`];

  // Fallback to general config
  const generalModel = process.env[LLM_ENV_KEYS.modelName];
  const generalBaseURL = process.env[LLM_ENV_KEYS.openaiBaseUrl];
  const generalApiKey = process.env[LLM_ENV_KEYS.openaiApiKey];

  return {
    modelName: tierModel || generalModel || "claude-sonnet-4-20250514",
    baseURL: tierBaseURL || generalBaseURL,
    apiKey: tierApiKey || generalApiKey,
  };
}

/**
 * Get a configured ChatOpenAI instance
 * Uses caching for better resource management
 */
export function getLLM(config: LLMConfig = {}): ChatOpenAI {
  const tier = config.tier || "balanced";
  const envConfig = getTierConfig(tier);
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    // Use tier-specific timeout if not explicitly provided
    timeout: config.timeout ?? TIER_TIMEOUTS[tier],
  };
  const cacheKey = `${tier}-${mergedConfig.temperature}`;

  // Check cache
  if (modelCache.has(cacheKey)) {
    return modelCache.get(cacheKey)!;
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

  modelCache.set(cacheKey, model);
  return model;
}

/**
 * Create a new LLM instance with specific config (non-cached)
 */
export function createLLM(config: LLMConfig = {}): ChatOpenAI {
  const tier = config.tier || "balanced";
  const envConfig = getTierConfig(tier);
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    // Use tier-specific timeout if not explicitly provided
    timeout: config.timeout ?? TIER_TIMEOUTS[tier],
  };

  return new ChatOpenAI({
    modelName: envConfig.modelName,
    temperature: mergedConfig.temperature,
    apiKey: envConfig.apiKey,
    maxRetries: 0, // Disable SDK internal retries - we handle retries ourselves
    timeout: mergedConfig.timeout,
    configuration: {
      baseURL: envConfig.baseURL,
    },
  });
}

export function clearLLMCache(): void {
  modelCache.clear();
}

import logger from "./logger";

function shouldLogPromptPreview(): boolean {
  const value = process.env[LLM_DEBUG_ENV_KEYS.promptPreview];
  return value === "1" || value === "true";
}

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
      const callStart = Date.now();
      const startTime = new Date().toISOString();
      logger.info(`🔄 LLM invoke started at ${startTime}`);

      const response = await model.invoke(prompt);

      const responseTime = new Date().toISOString();
      logger.info(`📥 LLM response received at ${responseTime}`);

      // 添加响应对象的详细日志
      logger.info(`📦 Response object type: ${typeof response}`);
      logger.info(`📦 Response keys: ${Object.keys(response).join(", ")}`);
      logger.info(`📦 Response content type: ${typeof response.content}`);

      const content = String(response.content);
      logger.info(
        `✅ LLM invoke completed in ${((Date.now() - callStart) / 1000).toFixed(
          1
        )}s, response length: ${content.length} chars`
      );

      return content;
    } catch (error) {
      lastError = error;
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : "";

      // 添加更详细的错误信息
      logger.error(`❌ Error details:`);
      logger.error(`   Message: ${errMsg}`);
      logger.error(`   Type: ${error?.constructor?.name || typeof error}`);
      if (errStack) {
        logger.error(`   Stack: ${errStack}`);
      }

      // Log prompt preview for debugging sensitive word / content filter errors
      const isSensitiveError =
        errMsg.includes("sensitive") ||
        errMsg.includes("content filter") ||
        errMsg.includes("400");

      if (isSensitiveError && i === 0) {
        if (shouldLogPromptPreview()) {
          // Only log on first attempt to avoid spam
          logger.warn(`📝 Prompt preview (first 500 chars):`);
          logger.warn(`   ${prompt.substring(0, 500).replace(/\n/g, " ")}...`);
          logger.warn(`📝 Prompt length: ${prompt.length} chars`);
        } else {
          logger.warn(
            `📝 Prompt preview disabled (set DEBUG_LLM_PROMPT_PREVIEW=true to enable). Prompt length: ${prompt.length} chars`
          );
        }
      }

      if (i < retries - 1) {
        const waitTime = initialDelay * Math.pow(2, i);
        logger.warn(
          `Model invocation failed (Attempt ${i + 1}/${retries}): ${errMsg}`
        );
        logger.warn(`Retrying in ${waitTime}ms...`);

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } else {
        // 最后一次重试失败时，记录完整的错误信息
        logger.error(`💥 All ${retries} attempts failed. Final error:`);
        logger.error(`   ${errMsg}`);
      }
    }
  }

  throw lastError;
}
