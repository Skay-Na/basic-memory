export interface OpenCodeMemoryConfig {
  bmPath: string;
  project?: string;
  projectId?: string;
  captureFolder: string;
  recallTimeframe: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureMinChars: number;
}

const DEFAULTS: OpenCodeMemoryConfig = {
  bmPath: "bm",
  captureFolder: "opencode/sessions",
  recallTimeframe: "7d",
  autoRecall: true,
  autoCapture: true,
  captureMinChars: 80,
};

const ALLOWED = new Set([
  "bmPath", "project", "projectId", "captureFolder", "recallTimeframe",
  "autoRecall", "autoCapture", "captureMinChars",
]);

export function parseConfig(value: unknown): OpenCodeMemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Basic Memory OpenCode plugin options must be an object");
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !ALLOWED.has(key));
  if (unknown.length) throw new Error(`Unknown Basic Memory OpenCode options: ${unknown.join(", ")}`);

  for (const key of ["bmPath", "project", "projectId", "captureFolder", "recallTimeframe"] as const) {
    const item = raw[key];
    if (item !== undefined && (typeof item !== "string" || item.trim() === "")) {
      throw new Error(`Basic Memory OpenCode option ${key} must be a non-empty string`);
    }
  }
  for (const key of ["autoRecall", "autoCapture"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(`Basic Memory OpenCode option ${key} must be a boolean`);
    }
  }
  if (raw.captureMinChars !== undefined
    && (typeof raw.captureMinChars !== "number" || !Number.isFinite(raw.captureMinChars)
      || raw.captureMinChars < 0)) {
    throw new Error("Basic Memory OpenCode option captureMinChars must be a non-negative number");
  }

  return {
    bmPath: (raw.bmPath as string | undefined)?.trim() ?? DEFAULTS.bmPath,
    project: (raw.project as string | undefined)?.trim(),
    projectId: (raw.projectId as string | undefined)?.trim(),
    captureFolder: (raw.captureFolder as string | undefined)?.trim() ?? DEFAULTS.captureFolder,
    recallTimeframe: (raw.recallTimeframe as string | undefined)?.trim() ?? DEFAULTS.recallTimeframe,
    autoRecall: (raw.autoRecall as boolean | undefined) ?? DEFAULTS.autoRecall,
    autoCapture: (raw.autoCapture as boolean | undefined) ?? DEFAULTS.autoCapture,
    captureMinChars: (raw.captureMinChars as number | undefined) ?? DEFAULTS.captureMinChars,
  };
}

export function projectArgs(config: OpenCodeMemoryConfig): string[] {
  if (config.projectId) return ["--project-id", config.projectId];
  if (config.project) return ["--project", config.project];
  throw new Error("Set project or projectId in the Basic Memory OpenCode plugin options first");
}
