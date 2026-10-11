import os
import io
import asyncio
import logging
import time
import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# 현재 main.py 위치를 기준으로 .env 절대경로 탐색 및 로드
base_dir = os.path.dirname(os.path.abspath(__file__))
dotenv_path = os.path.join(base_dir, ".env")
load_dotenv(dotenv_path=dotenv_path)

# 로깅 설정 최상단 배치
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("translation-backend")

# PyTorch 2.6+의 weights_only=True 기본값 및 SpeechBrain LazyModule 충돌 방지 (격리된 멍키패치)
# 1. torch.load 멍키패치 (weights_only=False 강제)
try:
    original_load = torch.load
    def patched_load(*args, **kwargs):
        kwargs["weights_only"] = False
        return original_load(*args, **kwargs)
    torch.load = patched_load
except Exception as e:
    logger.warning(f"torch.load patch failed: {e}")

# 2. inspect.stack 멍키패치 (LazyModule inspect 에러 방지)
try:
    import inspect
    original_stack = getattr(inspect, "stack")
    def patched_stack(*args, **kwargs):
        try:
            return original_stack(*args, **kwargs)
        except Exception:
            return []
    setattr(inspect, "stack", patched_stack)
except Exception as e:
    logger.warning(f"inspect.stack patch failed: {e}")

# 3. torchaudio AudioMetaData 멍키패치 (torchaudio v2.2+ 버전 호환성)
try:
    import sys
    import torchaudio
    from typing import NamedTuple

    # NamedTuple 기반의 AudioMetaData 정의 및 주입
    class AudioMetaData(NamedTuple):
        sample_rate: int
        num_frames: int
        num_channels: int
        bits_per_sample: int
        encoding: str

    torchaudio.AudioMetaData = AudioMetaData
    sys.modules['torchaudio'].AudioMetaData = AudioMetaData
    
    # list_audio_backends 멍키패치 주입
    if not hasattr(torchaudio, "list_audio_backends"):
        torchaudio.list_audio_backends = lambda: ["soundfile"]
        
    logger.info("🎉 Injecting custom AudioMetaData and list_audio_backends into torchaudio to bypass dependency conflict.")
except Exception as e:
    logger.warning(f"torchaudio patch failed: {e}")

app = FastAPI(title="Gemini Live Translation Backend with Diarization")

# CORS 설정 (기본적으로 로컬 개발 오리진 허용, 배포 시 환경 변수 ALLOWED_ORIGINS 권장)
allowed_origins_raw = os.getenv("ALLOWED_ORIGINS", "")
if not allowed_origins_raw:
    allow_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000"
    ]
else:
    allow_origins = [origin.strip() for origin in allowed_origins_raw.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# PyAnnote Diarization 파이프라인 및 임베딩 모델 로드
pipeline = None
embedding_inference = None
hf_token = os.getenv("HF_TOKEN", "")

# 로컬 M1/M2/M3 Mac의 경우 MPS 가속 사용, 그렇지 않으면 CPU 사용
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

def init_diarization_pipeline():
    global pipeline, embedding_inference
    if not hf_token or hf_token == "your_hugging_face_token_here":
        logger.warning("⚠️ HF_TOKEN이 설정되지 않았거나 기본값입니다. 화자 분할 기능은 '더미 모드(Mock)'로 구동됩니다.")
        return False
        
    try:
        from pyannote.audio import Pipeline, Model, Inference
        logger.info(f"Loading pyannote/speaker-diarization-3.1 on {device}...")
        
        # token 인자 불일치 회비를 위해 환경 변수 HUGGING_FACE_HUB_TOKEN으로 매핑 후 인자 없이 호출
        if hf_token:
            os.environ["HUGGING_FACE_HUB_TOKEN"] = hf_token
            
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        if pipeline is None:
            logger.warning("⚠️ pyannote.audio 모델을 다운로드/구동할 수 없습니다. (HF_TOKEN 권한 부족 또는 이용약관 미동의)")
            return False
        pipeline.to(device)
        logger.info("🎉 PyAnnote Diarization Pipeline loaded successfully!")

        # 임베딩 모델 추가 로드
        logger.info(f"Loading pyannote/wespeaker-voxceleb-resnet34-LM on {device}...")
        embedding_model = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM")
        embedding_inference = Inference(embedding_model, window="whole")
        embedding_inference.to(device)
        logger.info("🎉 PyAnnote Embedding Model loaded successfully!")

        return True
    except Exception as e:
        logger.exception("❌ PyAnnote 및 임베딩 로드 실패 상세 스택트레이스:")
        return False

# 백엔드 기동 시 파이프라인 초기화 시도
has_pipeline = init_diarization_pipeline()

@app.get("/")
def read_root():
    return {
        "status": "ok", 
        "diarization_mode": "Active" if (has_pipeline and embedding_inference is not None) else "Mock (HF_TOKEN required)",
        "device": str(device)
    }

# 세션별 오디오 분석 처리 클래스
class AudioDiarizationSession:
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        # 실시간 수집할 PCM float32 데이터 배열
        self.audio_buffer = np.array([], dtype=np.float32)
        # 샘플레이트는 프론트엔드 AudioRecorder의 16kHz 고정
        self.sample_rate = 16000
        # 메모리 보존을 위한 최대 분석 버퍼 범위 (최근 7초만 남기고 슬라이딩 - 연산 가속)
        self.max_buffer_seconds = 7
        self.max_samples = self.sample_rate * self.max_buffer_seconds
        
        # 분석 주기 조절용 샘플 카운터
        self.samples_since_last_analysis = 0
        self.analysis_interval_samples = self.sample_rate * 2.0  # 2초마다 분석 실행

        # 이전에 감지된 화자 기록
        self.last_detected_speaker = None

        # 세션 시작 시각 기록 및 비동기 분석 태스크 필드 추가
        self.session_start_time = time.time()
        self.analysis_task: asyncio.Task | None = None

        # [임베딩 기반 글로벌 화자 레지스트리 필드]
        self.speaker_registry = {}  # global_id -> {"centroid": np.ndarray, "count": int}
        self.global_speaker_count = 0
        self.total_samples_received = 0
        self.max_speakers = 0  # 화자 수 상한 제한 (기본 0 = 자동 모드)
        self.analysis_count = 0  # 분석 수행 횟수
        self.last_merge_time = time.time()  # 마지막 병합 시각
        self.pending_speakers = {}  # 임시 가등록 화자 global_id -> {"centroid": np.ndarray, "count": int}

    def add_audio_chunk(self, pcm_bytes: bytes):
        # Int16 PCM 바이트 데이터를 Float32로 정규화 변환
        int16_data = np.frombuffer(pcm_bytes, dtype=np.int16)
        if len(int16_data) == 0:
            return
            
        float32_data = int16_data.astype(np.float32) / 32768.0
        
        # 버퍼에 병합
        self.audio_buffer = np.append(self.audio_buffer, float32_data)
        self.samples_since_last_analysis += len(float32_data)
        self.total_samples_received += len(float32_data)

        # 최대 버퍼 길이 초과 시 오래된 데이터 버리기
        if len(self.audio_buffer) > self.max_samples:
            self.audio_buffer = self.audio_buffer[-self.max_samples:]

    async def run_analysis_if_needed(self):
        # 2초 단위 샘플이 쌓였을 때만 화자 분석 실행
        if self.samples_since_last_analysis >= self.analysis_interval_samples:
            self.samples_since_last_analysis = 0
            # 이전 분석이 아직 실행 중이면 이번 턴은 생략하여 오디오 밀림 방지
            if self.analysis_task and not self.analysis_task.done():
                return
            self.analysis_task = asyncio.create_task(self.analyze_speaker())

    async def analyze_speaker(self):
        if len(self.audio_buffer) < self.sample_rate * 2.0:
            return # 최소 2초 이상 분량이 모였을 때 분석 진행

        detected_speaker = None
        self.analysis_count += 1
        
        if has_pipeline and pipeline is not None and embedding_inference is not None:
            try:
                # 1. 버퍼 데이터를 PyTorch 텐서로 포맷팅 (shape: [channels=1, samples])
                waveform_tensor = torch.from_numpy(self.audio_buffer).unsqueeze(0).to(device)
                
                # 2. 비동기 스레드에서 무거운 딥러닝 연산 수행 (이벤트 루프 차단 방지)
                loop = asyncio.get_event_loop()
                
                # PyAnnote max_speakers 힌트 전달
                kwargs = {}
                if self.max_speakers > 0:
                    kwargs["max_speakers"] = self.max_speakers
                    
                diarization = await loop.run_in_executor(
                    None, 
                    lambda: pipeline({"waveform": waveform_tensor.cpu(), "sample_rate": self.sample_rate}, **kwargs)
                )
                
                # 3. 로컬 화자별 발화 구간 샘플 수집 및 이어붙이기
                speaker_waveforms = {}
                for turn, _, speaker in diarization.itertracks(yield_label=True):
                    start_sample = int(turn.start * self.sample_rate)
                    end_sample = int(turn.end * self.sample_rate)
                    start_sample = max(0, min(start_sample, len(self.audio_buffer)))
                    end_sample = max(0, min(end_sample, len(self.audio_buffer)))
                    if end_sample <= start_sample:
                        continue
                    chunk = self.audio_buffer[start_sample:end_sample]
                    if speaker not in speaker_waveforms:
                        speaker_waveforms[speaker] = []
                    speaker_waveforms[speaker].append(chunk)

                # 4. 각 로컬 화자별 임베딩 추출 및 글로벌 매칭
                local_to_global = {}
                new_pending_speakers = {}
                
                for spk, chunks in speaker_waveforms.items():
                    concatenated = np.concatenate(chunks)
                    # 발화 합산 시간이 1.2초 미만이면 화자 식별 신뢰성이 낮으므로 스킵
                    if len(concatenated) < int(self.sample_rate * 1.2):
                        continue
                    
                    waveform_sub_tensor = torch.from_numpy(concatenated).unsqueeze(0).to(device)
                    try:
                        embedding = await loop.run_in_executor(
                            None,
                            lambda: embedding_inference({"waveform": waveform_sub_tensor.cpu(), "sample_rate": self.sample_rate})
                        )
                        emb_array = np.squeeze(np.array(embedding))
                        
                        # 임베딩 품질 가드 (NaN / Zero norm 방지)
                        if np.isnan(emb_array).any() or np.linalg.norm(emb_array) == 0:
                            logger.warning(f"Skipping speaker {spk} due to invalid embedding (NaN or Zero norm)")
                            continue
                        
                        best_g_id = None
                        best_sim = -1.0
                        
                        for g_id, g_info in self.speaker_registry.items():
                            dot_val = np.dot(emb_array, g_info["centroid"])
                            norm_a = np.linalg.norm(emb_array)
                            norm_b = np.linalg.norm(g_info["centroid"])
                            sim = float(dot_val / (norm_a * norm_b)) if norm_a > 0 and norm_b > 0 else 0.0
                            
                            if sim > best_sim:
                                best_sim = sim
                                best_g_id = g_id
                        
                        max_limit = self.max_speakers if self.max_speakers > 0 else 8
                        matched_global_id = None
                        
                        # 3단계 판정
                        # 1단계: 확실한 매칭
                        if best_sim >= 0.4 and best_g_id is not None:
                            matched_global_id = best_g_id
                            g_info = self.speaker_registry[matched_global_id]
                            count = min(g_info["count"], 30)  # 카운트 상한 30
                            g_info["centroid"] = (g_info["centroid"] * count + emb_array) / (count + 1)
                            g_info["count"] = min(count + 1, 30)
                            
                        # 2단계: 마진 범위 매칭 (Best Match에 강제 배정하되 centroid는 갱신하지 않음)
                        elif best_sim >= 0.25 and best_g_id is not None:
                            matched_global_id = best_g_id
                            
                        # 3단계: 유사도가 매우 낮은 경우 (신규 화자 후보 또는 상한 도달 강제 배정)
                        else:
                            # 상한 도달 시에는 가장 유사한 정식 화자(best_g_id)로 강제 매칭
                            if len(self.speaker_registry) >= max_limit and best_g_id is not None:
                                matched_global_id = best_g_id
                            else:
                                # 프로비저널(pending) 매칭 시도
                                matched_pending_id = None
                                best_pending_sim = -1.0
                                
                                for p_id, p_info in self.pending_speakers.items():
                                    dot_val = np.dot(emb_array, p_info["centroid"])
                                    norm_a = np.linalg.norm(emb_array)
                                    norm_b = np.linalg.norm(p_info["centroid"])
                                    sim = float(dot_val / (norm_a * norm_b)) if norm_a > 0 and norm_b > 0 else 0.0
                                    
                                    if sim > best_pending_sim:
                                        best_pending_sim = sim
                                        matched_pending_id = p_id
                                
                                # 2회 연속 관측 조건 만족 시 정식 화자로 승격
                                if best_pending_sim >= 0.4 and matched_pending_id is not None:
                                    matched_global_id = f"SPEAKER_{self.global_speaker_count:02d}"
                                    self.global_speaker_count += 1
                                    
                                    p_centroid = self.pending_speakers[matched_pending_id]["centroid"]
                                    combined_centroid = (p_centroid + emb_array) / 2
                                    
                                    self.speaker_registry[matched_global_id] = {
                                        "centroid": combined_centroid,
                                        "count": 2
                                    }
                                    
                                    # 승격 후 pending 목록에서 제거
                                    if matched_pending_id in self.pending_speakers:
                                        del self.pending_speakers[matched_pending_id]
                                    logger.info(f"🎉 Speaker {matched_global_id} promoted from provisional status")
                                else:
                                    # 이번 턴의 임시 화자 후보로 가등록
                                    new_pending_id = f"PENDING_{len(new_pending_speakers)}"
                                    new_pending_speakers[new_pending_id] = {
                                        "centroid": emb_array,
                                        "count": 1
                                    }
                                    matched_global_id = None
                                    
                        if matched_global_id is not None:
                            local_to_global[spk] = matched_global_id
                            
                    except Exception as emb_err:
                        logger.error(f"Embedding inference failed for {spk}: {emb_err}")

                # 이번 분석 턴 종료 후, pending_speakers를 new_pending_speakers로 갱신하여 1회성 후보 자동 폐기
                self.pending_speakers = new_pending_speakers

                # 5. 가장 마지막 타임 영역에 매칭된 로컬 화자 찾기
                last_turn_end = -1
                detected_local_speaker = None
                for turn, _, speaker in diarization.itertracks(yield_label=True):
                    if turn.end > last_turn_end:
                        last_turn_end = turn.end
                        detected_local_speaker = speaker

                # 6. 전역 화자 ID로 치환 및 폴백
                if detected_local_speaker:
                    if detected_local_speaker in local_to_global:
                        detected_speaker = local_to_global[detected_local_speaker]
                    else:
                        # 1.2초 미만이라 임베딩 매칭이 없던 경우, 이전 검출 화자를 일단 신뢰
                        if self.last_detected_speaker:
                            detected_speaker = self.last_detected_speaker
                        else:
                            # 이전 화자가 아예 없는 초창기엔 SPEAKER_00으로 안전하게 폴백 (화자 무한 증식 방지)
                            detected_speaker = "SPEAKER_00"

                # 7. 주기적 레지스트리 병합 (30초 주기 또는 15회 분석마다)
                current_time = time.time()
                if self.analysis_count % 15 == 0 or (current_time - self.last_merge_time >= 30):
                    self.last_merge_time = current_time
                    merged_map = await self.merge_speaker_registry()
                    # 이번 턴에 검출된 화자가 병합으로 사라진 ID라면 남은 ID로 치환
                    if detected_speaker in merged_map:
                        detected_speaker = merged_map[detected_speaker]
                        
            except Exception as e:
                logger.error(f"Diarization inference error: {e}")
                detected_speaker = self.run_mock_diarization()
        else:
            # 더미 화자 분할 모드 (텍스트 피치/시간 흐름에 따른 가상 스피커 변환)
            detected_speaker = self.run_mock_diarization()

        # 화자가 인식되었고 이전 화자와 다를 경우 프론트엔드로 알림 전송
        if detected_speaker and detected_speaker != self.last_detected_speaker:
            self.last_detected_speaker = detected_speaker
            logger.info(f"👤 Detected speaker change: {detected_speaker}")
            try:
                await self.websocket.send_json({
                    "type": "diarization",
                    "speaker": detected_speaker
                })
            except Exception as e:
                logger.error(f"Failed to send diarization result: {e}")

    async def merge_speaker_registry(self, threshold: float = 0.55) -> dict:
        """
        레지스트리의 모든 centroid 쌍을 코사인 유사도로 비교해 동일 인물로 판단되는(>= threshold) 쌍을 병합한다.
        count가 큰(증거가 많은) ID를 남기고 centroid는 count 가중 평균으로 합산한다.
        반환값: {사라진_ID: 남은_ID} 매핑. 병합이 없으면 빈 dict.
        """
        merged_map: dict = {}
        if len(self.speaker_registry) < 2:
            return merged_map

        changed = True
        while changed and len(self.speaker_registry) >= 2:
            changed = False
            ids = list(self.speaker_registry.keys())
            best_pair = None
            best_sim = threshold
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    a = self.speaker_registry[ids[i]]["centroid"]
                    b = self.speaker_registry[ids[j]]["centroid"]
                    norm_a = np.linalg.norm(a)
                    norm_b = np.linalg.norm(b)
                    if norm_a == 0 or norm_b == 0:
                        continue
                    sim = float(np.dot(a, b) / (norm_a * norm_b))
                    if sim >= best_sim:
                        best_sim = sim
                        best_pair = (ids[i], ids[j])

            if best_pair is None:
                break

            id_a, id_b = best_pair
            info_a = self.speaker_registry[id_a]
            info_b = self.speaker_registry[id_b]
            # count가 큰 쪽을 남김 (동률이면 먼저 발급된 ID를 남김)
            if info_b["count"] > info_a["count"]:
                keep_id, drop_id = id_b, id_a
                keep, drop = info_b, info_a
            else:
                keep_id, drop_id = id_a, id_b
                keep, drop = info_a, info_b

            total = keep["count"] + drop["count"]
            keep["centroid"] = (keep["centroid"] * keep["count"] + drop["centroid"] * drop["count"]) / total
            keep["count"] = min(total, 30)
            del self.speaker_registry[drop_id]

            # 이전에 drop_id 로 병합됐던 ID들도 keep_id 를 가리키도록 갱신
            for src_id, dst_id in list(merged_map.items()):
                if dst_id == drop_id:
                    merged_map[src_id] = keep_id
            merged_map[drop_id] = keep_id
            changed = True

            logger.info(f"🔀 Speaker registry merged: {drop_id} -> {keep_id} (sim={best_sim:.3f}, remaining={len(self.speaker_registry)})")

            if self.last_detected_speaker == drop_id:
                self.last_detected_speaker = keep_id

            try:
                await self.websocket.send_json({
                    "type": "speaker_merged",
                    "from": drop_id,
                    "into": keep_id,
                })
            except Exception as e:
                logger.error(f"Failed to send speaker_merged event: {e}")

        return merged_map

    def run_mock_diarization(self):
        if len(self.audio_buffer) == 0:
            return None
            
        rms = np.sqrt(np.mean(self.audio_buffer**2))
        # 무음 스레스홀드 (0.01)
        if rms < 0.01:
            return "SILENCE"
            
        # 세션 시작 후 실제 경과 시간으로 10초 주기 교대
        elapsed = time.time() - self.session_start_time
        speaker_idx = int(elapsed // 10) % 2
        return f"SPEAKER_{speaker_idx:02d}"

@app.websocket("/ws/audio")
async def websocket_audio_endpoint(websocket: WebSocket, max_speakers: int = 0):
    await websocket.accept()
    logger.info(f"Client connected to /ws/audio (Step 2, max_speakers={max_speakers})")
    
    session = AudioDiarizationSession(websocket)
    session.max_speakers = max_speakers
    
    try:
        while True:
            data = await websocket.receive()
            
            if "bytes" in data:
                # 클라이언트에서 전송한 오디오 바이너리 chunk (Int16 PCM)
                pcm_bytes = data["bytes"]
                session.add_audio_chunk(pcm_bytes)
                
                # 필요시 화자 분석 수행 및 통보
                await session.run_analysis_if_needed()
                
            elif "text" in data:
                # 텍스트 메시지가 오면 (예: 설정 제어 등) 간단히 처리
                pass
                
    except WebSocketDisconnect:
        logger.info("Client disconnected from /ws/audio")
    except Exception as e:
        logger.error(f"WebSocket session error: {e}")
    finally:
        # 진행 중인 화자 분석 비동기 태스크가 있다면 정리
        if session.analysis_task and not session.analysis_task.done():
            session.analysis_task.cancel()
        try:
            await websocket.close()
        except:
            pass

@app.websocket("/ws-api/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")
async def google_live_proxy(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected to Google Live API Proxy")
    
    # URL 쿼리 파라미터 대신 첫 번째 데이터 메시지로 API Key를 받아 로그 유출 차단
    try:
        # 첫 번째 JSON 메시지를 수신 대기 (10초 타임아웃)
        first_message = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        auth_data = first_message.get("auth", {})
        key = auth_data.get("apiKey")
        if key:
            key = key.strip()
        if not key:
            logger.warning("Google Live Proxy: API key not provided in auth message.")
            await websocket.close(code=1008)
            return
    except Exception as e:
        logger.error(f"Google Live Proxy Auth failed: {e}")
        await websocket.close(code=1008)
        return
        
    google_ws_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}"
    
    try:
        import websockets
        async with websockets.connect(google_ws_url) as google_ws:
            logger.info("Connected to Google Generative Language WebSocket")
            
            async def forward_client_to_google():
                try:
                    while True:
                        data = await websocket.receive()
                        if "text" in data:
                            await google_ws.send(data["text"])
                        elif "bytes" in data:
                            await google_ws.send(data["bytes"])
                except Exception as e:
                    logger.error(f"Google Live Proxy [Client -> Google] Error: {e}")
            
            async def forward_google_to_client():
                try:
                    while True:
                        message = await google_ws.recv()
                        if isinstance(message, str):
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                except Exception as e:
                    logger.error(f"Google Live Proxy [Google -> Client] Error: {e}")
            
            await asyncio.gather(
                forward_client_to_google(),
                forward_google_to_client()
            )
    except Exception as e:
        logger.exception(f"Google Live Proxy Session Error: {e}")
    finally:
        logger.info("Google Live Proxy Session closed")
        try:
            await websocket.close()
        except:
            pass

# 서버 시작 시 .env 설정이 변경되었을 수 있으므로 pipeline 재호출 여부 점검을 위해
@app.on_event("startup")
async def startup_event():
    global has_pipeline
    if not has_pipeline:
        has_pipeline = init_diarization_pipeline()
