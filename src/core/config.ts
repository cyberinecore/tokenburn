import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, home } from "./fs.ts";

export type OptionMap = Record<string, unknown>;

export type ConfigFile = {
  defaults?: OptionMap;
  commands?: Record<string, OptionMap>;
  pricingOverrides?: Record<string, OptionMap>;
  [agent: string]: unknown;
};

export const configCandidates = (explicit?: string): string[] => {
  if (explicit) return [expandHome(explicit)];
  const xdg = process.env.XDG_CONFIG_HOME || join(home(), ".config");
  return [join(process.cwd(), ".tokenburn", "config.json"), join(xdg, "tokenburn", "config.json"), join(home(), ".tokenburn", "config.json")];
};

export const loadConfig = (explicit?: string): { path?: string; config: ConfigFile } => {
  for (const path of configCandidates(explicit)) {
    if (!existsSync(path)) {
      if (explicit) throw new Error(`Config file not found: ${path}`);
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { path, config: parsed as ConfigFile };
    } catch (error) {
      if (explicit) throw new Error(`Invalid config file ${path}: ${(error as Error).message}`);
    }
  }
  return { config: {} };
};

const asMap = (value: unknown): OptionMap => (value && typeof value === "object" && !Array.isArray(value) ? (value as OptionMap) : {});

export const mergedOptions = (config: ConfigFile, agent: string | undefined, report: string): OptionMap => {
  const layers: OptionMap[] = [asMap(config.defaults), asMap(config.commands?.[report])];
  if (agent) {
    layers.push(asMap(config.commands?.[`${agent} ${report}`]), asMap(config.commands?.[`${agent}:${report}`]));
    const agentBlock = asMap(config[agent]);
    layers.push(asMap(agentBlock.defaults), asMap(asMap(agentBlock.commands)[report]));
  }
  return Object.assign({}, ...layers);
};

export const pricingOverrides = (config: ConfigFile, options: OptionMap): Record<string, OptionMap> => ({
  ...asMap(config.pricingOverrides),
  ...asMap(asMap(config.defaults).pricingOverrides),
  ...asMap(options.pricingOverrides),
}) as Record<string, OptionMap>;
