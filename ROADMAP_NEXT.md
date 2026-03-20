# WinCMux 실행 계획 + 진행상황 (Electron)

## 완료
- `apps/desktop` + `packages/core` 모노레포 전환
- JSON-RPC 메서드 계약 유지 (`workspace.*`, `session.run`, `notify.*`, `layout.*`)
- named pipe 유지 (`\\.\\pipe\\wincmux-rpc`)
- SQLite + node-pty 기반 MVP 동작 구현

## 다음 우선순위
1. PTY output 스트리밍을 renderer pane에 실시간 연결
2. workspace rename/pin/reorder UI 조작 추가
3. 알림 센터 필터(레벨/워크스페이스)와 Jump-to-unread 추가
4. 포터블 exe smoke-test 자동화

## 단기 수용 기준
- `npm install && npm run dev`로 dotnet 없이 실행
- core 테스트/CI 통과
- 앱 종료 후 세션 누수 없음(표준 시나리오)
