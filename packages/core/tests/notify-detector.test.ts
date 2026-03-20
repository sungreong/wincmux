import { describe, expect, it } from "vitest";
import { extractPromptMarker, hasAssistantPromptContext } from "../src/notify-detector";

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
});
