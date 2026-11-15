# 참고 자료와 적용 범위

사용자가 제안한 제품 사례와 디자인 지침, 구현에 사용한 공식 문서를 정리한다. 제품의 아이디어를 참고한 부분과 실제 포함된 라이브러리를 구분한다.

## 제품 관점: Herdr

[Dale Seo — Herdr, AI 코딩 에이전트를 위한 터미널 멀티플렉서](https://daleseo.com/herdr/)에서 여러 에이전트의 작업·승인 대기 상태를 모아 보고, 클라이언트를 닫아도 백그라운드에서 프로세스를 유지하는 사용 흐름을 참고했다.

WinCMux에는 패널·워크스페이스 상태 요약, 미확인 완료 결과, 화면과 실행 코어의 독립 수명으로 적용했다. Windows ConPTY·named pipe·SQLite·네이티브 트레이에 맞춰 구현했다. Herdr의 원격 접속·에이전트 위임 CLI·워크트리 흐름 전체를 제공하는 것은 아니다. 이 문서는 Herdr 소스 코드 포함이나 해당 제품과의 제휴를 의미하지 않는다.

## 화면 디자인: 사용자 제공 5가지 기준과 Fluent 2

사용자가 제공한 기준은 디자인 토큰, 시나리오에 맞는 컴포넌트, 공통 모서리, 4의 배수 간격, 불필요한 UX 문구 제거다. 해당 기준의 원문 게시자나 링크는 제공되지 않아 별도의 출처를 추정하지 않았다.

| 자료 | 반영한 내용 |
|---|---|
| [Fluent 2 — Design tokens](https://fluent2.microsoft.design/design-tokens) | 색상·표면·글꼴·간격·모서리를 공통 변수로 관리 |
| [Fluent 2 — Button](https://fluent2.microsoft.design/components/web/react/core/button/usage) | 실제 행동에 버튼 사용, 주요 행동과 보조 행동의 강조 구분 |
| [Fluent 2 — Badge](https://fluent2.microsoft.design/components/web/react/core/badge/usage) | 읽기용 상태와 결과 확인 행동 구분 |

Fluent UI 패키지를 새로 설치한 것이 아니라 기존 HTML·CSS·JavaScript 컴포넌트의 의미와 사용 규칙을 정리했다. [점검 결과·Do/Don't·검증](ui-design.md)

## 실행 코어·설치·화면 복원

| 자료 | 적용 범위 |
|---|---|
| [Tauri — Embedding External Binaries](https://v2.tauri.app/develop/sidecar/) | UI와 같은 버전의 코어 실행 파일을 설치 패키지에 포함. 실행 수명은 UI와 독립 관리 |
| [Tauri — Extending the Installer](https://v2.tauri.app/distribute/windows-installer/#extending-the-installer) | NSIS hook에서 실행 중인 터미널 확인과 업데이트 준비 절차 수행 |
| [vt100 0.18.1 — Screen API](https://docs.rs/vt100/0.18.1/vt100/struct.Screen.html) | 화면·커서·입력 모드 해석과 스냅샷 어댑터 구현 |
| [고정한 vt100 소스의 변경 설명](../apps/desktop-tauri/src-tauri/vendor/vt100-0.18.1/WINCMUX.md) · [MIT 라이선스](../apps/desktop-tauri/src-tauri/vendor/vt100-0.18.1/LICENSE) | 실제 포함된 라이브러리와 정상·대체 화면을 함께 복원하기 위한 확장 고지 |

라이브러리의 기능만으로 xterm.js와의 완전한 호환성을 가정하지 않는다. 한글·공백·색상·커서·대체 화면·붙여넣기 모드와 출력 버퍼 초과 후 재연결은 프로젝트 테스트로 별도 확인한다. [구조](architecture.md) · [코어 평가](background-core-evaluation.md)
