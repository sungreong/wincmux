# Frontend design system — 0.2.1

## Audit

The previous stylesheet used 142 different hexadecimal colors, 12 corner-radius values (including geometric circles and pills), six gradients, and unrelated spacing values. Most controls, group filters and status badges used similar blue outlined capsules. Repeated pane IDs, automatic-save notes and protocol status text competed with terminal output.

The screen's purpose is to select a project, operate terminals and notice work requiring input. The 0.2.1 design keeps the dark terminal workspace and existing shortcuts while reducing decorative emphasis.

## Tokens

`renderer/design-tokens.css` owns the palette, surfaces, text, borders, focus, typography, spacing and radii. `styles.css` consumes semantic names; older `--bg`, `--panel`, `--text` aliases remain for compatibility. Terminal foreground/background are resolved from those same tokens. ANSI output colors and user-selected group colors remain program/user data.

Spacing uses 4, 8, 12, 16, 20, 24 and 32px steps. Font sizes, one-pixel borders, caret geometry and resize hit areas are not spacing. Component radii use 4px controls, 8px containers and 12px dialogs. Tight nested controls use `--radius-inset = --radius-container - --space-1`. Circular markers and numeric counters use dedicated geometry tokens. Continuous corners are not required; regular radii keep WebView2 rendering predictable.

## Component rules

| Component | Do | Don't |
|---|---|---|
| Primary button | Emphasize Send and Create inside their local tasks | Give every toolbar action a filled accent |
| Toolbar action | Use a quiet button with a concise tooltip | Repeat Show/Hide text and resize the toolbar on toggling |
| Group filter | Expose `aria-pressed`, selection and a small category-color marker | Make every group look like a prominent status pill |
| Status | Use noninteractive text for working, blocked and idle | Render inert status as a disabled button |
| Result acknowledgement | Use a real button only when there is a result to acknowledge | Make every status appear actionable |
| Notification | Make the full row a keyboard-operable button with context | Use an inaccessible clickable list item or repeat protocol internals |
| Destructive command | Keep full shutdown quiet and separated; confirm before ending jobs | Put it first among routine workspace actions |
| Input | Keep meaningful labels and task-specific errors | Advertise Korean support or automatic saving in permanent helper text |

Expanded terminal input keeps optional instructions in a collapsed disclosure. Workspace names are keyboard-operable buttons; secondary actions appear on hover or focus so titles have room. Dialogs retain instructions needed for a decision. Automatic saving, identifiers and shortcuts move to tooltips when the page already explains their purpose. The inline composer is attached to the selected pane, so a duplicate pane-ID caption is hidden. No marketing copy is introduced.

## Validation

최종 0.2.1 실행 파일에서 1440×860 일반 화면, 1100×760 좁은 화면, 확장 입력창을 캡처했다. 워크스페이스 제목 표시, 버튼 의미, 필터 `aria-pressed`, 기본 접힌 도움말, 좁은 패널의 상태·도구 버튼 겹침 방지를 자동 검증했다. 좁은 패널에서 긴 상태 문구는 말줄임하고 전체 의미는 접근 가능한 이름과 툴팁으로 유지한다.

- `npm run lint`: JS 구문·Rust 포맷 통과. 기존 대형 JS 파일 세 개의 줄 수 경고는 남아 있다.
- `npm test`: Rust 18개와 JS 어댑터 2개 통과.
- `npm run test:ui`: 한글·연속 공백·여러 줄·복사·패널별 초안·분할·확장 입력창·워크스페이스 전환·18,000줄 출력·상태 확인 및 오래된 확인 요청 보호 통과.
- `npm run test:runtime`: 실제 프로세스 통합 테스트 3개 통과.
- `npm run test:lifecycle`: 최종 0.2.1에서 정상·강제 종료 후 같은 코어·작업 PID, WebView2 종료, 숨긴 세션, 알림 이동, 미확인 결과, 원시 출력 범위를 넘긴 정상·대체 화면 및 붙여넣기 모드 복원 통과. 테스트 터미널 6개를 유지한 화면 종료 후 코어는 7.79MiB였으며 CLI는 제외했다.
- `npm run test:ui -- --screenshots`: 최종 내장 CSS/HTML로 일반·좁은 화면·입력창 검증 통과. 소스 CSS 주입 없이 실행했다.
- 색 대비: 패널 위 주요 텍스트 14.31:1, 보조 텍스트 8.07:1, 3차 텍스트 4.79:1, 주요 버튼 글자 8.76:1.
- 프런트 변경 후 UI 회귀 실행 1회의 입력 왕복 P95는 1개 패널 13.8ms, 6개 14.2ms였다. 메모리는 각각 351.44/411.16MiB, CLI는 별도 15.68/93.92MiB였다. 이 1회 값은 [코어 분리 전후 3회 비교](background-core-evaluation.md)와 다른 표본이다.

스크린샷: [일반 화면](../assets/view.png), [좁은 화면](../assets/view-compact.png), [확장 입력창](../assets/prompt-editor.png). 네이티브 키보드 IME의 체감 품질과 실제 AI 응답 지연은 이 자동 테스트로 보장하지 않는다.

## Reference semantics

The component review follows Microsoft's Fluent 2 guidance for [design tokens](https://fluent2.microsoft.design/design-tokens), [buttons](https://fluent2.microsoft.design/components/web/react/core/button/usage) and [badges](https://fluent2.microsoft.design/components/web/react/core/badge/usage). Tokens store reusable style decisions; actions use buttons, and status uses badges/text. The existing vanilla-JavaScript renderer implements these roles without adding a component framework.
