# Gemini Live Interpreter 🌐

Gemini Live Interpreter는 Google Gemini 3.5 Live API(WebSocket)를 활용하여 마이크 또는 시스템 오디오 입력을 실시간으로 받아쓰고(STT), 실시간 번역(Translate)하여 통역 음성(TTS)으로 출력해주는 실시간 양방향 오디오/텍스트 통역 웹 애플리케이션입니다.

---

## 🚀 주요 기능

*   **실시간 양방향 오디오 번역**: 웹소켓 프로토콜(`BidiGenerateContent`)을 사용하여 지연 시간을 최소화한 음성 번역을 처리합니다.
*   **다중 입력 소스 지원**:
    *   `🎙️ 내 마이크 모드`: 사용자의 마이크를 사용해 직접 말하는 목소리를 통역합니다.
    *   `🔊 시스템 사운드 모드`: 브라우저 탭 및 재생 중인 화면의 오디오 소스를 캡처하여 외국어 영상이나 미팅 소리를 실시간으로 통역합니다.
*   **대면 양방향 통역 모드 (Dual Mode)**:
    *   서로 다른 언어를 쓰는 두 화자(A와 B)의 말을 동시에 인지하여 실시간으로 교차 통역합니다.
    *   180도 회전 스플릿 뷰를 지원하여 마주 앉았을 때 상대방이 고개를 숙이거나 기기를 돌릴 필요 없이 자막을 정방향으로 읽을 수 있습니다.
*   **📞 영상통화 통역 모드 (Call Mode)**:
    *   텔레그램 등 메신저 영상통화 중에 상대방의 목소리와 내 목소리를 각각 독립된 파이프라인으로 실시간 양방향 통역합니다.
    *   수신 파이프라인(상대방 음성 캡처 → 내 언어 통역 및 헤드폰 출력 + 자막)과 송신 파이프라인(내 마이크 입력 → 상대 언어 통역 및 가상 오디오 케이블 출력 + 자막)을 1:1로 분리 처리합니다.
*   **자막 전용 모드 (Subtitle Only)**:
    *   더빙 음성 출력을 끄고 텍스트 자막으로만 실시간 통역 피드를 제공합니다. 원본 음성 소리와의 중첩 간섭을 피하고 싶을 때 유용합니다.
*   **안정적인 네트워크 복구 (Auto-Reconnect)**:
    *   일시적인 네트워크 지연이나 웹소켓 종료 시 최대 5회 점진적 백오프 방식으로 자동 재연결을 시도해 안정적인 사용성을 제공합니다.
*   **최적의 발화 감지(VAD) 설정**:
    *   짧은 침묵(200ms)이나 빠른 화자 전환도 유연하게 감지하여 턴을 신속히 이어붙여 대화를 부드럽게 이어 나갑니다.

---

## 🛠️ 시작하기 (로컬 실행 방법)

### 사전 준비
*   **Google AI Studio API Key**: [Google AI Studio](https://aistudio.google.com/)에서 API 키를 발급받아야 합니다.
*   **HuggingFace Token (선택)**: 단방향 화자 분할(PyAnnote Diarization)을 온전히 사용하려면 Hugging Face 토큰 및 권한이 필요합니다.

### 1. 백엔드 실행 (Gemini Live 프록시 및 화자 분할 서버)
백엔드는 브라우저의 Gemini Live 웹소켓 연결 프록시 및 로컬 화자 분할을 담당합니다.
```bash
# 가상환경 활성화 (필요시)
cd backend
source .venv/bin/activate  # 또는 로컬 python 환경

# .env 파일 생성 및 설정 (필요시 HF_TOKEN 입력)
# HF_TOKEN=hf_...

# Uvicorn 서버 실행 (포트 8000)
uvicorn main:app --reload --port 8000
```

### 2. 프론트엔드 실행
새 터미널에서 프론트엔드 Vite 개발 서버를 실행합니다.
```bash
# 프로젝트 루트 디렉토리
npm install
npm run dev
```
브라우저에서 `http://localhost:5173`으로 접속합니다.

---

## 📞 영상통화 통역 모드(Call Mode) 사용 가이드

### 전제 조건
*   **브라우저**: Google Chrome 141 이상 (macOS 14.2 이상 권장 - 창/화면 시스템 오디오 캡처 지원)
*   **가상 오디오 드라이버**: BlackHole (내 번역 음성을 텔레그램 마이크로 보내기 위한 가상 케이블)

### BlackHole 설치 및 오디오 라우팅 설정
1.  **BlackHole 설치**:
    *   [BlackHole 공식 사이트](https://existential.audio/blackhole/) 또는 Homebrew를 통해 설치합니다:
        ```bash
        brew install blackhole-2ch
        ```
2.  **웹 앱 설정**:
    *   통역 모드에서 `📞 영상통화 통역`을 선택합니다.
    *   `내 마이크 입력 장치`: 실제 사용하는 마이크/헤드셋 선택
    *   `수신 번역 출력 장치`: 내가 들을 헤드폰/이어폰 선택
    *   `송신 번역 출력 장치`: `BlackHole 2ch` 선택
3.  **텔레그램(데스크톱 앱) 마이크 설정**:
    *   텔레그램 설정 → `오디오 및 통화` → `마이크`를 **BlackHole 2ch**로 선택합니다.
    *   이제 내 통역된 상대 언어 목소리가 텔레그램을 통해 상대방에게 직접 전달됩니다.
4.  **통화 시작 및 시스템 오디오 캡처**:
    *   `실시간 통역 시작` 클릭 시 화면 공유 팝업이 나타납니다.
    *   **공유할 대상**: 텔레그램 **창(Window)** 또는 브라우저 **탭**을 선택합니다.
    *   ⚠️ **중요**: 화면 선택 시 반드시 **"시스템 오디오 공유(Share tab/system audio)"** 체크박스를 켜야 상대방의 음성이 캡처됩니다.

### ⚠️ 하울링(오디오 피드백 루프) 방지 주의사항
*   전체 화면(Entire Screen)을 공유할 경우, 웹 브라우저에서 재생되는 수신 번역 음성이 다시 캡처되어 상대방에게 에코로 되돌아갈 수 있습니다.
*   반드시 **텔레그램 '창'**만 선택해 공유하거나, 통화 설정에서 **'수신 번역 음성 재생'을 끄고 화면 자막만** 확인하세요.

---

## 🏗️ 아키텍처 및 핵심 파일 구조

*   [`src/App.tsx`](src/App.tsx): 단방향, 대면 양방향, 영상통화 3가지 모드의 파이프라인 수명주기 및 UI를 총괄합니다.
*   [`src/components/CallSettings.tsx`](src/components/CallSettings.tsx): 영상통화 모드 전용 오디오 입출력 장치 선택 및 하울링 방지 설정 패널입니다.
*   [`src/components/CallTranscriptView.tsx`](src/components/CallTranscriptView.tsx): 수신(상대 원문/내 언어 번역) 및 송신(내 원문/상대 언어 번역) 2분할 실시간 자막 뷰입니다.
*   [`src/utils/audioDevices.ts`](src/utils/audioDevices.ts): 시스템 오디오 입출력 장치 열거(`enumerateDevices`) 및 `devicechange` 이벤트 감지 유틸리티입니다.
*   [`src/utils/translationSession.ts`](src/utils/translationSession.ts): 백엔드 프록시 경유 Gemini Live 양방향 세션 관리 모듈입니다 (출력 장치 `setSinkId` 지원).
*   [`src/utils/audioRecorder.ts`](src/utils/audioRecorder.ts): 마이크 또는 시스템/화면 오디오를 16kHz PCM으로 변환하는 리샘플링 레코더입니다.
*   [`src/utils/audioPlayer.ts`](src/utils/audioPlayer.ts): 24kHz PCM 재생 및 `AudioContext.setSinkId` 기반 다중 출력 라우팅을 지원하는 오디오 플레이어입니다.
