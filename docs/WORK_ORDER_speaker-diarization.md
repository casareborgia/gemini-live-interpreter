# 작업지시서: 화자 분할(Diarization) 기능 정상화

> 작성일: 2026-07-17
> 대상 환경: Antigravity (Google Cloud Run MCP, Firebase MCP 연결됨)
> 대상 서비스: Cloud Run `translation-backend` (리전 `asia-northeast3`, 프로젝트 `southern-engine-495314-p2`)

---

## 0. 배경 (진단 결과 요약)

배포된 Cloud Run 백엔드 헬스체크(`GET /`) 응답이 아래와 같음:

```json
{"status":"ok", "diarization_mode":"Mock (HF_TOKEN required)", "device":"cpu"}
```

- **근본 원인**: `backend/.dockerignore`가 `.env`를 이미지에서 제외하는데, Cloud Run에 `HF_TOKEN` 환경 변수를 따로 주입하지 않아 PyAnnote 모델이 로드되지 않고 **Mock(더미) 모드**로 동작 중.
- 로컬 `backend/.env`의 HF 토큰은 유효하며 gated 모델 2종(`pyannote/speaker-diarization-3.1`, `pyannote/segmentation-3.0`) 접근 권한 확인 완료 (HTTP 200).
- **부가 버그**: Mock 모드 자체도 버퍼 캡핑(15초) 때문에 15초 경과 후 화자가 `SPEAKER_01`로 영구 고정됨 (`backend/main.py:203-206`).
- **구조적 문제**: 실제 PyAnnote가 돌더라도 (a) 분석 호출마다 화자 라벨이 임의로 재부여되어 일관성이 없고, (b) 수신 루프가 분석을 `await`로 대기해 오디오 수신이 밀리며, (c) 프런트는 자막 생성 시점의 화자를 붙이므로 2초 이상 지연된 diarization 결과와 시간차가 발생함.

---

## 작업 1. Cloud Run에 HF_TOKEN 주입 (최우선, 필수)

토큰 값은 로컬 `backend/.env`의 `HF_TOKEN=` 값을 사용할 것. **작업지시서/커밋/로그에 토큰 원문을 절대 남기지 말 것.**

### 권장: Secret Manager 사용

```bash
# 1) 시크릿 생성 (토큰 값은 .env에서 복사)
echo -n "<HF_TOKEN 값>" | gcloud secrets create hf-token --data-file=- --project=southern-engine-495314-p2

# 2) Cloud Run 서비스 계정에 접근 권한 부여
gcloud secrets add-iam-policy-binding hf-token \
  --member="serviceAccount:517419857386-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=southern-engine-495314-p2

# 3) 서비스에 시크릿 연결
gcloud run services update translation-backend \
  --region=asia-northeast3 \
  --set-secrets=HF_TOKEN=hf-token:latest
```

### 간단 대안 (환경 변수 직접 주입)

```bash
gcloud run services update translation-backend \
  --region=asia-northeast3 \
  --set-env-vars=HF_TOKEN=<HF_TOKEN 값>
```

### 함께 적용: 리소스 증설

PyAnnote CPU 추론이 무거우므로 아래 스펙으로 함께 업데이트:

```bash
gcloud run services update translation-backend \
  --region=asia-northeast3 \
  --cpu=4 --memory=8Gi --timeout=3600 --concurrency=4 --min-instances=1
```

- `min-instances=1`: 콜드 스타트 시 모델 로딩(수십 초~수 분) 회피용. 비용이 부담되면 0으로 두되, 첫 접속 지연을 감수.
- WebSocket 장기 연결을 쓰므로 `timeout=3600` 필수.

### 검증

```bash
curl https://translation-backend-517419857386.asia-northeast3.run.app/
# 기대 응답: {"status":"ok","diarization_mode":"Active","device":"cpu"}
```

`"Mock (HF_TOKEN required)"`가 계속 나오면 Cloud Run 로그에서 `PyAnnote 로드 실패` 메시지를 확인할 것.

---

## 작업 2. Mock 모드 화자 고정 버그 수정 (backend/main.py)

`run_mock_diarization()`(main.py 191행 부근)이 **버퍼 길이**로 경과 시간을 계산하는데, 버퍼가 15초로 캡핑되므로 15초 이후 `speaker_idx`가 1로 고정됨.

수정 방법: 세션 시작 시각 기준 실제 경과 시간 사용.

```python
# __init__에 추가
import time
self.session_start_time = time.time()

# run_mock_diarization 수정
def run_mock_diarization(self):
    if len(self.audio_buffer) == 0:
        return None
    rms = np.sqrt(np.mean(self.audio_buffer**2))
    if rms < 0.01:
        return "SILENCE"
    # 세션 시작 후 실제 경과 시간으로 10초 주기 교대 (버퍼 길이 사용 금지)
    elapsed = time.time() - self.session_start_time
    speaker_idx = int(elapsed // 10) % 2
    return f"SPEAKER_{speaker_idx:02d}"
```

---

## 작업 3. 분석을 백그라운드 태스크로 분리 + 윈도우 축소 (backend/main.py)

현재 `websocket_audio_endpoint`의 수신 루프가 `await session.run_analysis_if_needed()`로 추론 완료를 기다림 → CPU에서 추론이 2초 이상 걸리면 오디오 수신이 밀리고 분석 주기가 계속 늘어짐.

수정 방향:

1. **분석 윈도우 축소**: `max_buffer_seconds = 15` → `7` (추론 시간 단축, 최신 발화 위주 분석).
2. **논블로킹 분석**: 분석 중이면 스킵하고, `asyncio.create_task`로 백그라운드 실행.

```python
# __init__에 추가
self.analysis_task: asyncio.Task | None = None

# run_analysis_if_needed 수정
async def run_analysis_if_needed(self):
    if self.samples_since_last_analysis >= self.analysis_interval_samples:
        self.samples_since_last_analysis = 0
        # 이전 분석이 아직 돌고 있으면 이번 턴은 스킵 (밀림 방지)
        if self.analysis_task and not self.analysis_task.done():
            return
        self.analysis_task = asyncio.create_task(self.analyze_speaker())
```

3. WebSocket 종료 시 태스크 정리: `websocket_audio_endpoint`의 `except WebSocketDisconnect` 블록에서 `session.analysis_task`가 있으면 `cancel()` 호출.

---

## 작업 4. 화자 라벨 일관성 확보 (핵심 품질 개선)

**문제**: PyAnnote는 호출마다 `SPEAKER_00/01` 라벨을 임의 부여함. 2초마다 독립 실행되는 현 구조에서는 이번 분석의 SPEAKER_00과 다음 분석의 SPEAKER_00이 같은 사람이라는 보장이 없어, 프런트에서 화자 색상이 무작위로 뒤바뀜.

### 방안 A (권장): diart로 교체

실시간 스트리밍 diarization 전용 라이브러리로, 내부적으로 화자 추적(온라인 클러스터링)을 일관되게 유지함.

- `pip install diart` 후 `SpeakerDiarization` 파이프라인을 스트리밍 모드로 사용.
- 오디오 청크를 그대로 흘려 넣으면 화자 라벨이 붙은 세그먼트가 실시간으로 나옴 → 현 2초 배치 분석 구조 전체를 대체.
- 참고: https://github.com/juanmc2005/diart (pyannote 모델 기반이므로 동일한 HF_TOKEN 사용)

### 방안 B (현 구조 유지 시): 임베딩 매칭

각 분석에서 화자별 음성 임베딩을 추출해 직전 분석의 화자들과 코사인 유사도로 매칭, 전역 화자 ID를 유지하는 매핑 레이어를 `AudioDiarizationSession`에 추가.

- `pyannote/embedding` 모델 사용, 유사도 임계값 0.6~0.7 권장.
- 방안 A보다 구현 난도가 높고 품질이 낮으므로 diart 도입이 어려울 때만 선택.

---

## 작업 5. 프런트엔드 개선 (src/App.tsx)

1. **시간차 보정**: `upsertTranscript`(App.tsx 100행 부근)가 말풍선 생성 시점의 `currentSpeakerRef.current`를 붙이는데, diarization 결과는 2초 이상 늦게 도착함. 최소 개선: 말풍선 생성 시점이 아니라 **diarization 이벤트 수신 시 가장 최근 입력 말풍선의 speaker를 갱신**하는 로직으로 변경 (id 기준 upsert 구조라 적용 용이).
2. **dual(대면) 모드 표시 누락**: dual 모드는 `emitInputTranscript: false`라 입력 자막이 없어 화자 라벨이 표시될 곳이 없음. dual 모드에서 화자 분할을 쓰려면 출력 자막(`role: 'output'`)에도 speaker를 매핑하거나, dual 모드에서는 diarization 연결 자체를 생략(리소스 절약)할지 결정 필요.
3. **3인 이상 대응(선택)**: `renderBubble`이 `SPEAKER_01` 여부로만 색을 나눔 → speaker 문자열 해시 기반 색상 팔레트로 확장.

---

## 작업 6. API 키 로그 유출 차단 (보안, 필수)

**문제**: 프런트가 `wss://백엔드/ws-api/ws/...?key=API키` 형태로 접속하므로(`src/utils/translationSession.ts:111`, `backend/main.py:241`), Gemini API 키가 URL 쿼리스트링으로 전달됨. Cloud Run 요청 로그와 uvicorn 액세스 로그는 전체 URL을 기록하므로 **사용자 API 키가 Cloud Logging에 평문으로 남음**.

### 6-1. 키를 URL에서 제거하고 첫 WebSocket 메시지로 전달

프런트 (`src/utils/translationSession.ts`):
- `buildWsUrl()`에서 `?key=${this.opts.apiKey}` 제거.
- `openSocket()`의 `ws.onopen`에서 setup 메시지 전송 **전에** 인증 메시지 전송:

```typescript
ws.onopen = () => {
  this.reconnectAttempts = 0;
  this.cb.onStatus?.('open');
  ws.send(JSON.stringify({ auth: { apiKey: this.opts.apiKey } })); // 첫 메시지로 인증
  ws.send(JSON.stringify(this.buildSetupMessage()));
};
```

백엔드 (`backend/main.py`의 `google_live_proxy`):
- 함수 시그니처에서 쿼리 파라미터 `key: str` 제거.
- accept 직후 첫 메시지에서 키 수신, 없으면 즉시 종료:

```python
@app.websocket("/ws-api/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")
async def google_live_proxy(websocket: WebSocket):
    await websocket.accept()
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=10)
    except Exception:
        await websocket.close(code=1008)
        return
    key = (first.get("auth") or {}).get("apiKey")
    if not key:
        await websocket.close(code=1008)
        return
    # 이후 기존 로직과 동일하게 google_ws_url 구성에 key 사용
```

- 백엔드→Google 구간은 자체 인프라 로그에 남지 않으므로 `?key=` 유지 가능. 더 깔끔하게 하려면 `websockets.connect(url, additional_headers={"x-goog-api-key": key})`로 헤더 전달하고 URL에서 제거.
- 주의: 인증 메시지(`{"auth": ...}`)는 Google로 포워딩하면 안 되므로, 첫 메시지 소비 후 나머지 메시지부터 릴레이 시작.

### 6-2. 사후 조치 (이미 기록된 키)

1. **키 로테이션**: 배포된 앱에서 키를 입력해 사용한 적이 있다면, Google AI Studio에서 해당 Gemini API 키 삭제 후 재발급.
2. Cloud Logging에서 `ws-api` 경로가 포함된 과거 요청 로그 확인, 필요 시 삭제 및 로그 보존 기간 단축.
3. 보조: Dockerfile CMD의 uvicorn에 `--no-access-log` 추가 (자체 액세스 로그 억제 — Cloud Run 요청 로그는 6-1로만 차단됨).

---

## 작업 7. 배포 및 최종 검증

1. 백엔드 수정 후 재배포:
   ```bash
   gcloud run deploy translation-backend \
     --source ./backend --region=asia-northeast3
   ```
2. 프런트 수정 후 재배포:
   ```bash
   npm run build && firebase deploy --only hosting
   ```
3. 검증 시나리오:
   - `GET /` 응답이 `"diarization_mode": "Active"`인지 확인.
   - 웹앱 접속 → API 키 입력 → 단방향(마이크) 모드 시작 → 두 사람이 번갈아 말하기.
   - 브라우저 콘솔에서 `Diarization Speaker Detected:` 로그가 화자 교대에 맞춰 출력되고, 자막 말풍선 색상(보라/시안)이 실제 화자와 일치하게 유지되는지 확인.
   - Cloud Run 로그에서 `Detected speaker change` 주기와 추론 에러 유무 확인.

---

## 작업 8. 화자 재식별을 임베딩 기반으로 교체 (작업 4 재작업, 필수)

### 배경: 실측 테스트 결과 (2026-07-17)

배포된 `/ws/audio`에 두 화자(macOS `say` Yuna/Daniel 음성)가 A→B→A→B로 교대 발화하는 33초 오디오를 실시간 스트리밍한 결과:

| 실제 화자 | 감지 결과 | 판정 |
|---|---|---|
| A (0~8.5s) | SPEAKER_00 | ✅ |
| B (9.5~17.5s) | SPEAKER_01 | ✅ |
| **A 재등장** (18.5s~) | SPEAKER_02 → SPEAKER_03 | ❌ 새 화자로 오인 |
| **B 재등장** (27.9s~) | SPEAKER_04 | ❌ 새 화자로 오인 |

**PyAnnote 추론 자체는 정상** (발화 감지 시점이 실제 음성 변화와 일치). 문제는 현재 `backend/main.py`의 시간 겹침 기반 라벨 매핑(`speaker_history` + 0.3초 겹침 임계값)이 **침묵 후 돌아온 화자를 원리적으로 재식별할 수 없다**는 것. 시간 정보만으로는 "같은 목소리"를 판단할 수 없으므로, 화자가 교대할 때마다 글로벌 ID가 무한히 증가함 (00→01→02→03→04...).

### 수정 지시: 임베딩 기반 글로벌 화자 레지스트리

시간 겹침 매핑(`speaker_history`, `label_overlaps` 로직)을 **제거**하고 아래로 교체:

1. **임베딩 모델 로드** (서버 기동 시 1회, diarization 파이프라인 옆에):

```python
from pyannote.audio import Model, Inference
# 공개 모델 (게이트 없음, 동일 HF_TOKEN 사용 가능)
embedding_model = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM")
embedding_inference = Inference(embedding_model, window="whole")
embedding_inference.to(device)
```

2. **세션에 글로벌 화자 레지스트리 추가**:

```python
# __init__
self.speaker_registry = {}   # global_id -> {"centroid": np.ndarray, "count": int}
self.global_speaker_count = 0
```

3. **분석 시 로컬 화자별 임베딩 추출 → 레지스트리 매칭**:
   - diarization 결과에서 로컬 화자별로 발화 구간 샘플을 버퍼에서 잘라 이어붙임 (합산 0.8초 미만이면 해당 화자는 이번 턴 스킵 — 짧은 조각으로 유령 화자 생성 방지).
   - `embedding_inference({"waveform": tensor, "sample_rate": 16000})`로 임베딩 벡터 추출.
   - 레지스트리의 각 centroid와 **코사인 유사도** 계산:
     - 최고 유사도 ≥ **0.5** → 해당 글로벌 ID 배정, centroid를 이동 평균으로 갱신 (`centroid = (centroid*count + emb) / (count+1)`).
     - 미만 → 새 글로벌 ID 발급 후 레지스트리 등록.
   - 마지막 턴의 글로벌 ID를 기존과 동일하게 `{"type":"diarization","speaker":...}`로 전송.
   - 임계값 0.5는 시작점: 같은 화자가 갈라지면 낮추고, 다른 화자가 합쳐지면 올릴 것 (0.4~0.65 범위에서 튜닝).

4. **임베딩 추론도 `run_in_executor`로 실행** (diarization과 동일한 이유).

### 검증 (필수 — 코드 반영 후 반드시 실행)

프로젝트에 E2E 테스트 스크립트가 준비되어 있음: `backend/test_diarization_e2e.py` (+ 테스트 음성 `backend/spk_a.wav`, `spk_b.wav`).

```bash
cd backend && .venv/bin/python test_diarization_e2e.py
```

- **성공 기준**: A→B→A→B 교대 발화에서 글로벌 ID가 **정확히 2개**(예: SPEAKER_00, SPEAKER_01)만 등장하고, 재등장한 화자가 기존 ID로 다시 감지될 것.
- 현재(수정 전) 결과는 5개 ID가 발급되므로, 5개 → 2개로 줄면 성공.
- 스크립트는 배포된 Cloud Run URL을 대상으로 하므로 **재배포 후** 실행할 것. 로컬 검증 시엔 스크립트 상단 `URL`을 `ws://localhost:8000/ws/audio`로 변경.

---

## 작업 9. 화자별 통역 목소리 차별화 (신규 기능)

**목표**: 화자가 바뀌면 통역 음성도 다르게 출력 (같은 성별이어도 구분 가능하게).

**제약**: Gemini Live의 `voiceName`은 setup 메시지에서 세션당 1회 고정 — 세션 중 변경 불가. 재연결 방식은 끊김 때문에 불가.

### 9-1. 단방향 모드: 클라이언트 피치 시프트 (권장안)

`src/utils/audioPlayer.ts`에 화자별 음높이 변조 추가:

1. **피치 시프터 노드 추가**: Web Audio의 delay 기반 피치 시프터("jungle" 알고리즘, Chrome 샘플 유래) 또는 SoundTouchJS AudioWorklet을 오디오 그래프에 삽입 (`source → pitchShifter → gain → destination`).
   - 간단 대안: `AudioBufferSourceNode.playbackRate`로 재생 속도 변경(±2~3반음 = 12~19% 속도 변화). 구현이 가장 쉬우나 말 빠르기도 함께 변하므로, 품질 확인 후 결정. 이 경우 재생 스케줄링(`nextStartTime`)에 `duration / playbackRate`를 반영해야 겹침/공백이 안 생김.
2. **API 추가**: `AudioPlayer.setPitchSemitones(n: number)` — 이후 재생되는 청크부터 적용.
3. **App.tsx 연동 (단방향 모드)**:
   - 화자 ID → 반음 오프셋 매핑을 등장 순서대로 배정: `[0, +3, -3, +5, -5]` 순환.
   - 적용 시점: 새 출력 턴이 시작될 때(`turnComplete` 후 첫 출력 청크) `currentSpeakerRef.current` 기준으로 `setPitchSemitones` 호출. 턴 중간에 바꾸면 한 문장 안에서 목소리가 갈라지므로 **턴 경계에서만** 변경할 것.
   - 주의: 통역 음성은 원 발화보다 2~3초 늦게 나오므로, 화자 전환 직후 첫 턴은 이전 화자 음색으로 나갈 수 있음(수용 가능한 한계로 문서화).

### 9-2. 대면(dual) 모드: 세션별 voiceName 분리 (즉시 가능, 저비용)

dual 모드는 이미 세션 2개 구조이므로 `src/App.tsx`의 sessionA/sessionB 생성부에서 서로 다른 `voiceName`을 전달하면 끝:

- 설정 UI의 목소리 선택을 dual 모드에서 "내 목소리 / 상대 목소리" 2개로 확장 (기본값 예: A=Kore, B=Puck).

### 9-3. (선택) 화자별 전용 세션 방식 — 보류 권장

같은 타깃 언어로 voiceName만 다른 세션 N개를 열고 감지된 화자의 세션 출력만 재생하는 방식은 진짜 다른 음성을 얻을 수 있으나, API 비용 N배 + 세션 간 번역 불일치 + 화자 감지 지연에 따른 오라우팅 문제로 **9-1 품질이 불충분할 때만 검토**.

### 검증

- 단방향 모드에서 유튜브 2인 대화 영상 재생 → 화자 전환 시 통역 음성의 높낮이가 턴 경계에서 바뀌는지 확인.
- 자막 전용 모드(`subtitleOnly`)에서는 볼륨이 0이므로 피치 시프트 경로가 에러 없이 무시되는지 확인.
- dual 모드에서 A/B 방향 통역 음성이 서로 다른 목소리로 나오는지 확인.

---

## 작업 10. 화자 무한 증식 방지 — 레지스트리 안정화 (필수)

### 배경 (2026-07-18 실측)

작업 8 구현 후 `test_diarization_e2e.py`는 통과(정확히 2개 ID, 재식별 성공)하나, **실제 유튜브 2인 대화에서는 화자 ID가 계속 증가**함. 원인: 현재 구조에서 새 ID 발급은 되돌릴 수 없는데, 유튜브 오디오(BGM/효과음/말 겹침/압축 잡음)에서는 임베딩 유사도가 간헐적으로 임계값(0.4) 아래로 떨어지며, 그때마다 영구적인 새 화자가 등록됨. 분석이 2초마다 돌므로 실패 확률이 낮아도 누적됨.

### 수정 지시 (`backend/main.py`의 `analyze_speaker` 임베딩 매칭부)

**1. 화자 수 모드: 자동(기본) + 수동 상한 (핵심)**

영상마다 화자 수가 다르므로 고정 상한을 전제하지 않는다. 두 모드를 제공:

- **자동 모드 (기본값)**: 화자 수를 가정하지 않는 대신 아래 **1-a 주기적 병합**으로 잘못 발급된 ID를 자기 치유. 폭주 방지용 안전 상한만 8로 설정 (도달 시 best match 강제 배정).
- **수동 모드**: 사용자가 화자 수 N(2~4)을 지정하면 레지스트리가 N개 도달 시 새 ID 발급 금지 + `pipeline({...}, max_speakers=N)` 힌트 전달.
- 프론트 전달: `/ws/audio?max_speakers=N` 쿼리 파라미터 (자동 모드는 `0` 또는 생략, 비밀값 아니므로 쿼리 무방). App.tsx 설정 패널에 "화자 수: 자동 / 2 / 3 / 4" 선택 UI 추가 (기본 "자동").

**1-a. 주기적 레지스트리 병합 (자동 모드의 핵심 — 자기 치유)**
- 30초마다(또는 15회 분석마다) 레지스트리의 모든 centroid 쌍의 코사인 유사도를 계산.
- **유사도 ≥ 0.55인 쌍은 동일 인물로 판단하고 병합**: `count`가 큰(증거가 많은) ID를 남기고, centroid는 count 가중 평균으로 합산, 작은 ID는 레지스트리에서 제거.
- 병합으로 사라진 ID가 `last_detected_speaker`였다면 남은 ID로 치환.
- 효과: 노이즈로 인한 오발급이 영구 오류가 아니라 일시적 오류가 됨 — ID 수가 실제 화자 수로 수렴.
- (선택) 병합 발생 시 `{"type":"speaker_merged","from":"SPEAKER_02","into":"SPEAKER_00"}` 이벤트를 프론트로 보내 이미 표시된 말풍선의 화자/색상을 소급 정정.

**2. 마진 기반 3단계 판정** (상한 도달 전에도 증식 억제)
- `best_sim >= 0.4`: 매칭 + centroid 갱신.
- `0.25 <= best_sim < 0.4`: **best match에 배정하되 centroid는 갱신하지 않음** (오염 방지). 새 ID 발급 안 함.
- `best_sim < 0.25`: 이때만 새 ID 후보로 처리.

**3. 프로비저널(가등록) 화자**
- 새 ID 후보는 즉시 정식 등록하지 않고 `pending` 상태로 보관.
- **2회 연속 분석 윈도우에서 같은 미지의 임베딩(서로 유사도 ≥ 0.4)이 관측될 때만** 정식 ID 발급·전송. 1회성이면 폐기.

**4. 임베딩 품질 가드**
- `np.isnan(emb_array).any() or np.linalg.norm(emb_array) == 0`이면 해당 화자 스킵 (NaN centroid가 레지스트리에 들어가면 영구 유령 화자가 됨).
- 임베딩 최소 발화 길이 0.8초 → **1.2초** 상향.

**5. centroid 관리**
- 이동 평균의 `count`에 상한 30 적용 (`count = min(count, 30)`) — 초기 오염을 서서히 희석할 수 있도록 적응성 유지.

### 검증

1. `backend/test_diarization_e2e.py` 재실행 (자동 모드 상태) → 여전히 정확히 2개 ID (회귀 없음 확인).
2. **실환경 테스트 A (합격 기준)**: 유튜브 2인 대담 10분을 **자동 모드**로 통역 → 콘솔의 고유 화자 ID가 초반 오발급이 있더라도 **병합을 거쳐 2개로 수렴**할 것 (10분 시점 활성 ID ≤ 3).
3. **실환경 테스트 B**: 3~4인 패널 영상으로 자동 모드 반복 → ID가 실제 화자 수 근처로 수렴하는지 확인 (완벽 일치까지는 요구하지 않음, 폭주만 없으면 합격).
4. 수동 모드(N=2) 선택 시 ID가 2개를 절대 초과하지 않는지 확인.

---

## 우선순위 요약

| 순위 | 작업 | 효과 |
|---|---|---|
| 1 | 작업 1 (HF_TOKEN 주입 + 리소스 증설) | Mock 모드 탈출, 실제 모델 동작 |
| 2 | 작업 2 (Mock 버그 수정) | 로컬/토큰 미설정 환경에서도 데모 가능 |
| 3 | 작업 3 (백그라운드 분석) | 오디오 수신 밀림 해소 |
| 4 | 작업 6 (API 키 로그 유출 차단 + 키 로테이션) | 보안 — 사용자 키가 Cloud Logging에 평문 노출 중 |
| 5 | 작업 4 (라벨 일관성 — diart 권장) | 실사용 가능한 화자 분할 품질 |
| 6 | 작업 5 (프런트 시간차/표시) | 자막-화자 매칭 정확도 |

작업 1~2만으로 "동작하는" 상태, 작업 4까지 완료해야 실사용 품질이 나옴. 작업 6은 기능과 무관하지만 키 유출이 진행 중인 사안이므로 배포 전 반드시 포함할 것.

> **[2026-07-17 갱신]** 작업 1~3, 5~7 완료 확인. 작업 4는 시간 겹침 방식으로 구현되었으나 실측 테스트에서 화자 재식별 실패 확인 → 작업 8(임베딩 기반 교체)로 재작업.
>
> **[2026-07-18 갱신]** 작업 8 완료 — 유튜브 실사용 테스트에서 화자 전환 감지 정상 확인. 신규 요구사항으로 **작업 9(화자별 통역 목소리 차별화)** 추가: 9-1(단방향 피치 시프트)과 9-2(dual 모드 voiceName 분리)를 구현할 것. 9-3은 보류.
>
> **[2026-07-18 갱신 2]** 작업 8~9 완료. E2E 테스트는 통과(2개 ID 재식별 성공)하나 **실제 유튜브 통역에서 화자 ID 무한 증식 확인** → **작업 10(레지스트리 안정화)이 현재 남은 필수 작업.**
>
> **[2026-07-18 갱신 3]** 작업 10 설계 변경: 영상마다 화자 수가 달라 고정 상한(2인) 전제를 폐기. **자동 모드(주기적 레지스트리 병합으로 자기 치유) 기본 + 수동 상한(2~4) 선택** 구조로 수정. 검증 기준도 "수렴" 기준으로 갱신.
