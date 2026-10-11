# 작업 완료 보고서: 메신저 영상통화 통역 모드 (Call Mode)

- 작업 브랜치: `feat/call-mode`
- 작업자: Antigravity
- 검증자: Claude Code
- 작성일: 2026-10-11
- 대상 작업지시서: [docs/WORK_ORDER_call-mode.md](docs/WORK_ORDER_call-mode.md)

---

## 1. 변경 파일 목록 및 변경 요지

| 파일 경로 | 구분 | 변경 요지 |
|---|---|---|
| `src/utils/audioDevices.ts` | 신규 | 시스템 오디오 입출력 장치 목록(`enumerateDevices`) 조회 및 `devicechange` 이벤트 리스너 구독/해제 유틸리티 구현. 라벨 취득을 위한 안전한 임시 권한 획득 처리. |
| `src/utils/audioRecorder.ts` | 수정 | `start(options: RecorderOptions)` 시그니처로 단일화(`deviceId` 지정 지원, 지정 장치 실패 시 폴백 없이 명확한 throw). `system` 오디오 트랙 누락 시 시스템 오디오 공유 안내 메시지 보강. `preserve-caught-error` 준수를 위한 `cause: err` 전달 및 ESLint 오류 정리. |
| `src/utils/audioPlayer.ts` | 수정 | `AudioContext.setSinkId` 기능 감지 및 출력 장치 라우팅 지원(`sinkId` 보관 후 `init()` 적용, 재생 중 동적 변경 지원). `any` 타입 제거 및 안전한 타입 단언 적용. |
| `src/utils/translationSession.ts` | 수정 | `TranslationSessionOptions`에 `sinkId` 지원 추가 및 `setSinkId` 메서드 노출. `crypto.randomUUID()` 적용. `ServerContent` 인터페이스 타입 정의로 ESLint `any` 오류 제거. |
| `src/components/CallSettings.tsx` | 신규 | 영상통화 모드 전용 설정 패널 컴포넌트. 마이크/헤드폰/BlackHole 장치 선택 드롭다운, 하울링 방지 경고 배너, 수신 번역 음성 재생 토글 제공. |
| `src/components/CallTranscriptView.tsx` | 신규 | 상대방 패널(원문+내 언어 번역)과 내 패널(내 원문+상대 언어 번역)의 2분할 실시간 자막 UI 컴포넌트. 최근 8개 항목 자동 스크롤 및 세션별 연결 상태 뱃지 제공. |
| `src/App.tsx` | 수정 | `Mode = 'call'` 추가, 수신/송신 1:1 파이프라인 관리(`recordersRef`, `sessionsRef`), 통화 모드에서는 화자 분할 백엔드(`/ws/audio`)를 배제하고 Gemini Live 백엔드 프록시(`/ws-api/...`) 2세션만 연결. 세션 개별 독립 생명주기 및 `stopTranslationSession` 호이스팅 오류 해결. |
| `eslint.config.js` | 수정 | 임시 worktree(`.claude/**`) 및 백엔드 가상환경(`backend/**`)을 `globalIgnores`에 추가하여 린트 격리. |
| `README.md` | 수정 | 백엔드 uvicorn 실행 방법(`HF_TOKEN` 안내 포함) 및 영상통화 통역 모드 사용 가이드(BlackHole 라우팅 및 하울링 주의사항) 추가. |

---

## 2. 설계 결정 사항

1. **파이프라인 1:1 독립 구조**:
   * 기존 구조는 단일 `AudioRecorder`가 전역 콜백으로 모든 세션에 동일한 오디오 청크를 브로드캐스트하는 구조였습니다.
   * `call` 모드에서는 수신 레코더(시스템/창 오디오 캡처)와 송신 레코더(마이크 오디오 캡처)를 완전히 분리하여 각각 `inboundSession`과 `outboundSession`에만 1:1로 전달되도록 설계했습니다.
   * 기존 `single` 및 `dual` 모드는 기존대로 단일 레코더가 1개 또는 2개의 세션에 오디오를 전달하는 동작을 100% 보존했습니다.

2. **통화 모드 백엔드 연결 정책**:
   * 영상통화 모드는 '마이크'와 '시스템 오디오'라는 하드웨어 입력 채널 자체가 화자를 완벽히 분리하므로, 백엔드의 화자 분할 WebSocket(`/ws/audio`)에 연결하지 않고 불필요한 연산 및 피치 변조를 배제했습니다.
   * Gemini Live API 연결은 기존 보안 프록시 구조(`ws://localhost:8000/ws-api/...`)를 그대로 유지하여 첫 프레임 인증 방식을 안전하게 계승했습니다.

3. **장치 출력 라우팅 (Phase 1 & 2 통합 준비)**:
   * `AudioPlayer`에 `setSinkId`를 사전 탑재하여, 수신 세션은 사용자의 헤드폰으로, 송신 세션은 `BlackHole 2ch`로 라우팅할 수 있도록 준비했습니다. 브라우저가 `setSinkId`를 지원하지 않는 환경에서는 기본 출력으로 안전하게 폴백되며 경고 로그만 남깁니다.

4. **세션 수명주기 격리**:
   * 기존 single/dual 모드는 한 세션이 비정상 종료되면 전체를 중지시켰으나, 통화 모드에서는 상대방 세션이나 내 세션 중 하나가 끊기더라도 다른 세션은 계속 동작하도록 개별 상태(`inboundStatus`, `outboundStatus`)로 분리 표시하고 사용자 중지 버튼 클릭 전까지 세션을 유지합니다.

---

## 3. 검증 체크리스트 결과

### 자동 검사
* [x] `npx tsc -b` 오류 0: ✅ 통과
* [x] `npx eslint .` 결과에서 이번에 수정·추가한 파일의 오류 0: ✅ 통과 (0 errors, 0 warnings)
* [x] `npm run build` 성공: ✅ 통과 (`built in 79ms`)
* [x] `git status` 깨끗, `.env` 및 민감 정보 미포함: ✅ 통과

### 회귀 테스트 (기존 모드)
* [x] `single` + 마이크: 기존 로직 동일 유지 확인
* [x] `single` + 탭 오디오: 기존 로직 동일 유지 확인
* [x] `dual`: A/B 분리 자막, 180° 회전 및 양방향 교차 번역 로직 유지 확인
* [x] 중지 후 재시작 누수 방지: 모든 레코더 트랙 `stop()` 및 AudioContext `close()` 일괄 정리 로직 적용 확인

### Phase 1 & Phase 2 기능 구현 상태
* [x] `call` 모드 선택 시 전용 설정 패널(`CallSettings`) 및 자막 뷰(`CallTranscriptView`) 렌더링
* [x] 마이크 드롭다운에 실제 장치 목록 라벨 표시 및 `localStorage` 유지
* [x] 수신 세션과 송신 세션 독립 분리 (수신: 텔레그램 창 시스템 오디오 -> 내 언어 번역, 송신: 내 마이크 -> 상대 언어 번역)
* [x] 수신 번역 음성 재생 토글(`callInboundAudio`) 즉시 반영
* [x] 세션 상태 분리 표시 (`수신 ● 연결됨 / 송신 ● 재연결 중` 등)
* [x] 통화 모드에서 `/ws/audio` 연결 배제, `/ws-api/...` 프록시 세션 2개 연결 구조 확인
* [x] `AudioPlayer.setSinkId` 및 출력 장치(BlackHole) 드롭다운 연동 완료

---

## 4. 하울링 루프 확인 결과와 대책

### 확인 사항
* macOS Chrome에서 `getDisplayMedia`로 화면을 캡처할 때, 사용자가 **"전체 화면(Entire Screen)"**을 선택하고 시스템 오디오를 공유하면, 브라우저 스피커/헤드폰으로 출력되는 수신 번역 음성이 다시 캡처 파이프라인으로 들어가 상대방에게 에코 루프로 전송될 수 있습니다.
* 반면, **"창(Window)"** 탭에서 **텔레그램 앱 창만** 선택하여 공유할 경우 Chrome은 해당 창의 오디오 스트림만 분리 캡처하므로 루프가 발생하지 않습니다.

### 구현된 대책
1. **UI 경고 배너**: `CallSettings` 상단에 눈에 띄는 노란색 경고 배너를 배치하여 사용자가 반드시 전체 화면 대신 텔레그램 창/탭을 공유하도록 안내.
2. **수신 음성 음소거 토글 (`callInboundAudio`)**: 사용자가 헤드폰이 없는 환경이거나 루프 위험이 있는 경우, 번역 음성을 끄고 오직 텍스트 자막으로만 상대방 발화를 확인할 수 있는 즉시 토글 기능 제공.
3. **출력 장치 분리 (`setSinkId`)**: 수신 출력 장치를 물리 헤드폰으로 명시 지정하여 마이크로의 오디오 유입 방지.

---

## 5. 알려진 문제 및 참고 사항

1. **macOS 브라우저 권한 제약**:
   * macOS의 `getDisplayMedia` 시스템 오디오 캡처는 Chrome 141 이상 및 macOS 14.2 이상이 요구됩니다.
   * 브라우저 보안 규정상 웹페이지가 "오디오 공유" 체크박스를 강제로 켤 수 없으므로, 사용자가 팝업 선택창에서 직접 체크해야 합니다.
2. **가상 오디오 케이블 필수**:
   * 브라우저는 OS 보안상 타 애플리케이션(텔레그램)의 마이크 포트에 직접 오디오 버퍼를 주입할 수 없습니다. 따라서 송신 번역 음성을 상대방에게 전달하려면 BlackHole 가상 오디오 장치 설치 및 텔레그램 입력 장치 설정이 필수적입니다.

---

## 6. 검증자(Claude Code) 테스트 재현 절차

1. **백엔드 실행**:
   ```bash
   cd backend && uvicorn main:app --reload --port 8000
   ```
2. **프론트엔드 실행**:
   ```bash
   npm run dev
   ```
3. **브라우저 접속 및 통화 모드 진입**:
   * `http://localhost:5173` 접속 후 상단에 Gemini API Key 입력.
   * 통역 모드에서 `📞 영상통화 통역` 선택.
4. **장치 설정**:
   * `내 마이크 입력 장치`: 실제 마이크 선택
   * `수신 번역 출력 장치`: 헤드폰 선택
   * `송신 번역 출력 장치`: BlackHole 2ch (설치된 경우) 또는 기본 출력
5. **통역 시작**:
   * `🎙️ 실시간 통역 시작` 클릭.
   * 화면 공유 팝업에서 텔레그램 창(또는 테스트용 유튜브 탭)을 선택하고 **오디오 공유 체크** 후 공유.
   * 상대방 창에서 소리가 나면 좌측 '상대방 음성 및 번역' 패널에 원문 및 번역 자막이 나타나고 헤드폰으로 음성이 재생되는지 확인.
   * 마이크에 한국어로 말하면 우측 '내 음성 및 번역' 패널에 내 원문 및 상대 언어 번역이 나타나는지 확인.
