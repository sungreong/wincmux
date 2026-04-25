import { describe, expect, it } from "vitest";
import {
  extractAssistantReadyMarker,
  extractAssistantResponsePreview,
  extractPromptMarker,
  hasAssistantPromptContext,
  hasAssistantResponseActivity
} from "../src/notify-detector";

describe("notify-detector prompt markers", () => {
  it("detects question-form proceed prompts", () => {
    const text = [
      "Bash command",
      "Run shell command",
      "Do you want to proceed?",
      "> 1. Yes",
      "  2. No"
    ].join("\n");
    const marker = extractPromptMarker(text);
    expect(marker).not.toBeNull();
    expect(marker?.key).toBe("proceed?");
  });

  it("detects numbered yes/no choices", () => {
    const text = "1. Yes\n2. No";
    const marker = extractPromptMarker(text);
    expect(marker).not.toBeNull();
    expect(marker?.key).toBe("yes/no choice");
  });

  it("recognizes assistant command context without explicit claude token", () => {
    const text = "Bash command\nRun shell command\nDo you want to proceed?";
    expect(hasAssistantPromptContext(text)).toBe(true);
  });

  it("recognizes Claude and Codex Korean ready prompts", () => {
    const claude = [
      "Claude Code",
      "대기 중입니다. 뭔가 도와드릴까요?",
      "? for shortcuts"
    ].join("\n");
    const codex = [
      "Model changed to gpt-5.4 medium",
      "안녕하세요. 무엇을 도와드릴까요?",
      "gpt-5.4 medium · 97% left · C:\\app\\WinCmux",
      ">"
    ].join("\n");

    expect(hasAssistantPromptContext(claude)).toBe(true);
    expect(extractAssistantReadyMarker(claude)).toBe("for_shortcuts");
    expect(hasAssistantPromptContext(codex)).toBe(true);
    expect(extractAssistantReadyMarker(codex)).toBe("codex_prompt");
  });

  it("treats short Korean assistant replies as response activity", () => {
    expect(hasAssistantResponseActivity("안녕하세요. 무엇을 도와드릴까요?")).toBe(true);
    expect(hasAssistantResponseActivity("필요하실 때 말씀해 주세요.")).toBe(true);
  });

  it("detects Korean assistant input requests", () => {
    const marker = extractPromptMarker("이 명령을 실행해도 될까요?");
    expect(marker).not.toBeNull();
    expect(marker?.key).toBe("ko confirm");
  });

  it("extracts a concise assistant response preview", () => {
    const preview = extractAssistantResponsePreview([
      "OpenAI Codex (v0.124.0)",
      "model: gpt-5.4 medium",
      "> Summarize recent commits",
      "최근 커밋은 알림 중복 제거와 작업 표시줄 배지 개선입니다.",
      "필요하실 때 말씀해 주세요.",
      "gpt-5.4 medium · C:\\app\\WinCmux",
      ">"
    ].join("\n"));
    expect(preview).toContain("최근 커밋");
    expect(preview).not.toContain("OpenAI Codex");
    expect(preview).not.toContain("gpt-5.4");
  });
});
