# Electron → Tauri 전환 평가

WinCMux Tauri 0.1.1은 기존 터미널 화면과 단축키를 이어받고, 데스크톱 호스트를 WebView2와 Tauri로, 세션 및 저장 코어를 Rust로 옮겼습니다.

## 측정 결과

| 측정 | Electron + Node | Tauri + Rust |
|---|---:|---:|
| Windows x64 설치 파일 | 95.61 MiB | 3.66 MiB |
| pane 1개 앱 메모리 | 357.74–370.00 MiB | 304.98–307.71 MiB |
| pane 6개 앱 메모리 | 490.97–503.57 MiB | 390.68–391.36 MiB |
| pane 1개 입력 왕복 P95 | 16.1 ms | 10.6–12.3 ms |
| pane 6개 입력 왕복 P95 | 16.0–16.3 ms | 10.1–11.3 ms |
| pane 6개, 18,000줄 표시 완료 | 4,993–5,002 ms | 320–337 ms |

두 구현을 같은 Windows PC의 숨김 테스트 창에서 각각 두 번 실행했습니다. 메모리는 출력 종료 2.5초 후 앱·렌더러·코어의 전용 커밋 메모리 합계이며 테스트 CLI는 제외했습니다. 입력 왕복은 선택된 pane에 짧은 명령 30회를 보내고 xterm이 응답을 파싱하기까지 측정했습니다. 연속 출력 시간은 숨김 창의 프레임 스케줄링에도 영향을 받습니다.

## 확인한 동작과 평가

- **입력 정확도.** 입력창은 조합 중 삽입을 보류했습니다. 조합을 마친 뒤 한글·영문·연속 공백을 실제 ConPTY로 전달했습니다.
- **출력 정확도.** 두 구현 모두 6개 pane의 총 18,000줄이 원문과 일치했습니다. Tauri는 워크스페이스를 떠났다가 돌아온 경우에도 출력이 이어졌습니다. 세션 보관 범위를 넘기면 생략을 표시합니다.
- **복사.** WebView2에서 테스트 URL을 Ctrl+C, 브라우저 복사 이벤트, 컨텍스트 메뉴로 복사했습니다. 일반 여러 줄 텍스트의 공백과 줄바꿈도 확인했습니다.
- **메모리와 배포.** pane 6개 기준 앱 메모리는 약 20–22% 낮았습니다. 설치 파일은 시스템 WebView2를 사용하며 Tauri 코어는 Node 런타임이 필요 없습니다.

Rust 테스트 7개와 JS 브리지 테스트 2개, Windows UI 테스트를 실행했습니다. Codex와 Claude는 ConPTY에서 버전 명령으로 실행을 확인했습니다. 실제 Windows 키보드 IME 감각과 로그인한 AI의 응답 생성 시간은 수치에 포함되지 않습니다.

## 재현

```powershell
npm ci
npm run lint
npm test
npm run package:win
npm run test:ui
npm run test:ui -- --screenshots
```

마지막 명령은 실제 앱에 격리된 예제 워크스페이스를 열고 `assets/view.png`와 `assets/prompt-editor.png`를 갱신합니다.
