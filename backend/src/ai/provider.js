import { upstream } from '../lib/http.js';

/**
 * Model access, with failover.
 *
 * Amazon Bedrock is not available inside AWS Academy Learner Lab, so
 * generation runs on external providers. Both of the ones configured here are
 * OpenAI-compatible, which means one client and two base URLs rather than two
 * SDKs.
 *
 * The order matters and is not arbitrary:
 *   1. OpenRouter — the widest free-tier catalogue, but a hard 20 requests per
 *      minute on ':free' variants regardless of credit, so it is the one that
 *      will rate-limit first on a busy demo day.
 *   2. NVIDIA NIM — a separate free tier on entirely different infrastructure,
 *      so an OpenRouter limit or outage does not touch it.
 *
 * Failing over on 429/5xx/timeout rather than on any error is deliberate: a
 * 400 means our request is malformed and the second provider will reject it
 * identically, so retrying there just doubles the latency of a certain failure.
 *
 * Every key stays in Lambda environment variables. Nothing reaches the browser,
 * which is also why demo mode cannot generate recaps.
 */

const PROVIDERS = [
  {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    // OpenRouter asks for these for attribution on its dashboards.
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/smartrecap',
      'X-Title': 'SmartRecap',
    },
  },
  {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    modelEnv: 'NVIDIA_MODEL',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    extraHeaders: {},
  },
];

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TIMEOUT_MS = 90_000;

export function configuredProviders() {
  return PROVIDERS.filter((p) => !!process.env[p.keyEnv]);
}

async function callOnce(provider, { messages, temperature, maxTokens, jsonSchema }) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env[provider.keyEnv]}`,
        ...provider.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? 0.2,
        max_tokens: maxTokens ?? 4096,
        // Not every free model honours json_schema; those that do not fall
        // back to json_object, and parsing is defensive either way.
        ...(jsonSchema
          ? { response_format: { type: 'json_schema', json_schema: { name: 'recap', strict: true, schema: jsonSchema } } }
          : { response_format: { type: 'json_object' } }),
      }),
    });

    const text = await res.text();

    if (!res.ok) {
      const err = new Error(`${provider.name} returned ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.retryable = RETRYABLE.has(res.status);
      throw err;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const err = new Error(`${provider.name} returned a non-JSON envelope.`);
      err.retryable = true;
      throw err;
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      const err = new Error(`${provider.name} returned no message content.`);
      err.retryable = true;
      throw err;
    }

    return {
      content,
      provider: provider.name,
      model,
      latencyMs: Date.now() - startedAt,
      tokensIn: payload.usage?.prompt_tokens ?? 0,
      tokensOut: payload.usage?.completion_tokens ?? 0,
      // Both providers are used on their free tiers; if that ever changes this
      // is the one place that needs a price table.
      costUsd: 0,
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`${provider.name} timed out after ${TIMEOUT_MS / 1000}s.`);
      err.retryable = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the request against each configured provider in order.
 * `onAttempt` reports each try so the pipeline log can show a failover happening
 * rather than silently taking 40 seconds longer.
 */
export async function complete(request, { onAttempt } = {}) {
  const available = configuredProviders();
  if (!available.length) {
    throw upstream(
      'No AI provider is configured. Set OPENROUTER_API_KEY or NVIDIA_API_KEY on the stack and redeploy.',
    );
  }

  const failures = [];

  for (const provider of available) {
    try {
      onAttempt?.({ provider: provider.name, status: 'calling' });
      const result = await callOnce(provider, request);
      onAttempt?.({ provider: provider.name, status: 'ok', latencyMs: result.latencyMs });
      return result;
    } catch (e) {
      failures.push(`${provider.name}: ${e.message}`);
      onAttempt?.({ provider: provider.name, status: 'failed', reason: e.message });
      console.warn('Provider failed', provider.name, e.message);
      if (!e.retryable) break; // a malformed request fails identically everywhere
    }
  }

  throw upstream('Every configured AI provider failed.', failures);
}
