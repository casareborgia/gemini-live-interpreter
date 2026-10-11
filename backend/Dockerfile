# 1. Python 3.10 slim 이미지를 베이스로 빌드 (용량 최적화)
FROM python:3.10-slim

# 2. 필수 시스템 패키지 및 C++ 컴파일 도구 설치
# pyannote, torch 등 과학 연산 패키지 빌드에 컴파일 도구가 요구될 수 있음
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# 3. 작업 디렉토리 설정
WORKDIR /app

# 4. 의존성 파일 복사 및 설치 (CPU 버전 PyTorch 최적화 설치)
# Cloud Run 환경에서는 CPU를 주로 사용하므로 용량을 줄이기 위해 CPU 버전 torch 설치 권장
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 5. 소스 코드 복사
COPY . .

# 6. Cloud Run 포트 바인딩 및 디바이스 설정 환경변수 (CPU 강제)
ENV PORT=8080
ENV DEVICE=cpu

# 7. Uvicorn 서버 실행 (Cloud Run은 PORT 환경변수를 바인딩해야 함 - 액세스 로그 비활성화로 보안 강화)
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --no-access-log"]
