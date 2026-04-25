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
    { key: "should i?", rx: /\b(?:should\s+i|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to)\b[^?\n]{0,120}\?/i },
    { key: "waiting for input", rx: /\b(?:waiting|awaiting)\s+(?:for\s+)?(?:your\s+)?(?:input|response|confirmation|approval)\b/i },
    { key: "need input", rx: /\bneed\s+(?:your\s+)?(?:input|response|confirmation|approval)\b/i },
    { key: "run shell command", rx: /\brun\s+shell\s+command\b/i },
    { key: "yes/no choice", rx: /(?:^|\n)\s*(?:[>]\s*)?[12][.)]\s*(?:yes|no)\b/im },
    { key: "enter to confirm", rx: /\benter\s+to\s+confirm\b/i },
    { key: "esc to cancel", rx: /\besc\s+to\s+cancel\b/i },
    { key: "y/n", rx: /\b(?:\[?\s*y\s*\/\s*n\s*\]?|yes\s*\/\s*no)\b/i },
    { key: "press enter", rx: /\b(?:press|hit)\s+enter\b/i },
    { key: "select option", rx: /\b(?:select|choose)\b[^.\n]{0,80}\b(?:option|item|number|choice)\b/i },
    { key: "select number", rx: /\b(?:enter|input|type)\b[^.\n]{0,48}\b(?:number|choice|option)\b/i },
    { key: "ko proceed?", rx: /(?:진행|계속).{0,8}(?:하시겠|할까)\S*/i },
    { key: "ko select", rx: /(?:선택|번호).{0,8}(?:입력|해\s*주세요|하세요)/i },
    { key: "ko waiting input", rx: /(?:입력을?\s*기다리고|응답을?\s*기다리고)/i },
    { key: "ko confirm", rx: /(?:실행|수정|변경|진행|계속|허용|승인).{0,16}(?:할까요|하시겠습니까|해도\s*될까요|할지)/i }
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
  const key = `${sessionId}|assistant_prompt|${snippet.toLowerCase()}`;
  return key.slice(0, 200);
}

export function hasAssistantResponseActivity(text: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  if (/(zigzag|inferring|thinking|working|processing|analyzing|summariz|searching|reading|editing|writing|완료|진행|응답|생각|분석|처리|작업|수정|작성|검색|확인|알겠습니다|안녕하세요|도와드릴|말씀)/i.test(normalized)) {
    return true;
  }
  if (/[가-힣][^.!?\n]{2,}[.!?？]?/.test(normalized) && normalized.length >= 12) {
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
    || /\b(?:gpt-\S+|sonnet|opus)\b/i.test(bufferText)
    || /(?:Claude\s+Code|Codex\s+CLI)/i.test(bufferText)
    || /\b(?:bash|shell)\s+command\b/i.test(bufferText)
    || /\bdo\s+you\s+want\s+to\s+(?:proceed|continue)\s*\?/i.test(bufferText)
    || /\b(?:enter\s+to\s+confirm|esc\s+to\s+cancel)\b/i.test(bufferText)
    || /(?:대기\s*중입니다|도와드릴까요|입력을?\s*기다리고|응답을?\s*기다리고)/i.test(bufferText);
}

export function extractAssistantReadyMarker(bufferText: string): string | null {
  const recent = bufferText.slice(-1400);
  const checks: Array<{ key: string; rx: RegExp }> = [
    { key: "for_shortcuts", rx: /\?\s*for\s*shortcuts/i },
    { key: "ready_to_help", rx: /\bready to help\b/i },
    { key: "what_to_work_on", rx: /\bwhat would you like to work on\b/i },
    { key: "how_can_help", rx: /\b(?:how can i help|what can i help|anything else)\b/i },
    { key: "waiting_for_request", rx: /\b(?:waiting|ready)\b[^.\n]{0,80}\b(?:request|input|prompt|instructions)\b/i },
    { key: "codex_prompt", rx: /(?:^|\n)\s*[›>]\s*(?:$|\n)/m },
    { key: "ko_ready_waiting", rx: /대기\s*중입니다/i },
    { key: "ko_help_ready", rx: /(?:무엇|뭔가|어떤|무엇을).{0,16}도와드릴까요\??/i },
    { key: "ko_when_needed", rx: /필요하실\s*때\s*말씀/i }
  ];

  for (const check of checks) {
    if (check.rx.test(recent)) {
      return check.key;
    }
  }
  return null;
}

export function computeCompletionDedupKey(sessionId: string, readyMarker: string): string {
  return `${sessionId}|task_done|${readyMarker}`.slice(0, 200);
}

export function extractAssistantResponsePreview(bufferText: string, maxChars = 220): string | null {
  const text = normalizePromptText(bufferText);
  if (!text) {
    return null;
  }
  const lines = text
    .split("\n")
    .map((line) => line.replace(/[│┌┐└┘─═╭╮╰╯]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const candidates = lines
    .slice(-40)
    .filter((line) => {
      if (/^(?:>|›|\? for shortcuts)$/i.test(line)) return false;
      if (/^(?:PS|C:\\|[A-Z]:\\|bash\$|pwsh>)/i.test(line)) return false;
      if (/\b(?:OpenAI Codex|Claude Code|Welcome back|model:|directory:|gpt-\S+|Sonnet|Opus|Tip:|MCP startup|MCP client)\b/i.test(line)) return false;
      if (/^(?:[-•*]\s*)?(?:bypass permissions|esc to|shift\+tab|\/model|\/effort)\b/i.test(line)) return false;
      if (/^[\-= _]{8,}$/.test(line)) return false;
      return /[A-Za-z가-힣0-9]/.test(line);
    });
  const preview = candidates.slice(-3).join(" ").replace(/\s+/g, " ").trim();
  if (!preview) {
    return null;
  }
  return preview.length > maxChars ? `${preview.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...` : preview;
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
