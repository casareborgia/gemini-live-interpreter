"""배포된 /ws/audio 엔드포인트에 2화자 교대 음성을 실시간 스트리밍하고 diarization 응답을 관찰."""
import asyncio
import json
import sys
import time
import wave

import websockets

URL = "ws://localhost:8000/ws/audio"
CHUNK_MS = 100
SR = 16000
BYTES_PER_CHUNK = SR * 2 * CHUNK_MS // 1000  # 3200 bytes = 100ms


def load_pcm(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        return w.readframes(w.getnframes())


async def main():
    a = load_pcm("spk_a.wav")
    b = load_pcm("spk_b.wav")
    silence = b"\x00" * (SR * 2)  # 1초 무음

    # 화자 교대 시나리오: A(8s) → B(8s) → A(8s) → B(8s), 사이 1초 무음
    timeline = []
    for i, seg in enumerate([a, b, a, b]):
        label = "A(Yuna)" if i % 2 == 0 else "B(Daniel)"
        timeline.append((label, seg))
        timeline.append(("silence", silence))

    t0 = time.time()

    def ts():
        return f"[{time.time() - t0:6.1f}s]"

    async with websockets.connect(URL) as ws:
        print(f"{ts()} 연결 성공: {URL}", flush=True)

        async def receiver():
            try:
                async for msg in ws:
                    try:
                        data = json.loads(msg)
                    except Exception:
                        data = msg
                    print(f"{ts()} 📩 수신: {data}", flush=True)
            except Exception as e:
                print(f"{ts()} 수신 종료: {e}", flush=True)

        recv_task = asyncio.create_task(receiver())

        for label, seg in timeline:
            print(f"{ts()} ▶️ 전송 시작: {label} ({len(seg)/32000:.1f}s)", flush=True)
            for off in range(0, len(seg), BYTES_PER_CHUNK):
                await ws.send(seg[off:off + BYTES_PER_CHUNK])
                await asyncio.sleep(CHUNK_MS / 1000)

        print(f"{ts()} 전송 완료. 늦은 분석 결과 대기 (25초)...", flush=True)
        await asyncio.sleep(25)
        recv_task.cancel()

    print(f"{ts()} 테스트 종료", flush=True)


asyncio.run(main())
