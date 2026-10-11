# 작업지시서: 메신저 영상통화 통역 모드(Call Mode) 추가

- 대상 프로젝트: Gemini Live Interpreter (이 저장소)
- 작업자: Antigravity
- 검증자: Claude Code (완료 기준 섹션 기준으로 검증)
- 작업 브랜치: `feat/call-mode` (main에서 분기, main 직접 커밋 금지)
- 작성일: 2026-10-11

---

## 1. 배경과 목표

현재 앱은 유튜브 탭 오디오를 캡처해 단방향 통역하는 용도로만 제한적으로 쓰이고 있다.
이를 **텔레그램 영상통화(1:1)** 중에 양방향 통역 도구로 쓸 수 있게 확장한다.

통화 통역은 입력과 출력이 서로 다른 두 파이프라인으로 구성된다.

| 방향 | 입력 | Gemini 세션 | 출력 |
|---|---|---|---|
| 수신 (상대 → 나) | 시스템/탭 오디오 캡처 | target = 내 언어 | 내 헤드폰 + 화면 자막 |
| 송신 (나 → 상대) | 내 마이크 | target = 상대 언어 | 가상 오디오 장치(BlackHole) → 텔레그램 마이크 |

기존 코드는 레코더 1개의 소리를 모든 세션에 동일하게 뿌리는 구조(`src/App.tsx` 의 `AudioRecorder` 콜백)라서,
**세션별로 입력 소스와 출력 장치를 따로 지정할 수 있는 구조로 바꾸는 것**이 이번 작업의 핵심이다.

## 2. 전제 조건 (변경하지 말 것)

- 개인 사용 목적이다. 배포용 구조(백엔드 중계, 키 서버 보관 등)는 이번 범위에 넣지 않는다.
- 실행 환경: macOS 26, Chrome 141 이상, `npm run dev` 로 실행하는 Vite 개발 서버. Vite 프록시(`/ws-api`) 구조는 유지한다.
- 기존 `single`(영상·마이크 단방향), `dual`(대면 양방향) 모드는 **동작이 바뀌면 안 된다.**
- Gemini 모델명, setup 메시지 구조(`translationConfig`, VAD 설정 등)는 건드리지 않는다.
- `backend/` 는 이번 작업에서 수정하지 않는다. 단, 통화 모드에서는 백엔드(`ws://localhost:8000/ws/audio`)에 연결하지 않는다 (아래 4.5 참조).
- `.env`, API 키, HF 토큰 등 민감 정보는 절대 커밋하지 않는다.

## 3. 작업 범위

### Phase 1: 수신 방향 + 통화 모드 골격 (이번 지시의 필수 범위)

1. `call` 모드 추가 및 설정 UI
2. 레코더/세션을 1:1로 묶는 구조로 리팩터링 (레코더 N개, 세션 N개)
3. 입력 장치(마이크) 선택 기능
4. 수신 세션: 시스템/탭 오디오 → 내 언어 번역 → 헤드폰 재생 + 자막
5. 송신 세션도 **생성은 하되** 출력은 Phase 2 전까지 로컬 기본 출력 장치로 재생 (동작 확인용)

### Phase 2: 송신 방향 완성 (Phase 1 검증 통과 후 진행)

1. `AudioPlayer` 에 출력 장치 지정(`AudioContext.setSinkId`) 추가
2. 출력 장치 선택 UI 2개 (수신 번역 출력 장치 / 송신 번역 출력 장치)
3. 송신 세션 출력을 BlackHole로 라우팅
4. README에 BlackHole 설치 및 텔레그램 마이크 설정 가이드 추가

### 범위 밖

- 모바일 텔레그램, 그룹 통화, MTProto 봇 참여 방식
- 화자 분할 백엔드 개선
- 기존 ESLint 오류 전체 정리 (단, 이번에 수정하는 파일의 기존 오류는 함께 고친다)

## 4. 상세 요구사항

### 4.1 `src/utils/audioRecorder.ts`

- `start(source)` 시그니처를 옵션 객체로 확장한다.
  ```ts
  interface RecorderOptions {
    source: 'mic' | 'system';
    deviceId?: string;          // source === 'mic' 일 때 getUserMedia 의 deviceId: { exact }
  }
  start(options: RecorderOptions): Promise<void>
  ```
  기존 호출부(`start('mic')`, `start(source)`)는 새 시그니처로 모두 수정한다. 문자열 오버로드를 남겨 두지 않는다.
- `deviceId` 가 주어졌는데 해당 장치 획득에 실패하면 기본 장치로 폴백하지 말고 **명확한 에러 메시지로 throw** 한다. (사용자가 잘못된 장치를 모르고 쓰는 상황 방지)
- `system` 소스일 때 `getDisplayMedia` 호출은 그대로 두되, 오디오 트랙이 없을 때의 에러 메시지에 "텔레그램 창/전체 화면을 공유할 때 '시스템 오디오 공유'를 체크" 안내를 추가한다.
- 이 파일의 기존 ESLint 오류(`any`, `preserve-caught-error`, `prefer-const`)를 함께 정리한다.
- `ScriptProcessorNode` → `AudioWorklet` 전환은 **선택 사항**이다. 하면 좋지만 이번 필수 범위는 아니다. 전환하지 않아도 된다.

### 4.2 `src/utils/audioPlayer.ts` (Phase 2)

- 생성자 또는 `init()` 에 `sinkId?: string` 옵션을 추가한다.
- `setSinkId(deviceId: string): Promise<void>` 메서드를 추가한다.
  - `'setSinkId' in AudioContext.prototype` 으로 기능 감지. 미지원이면 경고 로그 후 무시(throw 금지).
  - `AudioContext` 가 아직 없으면 값을 저장해 두었다가 `init()` 시 적용한다.
  - 이미 재생 중이어도 호출 가능해야 한다.
- 샘플레이트 24000 고정 `AudioContext` 와 `setSinkId` 조합이 BlackHole에서 동작하는지 확인하고, 안 되면 원인을 보고서에 기록한다.

### 4.3 `src/utils/translationSession.ts`

- `TranslationSessionOptions` 에 `sinkId?: string` 추가. `connect()` 에서 `player` 에 전달한다. (Phase 2)
- `setSinkId(deviceId)` 를 세션에서도 노출해 진행 중 변경이 가능하게 한다. (Phase 2)
- 기존 ESLint 오류(`any`)를 정리한다. `handleServerContent` 의 `content` 는 최소한의 인터페이스 타입을 정의한다.
- `randomId` 의 `substr` 은 `crypto.randomUUID()` 로 교체한다.

### 4.4 신규 `src/utils/audioDevices.ts`

- `listAudioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>`
  - 라벨을 얻기 위해 마이크 권한이 `prompt` 상태면 `getUserMedia({audio:true})` 로 먼저 권한을 받고 즉시 트랙을 정지한다.
  - `navigator.mediaDevices.enumerateDevices()` 결과를 `audioinput` / `audiooutput` 으로 나눈다.
- `onDeviceChange(cb)` : `devicechange` 이벤트 구독/해제 함수를 반환한다.

### 4.5 `src/App.tsx`

**모드 추가**
- `type Mode = 'single' | 'dual' | 'call'` 로 확장하고 모드 토글에 `📞 영상통화 통역` 버튼을 추가한다.

**통화 모드 설정 상태 (localStorage 에 저장, 키 접두사 `GEMINI_LIVE_CALL_`)**
- `callMyLang`, `callRemoteLang` (기본 ko / en)
- `callMicDeviceId` (기본 '' = 시스템 기본)
- `callInboundSinkId`, `callOutboundSinkId` (Phase 2, 기본 '')
- `callInboundAudio: boolean` (수신 번역 음성 재생 여부. 기본 true. false면 자막만)

**파이프라인 구조 리팩터링**
- 레코더와 세션을 묶는 단위를 도입한다. 예:
  ```ts
  interface Pipeline {
    id: 'inbound' | 'outbound' | 'single' | 'dualA' | 'dualB' ...;
    recorder?: AudioRecorder;        // 공유 가능 (dual 은 레코더 1개를 두 세션이 공유)
    sessions: TranslationSession[];
  }
  ```
  구체적 형태는 자유지만 다음은 반드시 만족해야 한다.
  - 레코더 콜백은 **자기에게 연결된 세션에만** 청크를 전달한다.
  - `single`/`dual` 모드의 동작은 리팩터링 전과 동일해야 한다.
  - 중지 시 모든 레코더와 세션이 빠짐없이 정리된다 (하나가 실패해도 나머지 정리 진행).

**통화 모드 시작 시퀀스**
1. 유효성 검사: `callMyLang !== callRemoteLang`
2. 수신 레코더 `start({ source: 'system' })` → 사용자가 텔레그램 창/탭/전체 화면 선택. 오디오 트랙 없으면 중단하고 안내.
3. 송신 레코더 `start({ source: 'mic', deviceId: callMicDeviceId })`
4. 수신 세션: `{ targetLang: callMyLang, echoTargetLanguage: false, emitInputTranscript: true, autoReconnect: true, volume: callInboundAudio ? outputVolume : 0, voiceName }`
5. 송신 세션: `{ targetLang: callRemoteLang, echoTargetLanguage: false, emitInputTranscript: true, autoReconnect: true, volume: outputVolume, voiceName }`
   - Phase 1에서는 출력 장치 미지정(기본 출력). Phase 2에서 `sinkId: callOutboundSinkId`.
6. 통화 모드에서는 **백엔드 WebSocket(`localhost:8000`)에 연결하지 않는다.** (채널 자체가 화자를 구분하므로 불필요. 연결 실패 로그가 콘솔을 오염시키는 것도 방지)

**통화 모드 자막 UI**
- 좌우 또는 상하 2분할. 180° 회전은 하지 않는다.
- 상대 패널: 수신 세션의 `input`(상대 원문) + `output`(내 언어 번역). 번역을 크게, 원문을 작게.
- 내 패널: 송신 세션의 `input`(내 원문) + `output`(상대 언어 번역).
- 각 패널은 최근 N개(기본 8)만 표시하고 자동 스크롤한다.
- 상태 표시에 수신/송신 세션의 연결 상태를 각각 보여 준다 (예: `수신 ● 연결됨 / 송신 ● 재연결 중 (2/5)`). 기존 `handleSessionStatus` 는 세션 구분 없이 하나의 메시지만 갱신하므로 세션 id 를 받도록 확장한다.
- 한 세션이 재연결 한도를 넘겨 닫히면 **해당 세션만 종료 상태로 표시**하고, 사용자가 중지 버튼을 누르기 전까지 다른 세션은 유지한다. (현재는 한 세션이 닫히면 전체를 중지시키는데, 통화 모드에서는 이 동작을 쓰지 않는다. single/dual 은 기존 동작 유지.)

**하울링(루프) 안전장치**
- 수신 레코더가 `system` 소스일 때, 수신 번역 음성이 다시 캡처되어 루프를 만들 수 있다. 다음을 구현한다.
  - 설정 패널에 경고 문구: "전체 화면 공유 시 번역 음성이 다시 캡처될 수 있습니다. 텔레그램 **창** 또는 **탭**만 공유하거나, 수신 번역 음성을 끄고 자막만 사용하세요."
  - `callInboundAudio` 토글을 설정 패널에 노출한다.
- Phase 1 테스트에서 실제로 루프가 발생하는지, Chrome 의 시스템 오디오 캡처가 자기 탭 출력을 포함하는지 **반드시 확인해 보고서에 기록**한다. 발생하면 추가 대책(수신 출력 장치를 캡처 대상 외 장치로 분리 등)을 Phase 2 항목으로 제안한다.

**장치 선택 UI**
- 통화 모드 설정 패널에 `마이크` 드롭다운 (Phase 1), `수신 번역 출력 장치`, `송신 번역 출력 장치(BlackHole 선택)` 드롭다운 (Phase 2).
- 장치 목록은 패널이 열릴 때와 `devicechange` 시 갱신한다.
- 라벨이 비어 있으면(권한 전) "권한 허용 후 장치 이름이 표시됩니다" 안내.

**코드 구조**
- `App.tsx` 가 이미 838줄이다. 최소한 다음은 분리한다.
  - `src/components/CallSettings.tsx` (통화 모드 설정 패널)
  - `src/components/CallTranscriptView.tsx` (통화 모드 자막 2분할)
  - `src/hooks/useTranslationPipelines.ts` (레코더/세션 생성·정리 로직) — 선택이지만 권장
- 인라인 스타일 객체는 기존 방식을 따라도 되지만, 신규 컴포넌트의 스타일은 해당 파일 안에 둔다.
- 이번에 수정하는 파일에서는 `any` 를 새로 추가하지 않는다. `App.tsx` 의 기존 `any` 와 `stopTranslationSession` 선언 순서 오류도 함께 고친다.

### 4.6 README

- "📞 영상통화 통역 모드" 섹션 추가: 전제(Chrome 141+, macOS 14.2+), 수신 설정 절차(텔레그램 창 공유 + 시스템 오디오 체크), Phase 2 완료 후 BlackHole 설치 및 텔레그램 마이크 설정 절차, 하울링 주의사항.
- 기존에 빠져 있는 백엔드 실행 방법(`uvicorn backend.main:app --reload`, `.env` 의 `HF_TOKEN`)도 짧게 추가한다.

## 5. 완료 기준 (검증자가 확인하는 항목)

### 자동 검사
- [ ] `npx tsc -b` 오류 0
- [ ] `npx eslint .` 결과에서 **이번에 수정·추가한 파일의 오류 0** (손대지 않은 파일의 기존 오류는 허용)
- [ ] `npm run build` 성공
- [ ] `git status` 깨끗, `.env`·키 파일 미포함, 커밋은 의미 단위로 분리 (예: 리팩터링 / call 모드 UI / 장치 선택 / README)

### 회귀 (기존 모드)
- [ ] `single` + 마이크: 자막·음성 정상
- [ ] `single` + 탭 오디오(유튜브): 자막·음성 정상, 자막 전용 토글 정상
- [ ] `dual`: A/B 분리 자막, 180° 회전 유지
- [ ] 중지 후 재시작 반복 3회에 누수(마이크 표시등 잔류, 콘솔 에러) 없음

### Phase 1 기능
- [ ] `call` 모드 선택 시 전용 설정 패널·자막 뷰가 뜬다
- [ ] 마이크 드롭다운에 실제 장치 목록이 라벨과 함께 표시되고, 선택이 localStorage 에 유지된다
- [ ] 유튜브 탭 공유로 시작하면 상대 패널에 원문 + 내 언어 번역이 흐르고, 헤드폰으로 번역 음성이 들린다
- [ ] 동시에 내가 마이크에 말하면 내 패널에 내 원문 + 상대 언어 번역이 흐른다 (세션이 서로 섞이지 않음)
- [ ] 텔레그램 데스크톱 통화 중 "전체 화면 + 시스템 오디오" 공유로 상대 음성이 통역된다
- [ ] 수신 번역 음성 끄기 토글이 즉시 반영된다
- [ ] 수신 세션만 강제로 끊어도(예: 네트워크 차단) 송신 세션은 유지되고 상태 표시가 세션별로 갱신된다
- [ ] 통화 모드에서 `localhost:8000` 연결 시도가 콘솔에 보이지 않는다
- [ ] 하울링 루프 발생 여부가 보고서에 기록되어 있다

### Phase 2 기능
- [ ] 출력 장치 드롭다운에 BlackHole 이 보인다
- [ ] 송신 번역 음성이 BlackHole 로만 나가고 내 헤드폰에서는 들리지 않는다
- [ ] 텔레그램 마이크를 BlackHole 로 두고 통화하면 상대(또는 두 번째 기기)에게 번역 음성이 들린다
- [ ] 수신 번역 출력 장치를 바꾸면 재생 중에도 즉시 전환된다
- [ ] README 의 설정 절차만 보고 처음부터 재현 가능하다

## 6. 산출물

작업 완료 후 `docs/WORK_REPORT_call-mode.md` 에 다음을 작성해 `feat/call-mode` 브랜치에 함께 푸시한다. **main 에 머지하지 않는다.** 검증 후 머지 여부를 결정한다.

1. 변경 파일 목록과 각 파일의 변경 요지
2. 설계 결정 사항 (파이프라인 구조를 어떻게 잡았는지, 왜)
3. 수동 테스트 결과 (5번 체크리스트 각 항목에 ✅/❌/미확인 + 메모)
4. 하울링 루프 확인 결과와 제안 대책
5. 알려진 문제와 미완 항목
6. 검증자가 재현할 수 있는 테스트 절차 (장치 설정 포함)

## 7. 참고

- Chrome 141 부터 macOS 에서 전체 화면/창 공유 시 시스템 오디오 포함 가능 (macOS 14.2+ 필요). 사용자 picker 에서 직접 체크해야 하며 코드로 강제할 수 없다.
- `AudioContext.setSinkId` 는 Chrome 110+ 지원. 출력 장치 라벨/목록을 얻으려면 마이크 권한이 먼저 필요하다.
- 브라우저는 다른 앱의 마이크 입력에 직접 소리를 넣을 수 없다. 송신 방향은 BlackHole(무료, https://existential.audio/blackhole/) 같은 가상 오디오 장치가 필수다.
- 텔레그램 웹 통화는 연결 안정성 관련 버그 리포트가 있으므로, 1차 테스트 대상은 텔레그램 데스크톱 앱 + 시스템 오디오 캡처로 한다.
