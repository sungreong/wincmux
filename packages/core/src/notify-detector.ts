export interface PromptMarker {
  key: string;
  snippet: string;
}

export function normalizeTerminalOutput(output: string): string {
  if (!output) {
    return "";
  }
  if (!output.includes("\u001b")) {
    return output.replace(/(?:\u2190|<-)\[/g, "\u001b[");
  }
  return output;
}

export function stripAnsi(value: string): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r/g, "");
}

export function normalizePromptText(value: string): string {
  return stripAnsi(normalizeTerminalOutput(value))
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function extractPromptMarker(bufferText: string): PromptMarker | null {
  const recent = bufferText.slice(-1200);
  const checks: Array<{ key: string; rx: RegExp }> = [
    { key: "proceed?", rx: /\bdo\s+you\s+want\s+to\s+(?:proceed|continue)\s*\?/i },
    { key: "run shell command", rx: /\brun\s+shell\s+command\b/i },
    { key: "yes/no choice", rx: /(?:^|\n)\s*(?:[>]\s*)?[12][.)]\s*(?:yes|no)\b/im },
    { key: "enter to confirm", rx: /\benter\s+to\s+confirm\b/i },
    { key: "esc to cancel", rx: /\besc\s+to\s+cancel\b/i },
    { key: "y/n", rx: /\b(?:\[?\s*y\s*\/\s*n\s*\]?|yes\s*\/\s*no)\b/i },
    { key: "press enter", rx: /\b(?:press|hit)\s+enter\b/i },
    { key: "select option", rx: /\b(?:select|choose)\b[^.\n]{0,80}\b(?:option|item|number|choice)\b/i },
    { key: "select number", rx: /\b(?:enter|input|type)\b[^.\n]{0,48}\b(?:number|choice|option)\b/i },
    { key: "ko proceed?", rx: /(?:진행|계속).{0,8}(?:하시겠|할까)\S*/i },
    { key: "ko select", rx: /(?:선택|번호).{0,8}(?:입력|해\s*주세요|하세요)/i }
  ];

  for (const check of checks) {
    const match = recent.match(check.rx);
    if (!match) {
      continue;
    }

    const line = recent
      .split("\n")
      .reverse()
      .find((row) => check.rx.test(row));
    const snippet = (line ?? match[0] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    return {
      key: check.key,
      snippet: snippet || check.key
    };
  }

  return null;
}

export function computePromptDedupKey(sessionId: string, snippet: string): string {
  return `${sessionId}|assistant_prompt|${snippet.toLowerCase()}`;
}

export function hasAssistantResponseActivity(text: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  if (/(zigzag|inferring|thinking|working|processing|analyzing|완료|진행|응답)/i.test(normalized)) {
    return true;
  }
  if (normalized.length >= 40 && /[.!?]|[\u3131-\u318e\uac00-\ud7a3]/.test(normalized)) {
    return true;
  }
  return false;
}

export function hasAssistantPromptContext(bufferText: string): boolean {
  if (!bufferText) {
    return false;
  }
  return /\b(?:claude|codex)\b/i.test(bufferText)
    || /\b(?:bash|shell)\s+command\b/i.test(bufferText)
    || /\bdo\s+you\s+want\s+to\s+(?:proceed|continue)\s*\?/i.test(bufferText)
    || /\b(?:enter\s+to\s+confirm|esc\s+to\s+cancel)\b/i.test(bufferText);
}

export function extractAssistantReadyMarker(bufferText: string): string | null {
  const recent = bufferText.slice(-1400);
  const checks: Array<{ key: string; rx: RegExp }> = [
    { key: "for_shortcuts", rx: /\?\s*for\s*shortcuts/i },
    { key: "ready_to_help", rx: /\bready to help\b/i },
    { key: "what_to_work_on", rx: /\bwhat would you like to work on\b/i }
  ];

  for (const check of checks) {
    if (check.rx.test(recent)) {
      return check.key;
    }
  }
  return null;
}

export function computeCompletionDedupKey(sessionId: string, readyMarker: string): string {
  return `${sessionId}|task_done|${readyMarker}`;
}

export interface AiResumeMarker {
  tool: string;
  resume_cmd: string;
}

/**
 * Detects AI tool conversation session resume commands from PTY output.
 * Matches patterns like:
 *   claude --resume <uuid>
 *   codex --session <uuid>
 *   codex --resume <uuid>
 *   codex resume <uuid>
 */
export function extractAiResumeMarker(outputChunk: string): AiResumeMarker | null {
  const text = stripAnsi(normalizeTerminalOutput(outputChunk));

  // Claude: "claude --resume <uuid>"
  const claudeMatch = text.match(/\bclaude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[^0-9a-f-]|$)/i);
  if (claudeMatch) {
    return { tool: "claude", resume_cmd: `claude --resume ${claudeMatch[1]}` };
  }

  // Codex: "codex --session <uuid>", "codex --resume <uuid>", or "codex resume <uuid>"
  const codexMatch = text.match(/\bcodex\s+(?:--(?:session|resume)|resume)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[^0-9a-f-]|$)/i);
  if (codexMatch) {
    return { tool: "codex", resume_cmd: `codex resume ${codexMatch[1]}` };
  }

  return null;
}
