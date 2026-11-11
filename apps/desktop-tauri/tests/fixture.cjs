const input = "한글  A   가가가";
const multiline = "한글  A\n\n  가가가";
const output = "응답  A   가나";
process.stdin.setEncoding("utf8");
process.stdin.setRawMode(true);

let pending = "";
process.stdout.write("FIXTURE_READY\r\n");
process.stdin.on("data", (data) => {
  pending += data;
  if (pending === "#paste-on#" || pending === "#paste-off#") {
    process.stdout.write(pending === "#paste-on#" ? "\x1b[?2004h" : "\x1b[?2004l");
    pending = "";
  }
  // Node's Windows console input consumes the paste delimiters, while exposing
  // the pasted line feeds and spaces through its raw stdin stream.
  while (pending.startsWith(multiline)) {
    process.stdout.write("PASTE_OK:" + Buffer.from(multiline).toString("base64") + "\r\n");
    pending = pending.slice(multiline.length);
  }
  if (pending.startsWith(input)) {
    process.stdout.write("INPUT_OK:" + input + "\r\n");
    pending = pending.slice(input.length);
  }
  if (pending === "#burst#") {
    pending = "";
    for (let i = 0; i < 3000; i++) {
      process.stdout.write("\x1b[36m" + String(i).padStart(4, "0") + "|" + output + "\x1b[0m\r\n");
    }
  }
  const demo = /^#demo:(chat|test)#$/.exec(pending);
  if (demo) {
    pending = "";
    const lines = demo[1] === "chat" ? [
      "\x1b[36;1mWinCMux Terminal Demo\x1b[0m",
      "Tauri + Rust · Windows ConPTY",
      "",
      "\x1b[32m›\x1b[0m 한글과  연속 공백이 잘 보이는지 확인해 줘.",
      "",
      "  한글 응답이 순서대로 표시됩니다.",
      "  같은 줄에 English, 숫자 123, 기호 ✓도 표시됩니다.",
      "",
      "\x1b[90mCtrl+Alt+Enter  입력창 열기\x1b[0m"
    ] : [
      "\x1b[36;1mTerminal checks · sample output\x1b[0m",
      "",
      "\x1b[32m✓\x1b[0m Korean and consecutive spaces",
      "\x1b[32m✓\x1b[0m 18,000 rows verified",
      "\x1b[32m✓\x1b[0m Wrapped URL copied as one line",
      "",
      "Codex CLI and Claude Code run in separate panes."
    ];
    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n");
  }
  const ping = /^#ping:(\d+)#$/.exec(pending);
  if (ping) {
    pending = "";
    process.stdout.write("PONG:" + ping[1] + ":END\r\n");
  }
});
