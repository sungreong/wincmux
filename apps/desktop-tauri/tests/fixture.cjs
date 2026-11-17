const input = "한글  A   가가가";
const multiline = "한글  A\n\n  가가가";
const output = "응답  A   가나";
process.stdin.setEncoding("utf8");
process.stdin.setRawMode(true);

let pending = "";
let draft = "";
let renderTimer;
let renderFrame = 0;
process.stdout.write("FIXTURE_READY\r\n");
process.stdin.on("data", (data) => {
  pending += data;
  const quota = /^#quota:(claude|codex|gemini|unknown|auto-continue)#$/.exec(pending);
  if (quota) {
    pending = '';
    const provider = quota[1] === 'unknown' ? 'Gemini' : quota[1] === 'auto-continue' ? 'Codex' : quota[1];
    const text = quota[1] === 'auto-continue' ? '⚠️Usagelimitreached·continuingautomaticallyat7:50pm·esctocancel ⚠ /usage-credits to continue now'
      : quota[1] === 'gemini' ? 'You have exhausted your daily quota. Retry in 4 seconds'
      : quota[1] === 'unknown' ? 'You have exhausted your daily quota.'
      : "You've hit your 5-hour limit. Retry in 4 seconds";
    process.stdout.write(provider + '\r\n\x1b[31m' + text + '\x1b[0m\r\n');
  }
  if (pending === "#render-on#") {
    pending = "";
    clearInterval(renderTimer);
    const render = () => process.stdout.write("\x1b[H" + [
      "English answer stays at left",
      "한글 응답도 왼쪽부터",
      "Mixed 🧪 cell width",
      "FRAME " + (++renderFrame)
    ].map(line => "\x1b[2K" + line).join("\r\n") + "\r\n\x1b[J");
    render();
    renderTimer = setInterval(render, 20);
  }
  if (pending === "#render-off#") { pending = ""; clearInterval(renderTimer); }
  if (pending === "#width#") {
    pending = "";
    const cols = process.stdout.columns;
    const prefix = `NEW width=${cols} `;
    process.stdout.write("\x1b[H\x1b[2K" + prefix + "X".repeat(Math.max(0, cols - prefix.length - 3)) + "END\r\n\x1b[J");
  }
  if (pending === "#paste-on#" || pending === "#paste-off#") {
    process.stdout.write(pending === "#paste-on#" ? "\x1b[?2004h" : "\x1b[?2004l");
    pending = "";
  }
  // Node's Windows console input consumes the paste delimiters, while exposing
  // the pasted line feeds and spaces through its raw stdin stream.
  while (pending.startsWith(multiline)) {
    draft += multiline;
    process.stdout.write("PASTE_OK:" + Buffer.from(multiline).toString("base64") + "\r\n");
    pending = pending.slice(multiline.length);
  }
  if (pending.startsWith(input)) {
    draft += input;
    process.stdout.write("INPUT_OK:" + input + "\r\n");
    pending = pending.slice(input.length);
  }
  while (pending.startsWith("\r")) {
    process.stdout.write("SUBMIT_OK:" + Buffer.from(draft).toString("base64") + ":END\r\n");
    draft = "";
    pending = pending.slice(1);
  }
  if (pending === "#burst#") {
    pending = "";
    for (let i = 0; i < 3000; i++) {
      process.stdout.write("\x1b[36m" + String(i).padStart(4, "0") + "|" + output + "\x1b[0m\r\n");
    }
  }
  const status = /^#status:(working|blocked|done|idle|error)#$/.exec(pending);
  if (status) {
    pending = "";
    process.stdout.write("\x1b]7501;state=" + status[1] + ":app=fixture\x1b\\");
  }
  if (pending === "#tui-on#") {
    pending = "";
    process.stdout.write("\x1b[?1049l\x1b[0m\x1b[2J\x1b[HMAIN 한글  A\x1b[?1049h\x1b[2J\x1b[H\x1b[36mALT 한글  A\x1b[?2004h\x1b[?25l");
  }
  if (pending === "#tui-off#") { pending = ""; process.stdout.write("\x1b[?1049l"); }
  if (pending === "#overflow#") {
    pending = "";
    process.stdout.write("x".repeat(850000) + "\x1b[2J\x1b[H\x1b[36mALT 한글  A\x1b[?25l");
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
