import os
import io
import asyncio
import logging
import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# .env 로드
load_dotenv()

# 로깅 설정
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("translation-backend")

app = FastAPI(title="Gemini Live Translation Backend with Diarization")

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# PyAnnote Diarization 파이프라인 로드
pipeline = None
hf_token = os.getenv("HF_TOKEN", "")

# 로컬 M1/M2/M3 Mac의 경우 MPS 가속 사용, 그렇지 않으면 CPU 사용
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

def init_diarization_pipeline():
    global pipeline
    if not hf_token or hf_token == "your_hugging_face_token_here":
        logger.warning("⚠️ HF_TOKEN이 설정되지 않았거나 기본값입니다. 화자 분할 기능은 '더미 모드(Mock)'로 구동됩니다.")
        return False
        
    try:
        from pyannote.audio import Pipeline
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
        return True
    except Exception as e:
        logger.error(f"❌ PyAnnote 로드 실패: {e}. '더미 모드'로 대체합니다.")
        return False

# 백엔드 기동 시 파이프라인 초기화 시도
has_pipeline = init_diarization_pipeline()

@app.get("/")
def read_root():
    return {
        "status": "ok", 
        "diarization_mode": "Active" if has_pipeline else "Mock (HF_TOKEN required)",
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
        # 메모리 보존을 위한 최대 분석 버퍼 범위 (최근 15초만 남기고 슬라이딩)
        self.max_buffer_seconds = 15
        self.max_samples = self.sample_rate * self.max_buffer_seconds
        
        # 분석 주기 조절용 샘플 카운터
        self.samples_since_last_analysis = 0
        self.analysis_interval_samples = self.sample_rate * 2.0  # 2초마다 분석 실행

        # 이전에 감지된 화자 기록
        self.last_detected_speaker = None

    def add_audio_chunk(self, pcm_bytes: bytes):
        # Int16 PCM 바이트 데이터를 Float32로 정규화 변환
        int16_data = np.frombuffer(pcm_bytes, dtype=np.int16)
        if len(int16_data) == 0:
            return
            
        float32_data = int16_data.astype(np.float32) / 32768.0
        
        # 버퍼에 병합
        self.audio_buffer = np.append(self.audio_buffer, float32_data)
        self.samples_since_last_analysis += len(float32_data)

        # 최대 버퍼 길이 초과 시 오래된 데이터 버리기
        if len(self.audio_buffer) > self.max_samples:
            self.audio_buffer = self.audio_buffer[-self.max_samples:]

    async def run_analysis_if_needed(self):
        # 2초 단위 샘플이 쌓였을 때만 화자 분석 실행
        if self.samples_since_last_analysis >= self.analysis_interval_samples:
            self.samples_since_last_analysis = 0
            await self.analyze_speaker()

    async def analyze_speaker(self):
        if len(self.audio_buffer) < self.sample_rate * 2.0:
            return # 최소 2초 이상 분량이 모였을 때 분석 진행

        detected_speaker = None
        
        if has_pipeline and pipeline is not None:
            try:
                # 1. 버퍼 데이터를 PyTorch 텐서로 포맷팅 (shape: [channels=1, samples])
                waveform_tensor = torch.from_numpy(self.audio_buffer).unsqueeze(0).to(device)
                
                # 2. 비동기 스레드에서 무거운 딥러닝 연산 수행 (이벤트 루프 차단 방지)
                loop = asyncio.get_event_loop()
                diarization = await loop.run_in_executor(
                    None, 
                    lambda: pipeline({"waveform": waveform_tensor.cpu(), "sample_rate": self.sample_rate})
                )
                
                # 3. 가장 마지막 타임 영역에 매칭된 화자 확인
                last_turn_end = -1
                for turn, _, speaker in diarization.itertracks(yield_label=True):
                    if turn.end > last_turn_end:
                        last_turn_end = turn.end
                        detected_speaker = speaker
                        
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

    def run_mock_diarization(self):
        # 1인용 테스트를 위한 더미 알고리즘:
        # 오디오 버퍼의 RMS 실효값을 분석하여 에너지가 높으면 화자가 있는 것으로 가정하고
        # 시간 경과에 따라 가상으로 SPEAKER_00 / SPEAKER_01을 번갈아가며 스위칭함
        if len(self.audio_buffer) == 0:
            return None
            
        rms = np.sqrt(np.mean(self.audio_buffer**2))
        # 무음 스레스홀드 (0.01)
        if rms < 0.01:
            return "SILENCE"
            
        # 10초 주기로 가상 화자 교대
        seconds = len(self.audio_buffer) / self.sample_rate
        speaker_idx = int(seconds // 10) % 2
        return f"SPEAKER_{speaker_idx:02d}"

@app.websocket("/ws/audio")
async def websocket_audio_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected to /ws/audio (Step 2)")
    
    session = AudioDiarizationSession(websocket)
    
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
        try:
            await websocket.close()
        except:
            pass

# 서버 시작 시 .env 설정이 변경되었을 수 있으므로 pipeline 재호출 여부 점검을 위해
# @app.on_event("startup") 사용 가능
@app.on_event("startup")
async def startup_event():
    global has_pipeline
    if not has_pipeline:
        has_pipeline = init_diarization_pipeline()
