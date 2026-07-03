from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import logging

# 로깅 설정
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("translation-backend")

app = FastAPI(title="Gemini Live Translation Backend")

# CORS 설정 (Vite 프론트엔드가 접속할 수 있도록)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 1인 개발용이므로 우선 모든 origin 허용
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Gemini Live Translation Backend is running"}

@app.websocket("/ws/audio")
async def websocket_audio_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected to /ws/audio")
    
    try:
        while True:
            # 1단계: 실시간 오디오 데이터(바이너리 또는 Base64) 수신 루프
            # 수신 형식이 바이너리(bytes) 또는 텍스트(JSON/Base64)일 수 있으므로 두 형식 모두 지원하도록 예외처리
            data = await websocket.receive()
            
            if "bytes" in data:
                audio_bytes = data["bytes"]
                logger.info(f"Received binary audio chunk: {len(audio_bytes)} bytes")
                # 1단계 검증용 에코: 수신 성공 상태를 클라이언트에 응답
                await websocket.send_json({"status": "received", "size": len(audio_bytes)})
                
            elif "text" in data:
                text_data = data["text"]
                logger.info(f"Received text data: {len(text_data)} chars")
                await websocket.send_json({"status": "received", "text_size": len(text_data)})
                
    except WebSocketDisconnect:
        logger.info("Client disconnected from /ws/audio")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.close()
        except:
            pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
