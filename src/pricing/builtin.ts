export type BuiltinRates = {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  inputAbove200k?: number;
  outputAbove200k?: number;
  cacheCreateAbove200k?: number;
  cacheReadAbove200k?: number;
  fastFromOverrides?: boolean;
};

const rates = (input: number, output: number, cacheCreate: number, cacheRead: number, fast = false): BuiltinRates => ({
  input,
  output,
  cacheCreate,
  cacheRead,
  fastFromOverrides: fast,
});

const claude35Haiku = rates(0.8e-6, 4e-6, 1.0e-6, 0.08e-6);
const gpt51 = rates(1.25e-6, 10e-6, 1.25e-6, 0.125e-6);
const gpt5Codex = rates(1.75e-6, 14e-6, 1.75e-6, 0.175e-6);
const glm = (input: number, output: number, cacheRead: number): BuiltinRates => rates(input, output, 0, cacheRead);
const glmBase = glm(0.6e-6, 2.2e-6, 0.11e-6);

export const BUILTIN_PRICING: Record<string, BuiltinRates> = {
  "claude-opus-4-5": rates(5e-6, 25e-6, 6.25e-6, 0.5e-6),
  "claude-opus-4-6": rates(5e-6, 25e-6, 6.25e-6, 0.5e-6, true),
  "claude-opus-4-7": rates(5e-6, 25e-6, 6.25e-6, 0.5e-6, true),
  "claude-opus-4-8": rates(5e-6, 25e-6, 6.25e-6, 0.5e-6, true),
  "claude-haiku-4-5": rates(1e-6, 5e-6, 1.25e-6, 0.1e-6),
  "claude-opus-4": rates(15e-6, 75e-6, 18.75e-6, 1.5e-6),
  "claude-sonnet-4-6": rates(3e-6, 15e-6, 3.75e-6, 0.3e-6),
  "claude-sonnet-4": {
    ...rates(3e-6, 15e-6, 3.75e-6, 0.3e-6),
    inputAbove200k: 6e-6,
    outputAbove200k: 22.5e-6,
    cacheCreateAbove200k: 7.5e-6,
    cacheReadAbove200k: 0.6e-6,
  },
  "claude-3-5-haiku": claude35Haiku,
  "claude-3-5-haiku-20241022": claude35Haiku,
  "claude-3-opus": rates(15e-6, 75e-6, 18.75e-6, 1.5e-6),
  "claude-3-sonnet": rates(3e-6, 15e-6, 3.75e-6, 0.3e-6),
  "claude-3-haiku": rates(0.25e-6, 1.25e-6, 0.3e-6, 0.03e-6),
  "gpt-5": rates(1.25e-6, 10e-6, 1.25e-6, 0.125e-6),
  "gpt-5.5": rates(5e-6, 30e-6, 5e-6, 0.5e-6, true),
  "grok-4.3": rates(1.25e-6, 2.5e-6, 1.25e-6, 0.125e-6),
  "moonshot/kimi-k2.5": rates(0.6e-6, 3e-6, 0.75e-6, 0.1e-6),
  "moonshot/kimi-k2.6": rates(0.95e-6, 4e-6, 1.1875e-6, 0.16e-6),
  "gpt-5.1": gpt51,
  "gpt-5.3-codex": { ...gpt5Codex, fastFromOverrides: true },
  "gpt-5.4": rates(2.5e-6, 15e-6, 2.5e-6, 0.25e-6, true),
  "gpt-5.4-mini": rates(0.75e-6, 4.5e-6, 0.75e-6, 0.075e-6),
  "gpt-5.4-nano": rates(0.2e-6, 1.25e-6, 0.2e-6, 0.02e-6),
  "gpt-5.6-sol": rates(5e-6, 30e-6, 6.25e-6, 0.5e-6, true),
  "gpt-5.6-terra": rates(2.5e-6, 15e-6, 3.125e-6, 0.25e-6, true),
  "gpt-5.6-luna": rates(1e-6, 6e-6, 1.25e-6, 0.1e-6, true),
  "glm-5": { ...glmBase, input: 1.0e-6, output: 3.2e-6, cacheRead: 0.2e-6 },
  "glm-5-turbo": { ...glmBase, input: 1.2e-6, output: 4.0e-6, cacheRead: 0.24e-6 },
  "glm-5.1": { ...glmBase, input: 1.4e-6, output: 4.4e-6, cacheRead: 0.26e-6 },
};

export const BUILTIN_OVERWRITE: Record<string, BuiltinRates> = {
  "gpt-5.1-codex": gpt51,
  "gpt-5.2-codex": gpt5Codex,
  "gpt-5.2": gpt5Codex,
};

export const BUILTIN_GLM: Record<string, BuiltinRates> = {
  "glm-4.5": glmBase,
  "zai/glm-4.5": glmBase,
  "zai/glm-4.5-x": glm(2.2e-6, 8.9e-6, 0.45e-6),
  "zai/glm-4.5-air": glm(0.2e-6, 1.1e-6, 0.03e-6),
  "zai/glm-4.5-airx": glm(1.1e-6, 4.5e-6, 0.22e-6),
  "zai/glm-4.5v": glm(0.6e-6, 1.8e-6, 0.11e-6),
  "zai/glm-4-32b-0414-128k": glm(0.1e-6, 0.1e-6, 0),
  "zai/glm-4.5-flash": glm(0, 0, 0),
  "glm-4.6": glmBase,
  "glm-4.7": glmBase,
};
