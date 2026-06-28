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
    *   에코 캔슬링 튜닝을 통해 통역 음성이 다시 마이크로 입력되어 발생하는 오디오 하울링 루프를 원천 방지합니다.
*   **180도 회전 스플릿 뷰**:
    *   대면 통역 시, 상대방 방향의 자막 패널이 180도 회전되어 출력됩니다. 기기를 가운데에 두고 마주 앉았을 때 상대방이 고개를 숙이거나 기기를 돌릴 필요 없이 자막을 정방향으로 읽을 수 있습니다.
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

### 설치 및 실행
1.  의존성 패키지를 설치합니다.
    ```bash
    npm install
    ```
2.  로컬 개발 서버를 실행합니다.
    ```bash
    npm run dev
    ```
3.  브라우저에서 `http://localhost:5173`으로 접속합니다.
4.  화면 상단 설정 패널에 발급받은 **API Key**를 입력합니다.
5.  통역 모드(단방향/대면 양방향), 대상 언어, 입력 소스를 설정한 뒤 **실시간 통역 시작** 버튼을 누릅니다.

---

## 🏗️ 아키텍처 및 핵심 파일 구조

*   [`src/App.tsx`](file:///Users/leeseungjun/coding/AI%20%ED%95%99%EC%8A%B5%20%EC%8B%A4%EC%8A%B5/%EB%B2%88%EC%97%AD%EB%B4%87/src/App.tsx): 단방향 및 대면 양방향 스플릿 자막 뷰 UI를 관리하고 오디오 캡처를 제어합니다.
*   [`src/utils/translationSession.ts`](file:///Users/leeseungjun/coding/AI%20%ED%95%99%EC%8A%B5%20%EC%8B%A4%EC%8A%B5/%EB%B2%88%EC%97%AD%EB%B4%87/src/utils/translationSession.ts): 개별 실시간 웹소켓 세션을 담당하는 캡슐화 모듈입니다.
*   [`src/utils/audioRecorder.ts`](file:///Users/leeseungjun/coding/AI%20%ED%95%99%EC%8A%B5%20%EC%8B%A4%EC%8A%B5/%EB%B2%88%EC%97%AD%EB%B4%87/src/utils/audioRecorder.ts): 브라우저 MediaDevices API를 활용하여 마이크 또는 시스템 사운드를 16kHz PCM 포맷으로 녹음 및 전송합니다.
*   [`src/utils/audioPlayer.ts`](file:///Users/leeseungjun/coding/AI%20%ED%95%99%EC%8A%B5%20%EC%8B%A4%EC%8A%B5/%EB%B2%88%EC%97%AD%EB%B4%87/src/utils/audioPlayer.ts): 실시간으로 수신한 오디오 바이너리 청크들을 디코딩하여 매끄럽게 스트리밍 재생합니다.
