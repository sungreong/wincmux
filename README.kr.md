# WinCMux

Windows에서 여러 AI CLI 에이전트를 동시에 돌리기 위한 터미널 워크스페이스 멀티플렉서입니다.

WinCMux는 Electron, Node.js, ConPTY, `node-pty`로 만들어졌습니다. Claude Code, OpenAI Codex 같은 CLI 에이전트를 여러 작업 폴더와 pane에서 나눠 실행하고, 세션 상태와 알림, 작업 문서 전달 흐름을 한 화면에서 다루는 데 초점을 둡니다.

[English README](README.md)

![WinCMux Screenshot](assets/view.png)

## 왜 만들었나

macOS/Linux에는 `tmux`, `cmux` 같은 도구가 있지만 Windows에서 AI CLI를 여러 개 안정적으로 나눠 다루는 경험은 부족합니다. WinCMux는 다음 흐름을 목표로 합니다.

- 워크스페이스별 터미널 pane 관리
- 작업 폴더, 레이아웃, 세션 상태 유지
- pane 분할, 이동, 숨김, 그룹화
- Claude/Codex 응답 완료 알림
- 워크스페이스 메모와 git 상태 확인
- agent 설정/지시 파일 점검
- 긴 텍스트와 이미지를 파일 자산으로 저장한 뒤 경로 기반으로 전달

## 빠른 시작

필요한 환경:

- Windows 11 x64
- Node.js 20 이상
- npm 10 이상

저장소 루트에서 실행합니다.

```bat
.\dev.bat
```

수동 실행:

```bash
npm install
npm run dev
```

패키지를 따로 실행해야 할 때:

```bash
npm --workspace @wincmux/core run dev
npm --workspace @wincmux/desktop run dev
```

## 주요 사용 흐름

상세 참고 문서:

- [기능 상세](docs/features.md)
- [아키텍처와 IPC 메모](docs/architecture.md)
- [Roadmap](ROADMAP_NEXT.md)

### Workspaces

왼쪽 사이드바에서 작업 폴더를 관리합니다. `Add workspace`는 접힌 폼으로 되어 있고, 필요할 때 펼쳐서 새 워크스페이스를 추가합니다.

워크스페이스 목록은 `Brief`와 `Detail` 모드를 지원합니다. 긴 경로는 한 줄로 말줄임 처리되고, 각 워크스페이스는 별도 메모를 가질 수 있습니다.

워크스페이스 정보 팝업에서 볼 수 있는 항목:

- 설명
- git 요약
- 긴 파일 스캔
- AI 세션 기록
- 실행 중인 PTY 세션
- Agent Assets
- Input Assets

### Panes

Pane은 터미널 세션이 붙는 화면 단위입니다.

- 오른쪽 분할: `Ctrl+Alt+\`
- 아래 분할: `Ctrl+Alt+-`
- 선택 pane 이동: `Ctrl+Alt+P`
- 선택 pane 숨김: `Ctrl+Alt+W`
- 선택 pane 닫기: `Ctrl+Alt+Q`
- 선택 pane 재시작: `Ctrl+Alt+R`
- 분할 비율 균등화: `Ctrl+Shift+E`

pane 이동은 레이아웃만 바꾸며, 연결된 터미널 세션은 재시작하지 않습니다.

### Pane Groups

모든 워크스페이스에는 `Default` 그룹이 있습니다. 그룹 바에서 새 그룹을 만들고, pane 헤더의 그룹 pill에서 pane을 다른 그룹으로 옮길 수 있습니다. `All`은 해당 워크스페이스의 모든 pane을 보여줍니다.

### Agent Assets

Agent Assets는 워크스페이스 안의 AI 도구 설정/지시 파일을 Explorer를 열지 않고 확인하는 기능입니다.

지원 대상:

- Claude
- Codex
- Gemini
- Cursor
- Kiro
- opencode
- Shared MCP assets

대표적으로 `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`, `.claude/skills`, `.kiro`, `.gemini`, `.opencode`, `.mcp.json` 등을 provider별로 모아서 보여줍니다.

일부 루트 지시 파일과 규칙 파일은 앱 안에서 수정할 수 있습니다. 설정 JSON, skills, subagents, 대부분의 생성 폴더는 안전을 위해 읽기 전용으로 다룹니다.

### Input Assets

Input Assets는 긴 붙여넣기나 이미지를 `.wincmux/input-assets` 아래에 저장하고, 터미널에는 파일 경로가 포함된 짧은 작업 지시문만 넣는 기능입니다.

지원 입력:

- 약 `2KB` 이상 또는 `20`줄 이상 긴 텍스트 붙여넣기
- 클립보드 이미지
- 이미지 파일 import

저장 위치:

- 텍스트: `.wincmux/input-assets/snippets/`
- 이미지: `.wincmux/input-assets/images/`

이미지 파일 import는 원본 확장자를 유지하고, 클립보드 이미지는 PNG로 저장합니다.

`Save + Insert`, `Insert`, `Copy`는 원문 전체나 이미지 바이너리를 pane에 넣지 않고 저장된 파일의 절대 경로를 포함한 작업 지시문을 사용합니다. `Path`는 파일 경로만 넣습니다.

텍스트 asset 삽입 형식:

```text
작업 문서 경로: C:\path\to\workspace\.wincmux\input-assets\snippets\<id>.md
위의 경로에 적힌 작업 문서로 작업 진행해줘
```

이미지 asset 삽입 형식:

```text
이미지 작업 문서 경로: C:\path\to\workspace\.wincmux\input-assets\images\<id>.png
위의 경로에 적힌 이미지 작업 문서로 작업 진행해줘
```

루트 `.wincmux/`는 저장소 `.gitignore`에 포함되어 있고, 각 워크스페이스의 `.wincmux/.gitignore`도 `input-assets/`를 무시합니다.

### Notifications

WinCMux는 Claude/Codex 터미널 출력에서 응답 완료 상태를 감지해 unread notification을 만듭니다. 알림은 워크스페이스별로 묶이고, 지원되는 환경에서는 Windows toast와 taskbar badge에도 반영됩니다.

## 저장소 구조

```text
WinCMux/
├── apps/desktop/      # Electron main, preload, renderer
├── packages/core/     # JSON-RPC core, SQLite, node-pty, layout/session engine
├── bridge/            # 프로토콜 문서와 schema
├── infra/             # 설정과 migration 참고 자료
├── scripts/           # 개발 보조 스크립트
├── assets/            # 스크린샷과 앱 assets
└── legacy-dotnet/     # 이전 .NET 구현 참고용
```

## 개발 확인 명령

push 전에 자주 쓰는 확인 명령입니다.

```bash
npm --workspace @wincmux/core run test -- --run
npm --workspace @wincmux/core run build
npm --workspace @wincmux/desktop run check:renderer
npm --workspace @wincmux/desktop run lint
npm run build
```

`check:renderer`의 line-count 경고는 참고용입니다. 문법 오류나 build 실패는 반드시 수정해야 합니다.

## 패키징

```bash
npm run package:win
```

## 런타임 경로

| 항목 | 기본 경로 |
|---|---|
| Database | `%APPDATA%\WinCMux\wincmux.db` |
| Logs | `%LOCALAPPDATA%\WinCMux\logs` |
| Named pipe | `\\.\pipe\wincmux-rpc` |

## Roadmap

[ROADMAP_NEXT.md](ROADMAP_NEXT.md)를 참고하세요.

## License

MIT
