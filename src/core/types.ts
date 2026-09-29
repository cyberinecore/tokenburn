export type ReportKind = "daily" | "weekly" | "monthly" | "session";

export type CostMode = "auto" | "calculate" | "display";

export type SortOrder = "asc" | "desc";

export type WeekDay = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export type UsageEntry = {
  agent: string;
  timestamp: number;
  sessionId: string;
  projectPath: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  extraTotalTokens: number;
  cacheCreation1hTokens?: number;
  reasoningOutputTokens?: number;
  costUSD?: number;
  recordedZeroCost?: boolean;
  credits?: number;
  messageCount?: number;
  speed?: "fast";
  pricingCandidates?: string[];
  exactPricingCandidates?: string[];
  overridePricingCandidates?: string[];
  cacheCreationBilledAsInput?: boolean;
  pricingModel?: string;
  extraBilledAsOutput?: boolean;
  isFallbackModel?: boolean;
  version?: string;
  requestInputTokens?: number;
  pricingIgnoresTimestamp?: boolean;
  candidateRule?: "first-positive" | "first-found";
  billedExtraOutputTokens?: number;
  costStyle?: "codex";
  lastActivityText?: string;
  usageLimitResetTime?: number;
};

export type PricedEntry = UsageEntry & {
  cost: number;
  missingPricing: boolean;
};

export type ModelBreakdown = {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  extraTotalTokens: number;
  cost: number;
  missingPricing: boolean;
};

export type UsageSummary = {
  date?: string;
  week?: string;
  month?: string;
  sessionId?: string;
  projectPath?: string;
  lastActivity?: string;
  firstActivity?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  extraTotalTokens: number;
  totalCost: number;
  credits?: number;
  messageCount?: number;
  reasoningOutputTokens?: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  versions?: string[];
};

export type LoadContext = {
  kind: ReportKind;
  last?: number;
  since?: string;
  until?: string;
  timezone?: string;
  offline: boolean;
  mode: CostMode;
  debug: boolean;
  warn: (message: string) => void;
};

export interface Adapter {
  readonly id: string;
  readonly label: string;
  readonly product: string;
  readonly envVars: readonly string[];
  readonly reports: readonly ReportKind[];
  readonly emptyTotalsNull?: boolean;
  readonly sessionStyle?: "claude" | "generic" | "generic-with-activity" | "entries-with-activity";
  hasData(): boolean;
  load(ctx: LoadContext): Promise<UsageEntry[]>;
  parseFiles?(files: string[], options?: Record<string, unknown>): unknown[][] | Promise<unknown[][]>;
  reportJson?(kind: ReportKind, entries: PricedEntry[], options: { timezone?: string; since?: string; until?: string }): unknown;
}
