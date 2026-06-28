/**
 * Gemini Live API에서 수신된 24kHz PCM 오디오 데이터를 자연스럽게 재생하기 위한 플레이어
 */
export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private volume: number = 1; // 번역 음성 출력 볼륨 (0 ~ 1)
  private nextPlayTime: number = 0;
  private sampleRate: number = 24000; // Gemini Live API 출력 기본값 24kHz
  // 현재 스케줄되어 재생 대기/진행 중인 소스 노드들 (밀렸을 때 버리고 따라잡기 위해 추적)
  private scheduledSources: Set<AudioBufferSourceNode> = new Set();

  // 재생 대기열이 이 시간(초) 이상 밀리면 밀린 음성을 버리고 최신 위치로 점프해 원본과 싱크 유지
  private static readonly MAX_BACKLOG = 1.2;

  constructor() {}

  /**
   * 플레이어 초기화 (첫 재생 전 오디오 컨텍스트 확보)
   */
  init(): void {
    if (this.audioContext) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate: this.sampleRate });
    // 모든 음성 소스가 거쳐 가는 볼륨 조절용 GainNode
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.volume;
    this.gainNode.connect(this.audioContext.destination);
    this.nextPlayTime = this.audioContext.currentTime;
  }

  /**
   * 번역 음성 출력 볼륨 설정 (0 ~ 1). 재생 도중에도 즉시 반영
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  /**
   * base64 형태의 24kHz PCM 오디오 청크를 받아 재생 대기열에 추가
   */
  playChunk(base64Data: string): void {
    this.init();
    if (!this.audioContext) return;

    // 1. Base64 디코딩하여 ArrayBuffer 획득
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 2. 16-bit PCM (Int16) -> Float32 변환
    const int16Buffer = new Int16Array(bytes.buffer);
    const float32Buffer = new Float32Array(int16Buffer.length);

    for (let i = 0; i < int16Buffer.length; i++) {
      float32Buffer[i] = int16Buffer[i] / 32768.0;
    }

    // 3. AudioBuffer 생성
    const audioBuffer = this.audioContext.createBuffer(1, float32Buffer.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(float32Buffer);

    const currentTime = this.audioContext.currentTime;

    // 재생 스케줄 보정
    if (this.nextPlayTime < currentTime) {
      // 네트워크 끊김/지연으로 스케줄이 과거라면 즉시 재생으로 조정
      this.nextPlayTime = currentTime + 0.05; // 50ms 미세 버퍼링
    } else if (this.nextPlayTime - currentTime > AudioPlayer.MAX_BACKLOG) {
      // 번역 음성이 원본보다 길어 큐가 한계 이상 밀리면,
      // 겹쳐 재생(같은 말 반복처럼 들림)하지 않도록 밀린 음성을 전부 버리고 최신 위치로 점프
      this.flushScheduled();
      this.nextPlayTime = currentTime + 0.05;
    }

    // 4. 버퍼 소스 노드를 볼륨 노드를 거쳐 스케줄링에 맞춰 연결 및 실행
    const sourceNode = this.audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(this.gainNode ?? this.audioContext.destination);

    sourceNode.onended = () => {
      this.scheduledSources.delete(sourceNode);
    };
    this.scheduledSources.add(sourceNode);

    sourceNode.start(this.nextPlayTime);

    // 다음 플레이 스케줄링 시점 누적 (버퍼 지속시간 = 샘플개수 / 샘플레이트)
    this.nextPlayTime += audioBuffer.duration;
  }

  /**
   * 스케줄된(아직 재생 안 끝난) 모든 소스 노드를 즉시 중단하고 비움
   */
  private flushScheduled(): void {
    for (const node of this.scheduledSources) {
      try {
        node.onended = null;
        node.stop();
      } catch {
        // 이미 끝났거나 아직 시작 안 된 노드는 무시
      }
    }
    this.scheduledSources.clear();
  }

  /**
   * 재생 중지 및 재생기 초기화
   */
  stop(): void {
    this.flushScheduled();
    if (this.audioContext) {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.gainNode = null;
    this.nextPlayTime = 0;
  }
}
