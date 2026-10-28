export interface OpenCodeMemoryConfig {
  endpoint: string;
  tokenFile: string;
  project: string;
  captureFolder: string;
  autoRecall: boolean;
  autoCapture: boolean;
  captureMinChars: number;
  semanticCaptureInterval: number;
  stateBackend: "local" | "remote";
}
export function parseConfig(value: unknown): OpenCodeMemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Basic Memory options must be an object");
  const raw = value as Record<string, unknown>;
  const allowed = ["endpoint", "tokenFile", "project", "captureFolder", "autoRecall", "autoCapture", "captureMinChars", "semanticCaptureInterval", "stateBackend"];
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length) throw new Error(`Unknown Basic Memory options: ${unknown.join(", ")}`);
  for (const key of ["endpoint", "tokenFile", "project", "captureFolder"]) if (raw[key] !== undefined && (typeof raw[key] !== "string" || !raw[key].trim())) throw new Error(`${key} must be a non-empty string`);
  for (const key of ["autoRecall", "autoCapture"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`${key} must be boolean`);
  if (raw.autoCapture === true) throw new Error("Automatic transcript capture is disabled until semantic review and recovery are implemented");
  if (raw.stateBackend !== undefined && raw.stateBackend !== "local" && raw.stateBackend !== "remote") throw new Error("stateBackend must be local or remote");
  if (raw.semanticCaptureInterval !== undefined && (!Number.isInteger(raw.semanticCaptureInterval) || Number(raw.semanticCaptureInterval) < 1 || Number(raw.semanticCaptureInterval) > 100)) throw new Error("semanticCaptureInterval must be an integer between 1 and 100");
  if (raw.captureMinChars !== undefined && (typeof raw.captureMinChars !== "number" || !Number.isFinite(raw.captureMinChars) || raw.captureMinChars < 0)) throw new Error("captureMinChars must be non-negative");
  if (!raw.project || !raw.endpoint || !raw.tokenFile) throw new Error("Set endpoint, tokenFile and project explicitly");
  return { endpoint: String(raw.endpoint).trim(), tokenFile: String(raw.tokenFile).trim(), project: String(raw.project).trim(), captureFolder: String(raw.captureFolder ?? "opencode/inbox").trim(), autoRecall: raw.autoRecall !== false, autoCapture: false, captureMinChars: Number(raw.captureMinChars ?? 0), semanticCaptureInterval: Number(raw.semanticCaptureInterval ?? 5), stateBackend: raw.stateBackend === "remote" ? "remote" : "local" };
}
