# WinCMux (Windows cmux 대체) 상세 설계서

\---

# 0\. 개요

## 목적

Windows 환경에서 AI Agent CLI를 병렬 실행하고, 작업을 Workspace 단위로 관리하는 통합 개발 도구

## 핵심 철학

* 병렬성 (Parallel Agents)
* 격리 (Workspace Isolation)
* 관찰 가능성 (Observability)
* 자동화 가능성 (Automation First)

\---

# 1\. 시스템 아키텍처

## 1.1 전체 구조

WinUI Shell
├── Workspace Manager
├── Layout Engine
├── Notification System
├── Command Palette
└── Core Engine (Rust/C++)
├── Terminal Engine (ConPTY)
├── Process Supervisor (Job Object)
├── Browser Engine (WebView2)
├── Git Manager
├── Storage (SQLite)
└── Automation Server (IPC)

\---

# 2\. 핵심 도메인 모델

## 2.1 Workspace

* id
* name
* path
* backend
* branch
* dirty
* last\_active

\---

## 2.2 Session

* id
* workspace\_id
* pid
* status
* started\_at

\---

## 2.3 Notification

* id
* workspace\_id
* title
* body
* level
* created\_at

\---

# 3\. 기능 설계

## 3.1 Workspace 기능

* 생성
* rename
* pin
* reorder

## 3.2 Layout 시스템

* Pane
* Surface
* Panel

## 3.3 Terminal Engine

* ConPTY 기반

## 3.4 Process Supervisor

* Job Object

## 3.5 Browser Engine

* WebView2

## 3.6 Notification

* unread badge
* center

## 3.7 Git Integration

* worktree

\---

# 4\. API 설계

workspace.create
workspace.list
session.run
browser.open
notify.push

\---

# 5\. DB 설계

workspaces
sessions
notifications

\---

# 6\. 설정 구조

\[terminal]
shell = "pwsh"

\---

# 7\. 보안

* Credential Locker
* DPAPI

\---

# 8\. 배포

* MSIX
* winget

\---

# 9\. 로드맵

Phase1 Core
Phase2 Feature
Phase3 Deploy

\---

# 결론

Windows 기준 재설계가 핵심이다.

