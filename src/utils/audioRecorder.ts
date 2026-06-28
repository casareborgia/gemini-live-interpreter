/**
 * 실시간 마이크 오디오 녹음 및 16kHz 16-bit PCM 변환 유틸리티 (하드웨어 샘플레이트 자동 리샘플링 대응)
 */
export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onAudioChunk: (chunk: ArrayBuffer) => void;

  constructor(onAudioChunk: (chunk: ArrayBuffer) => void) {
    this.onAudioChunk = onAudioChunk;
  }

  /**
   * 오디오 녹음 시작
   * @param source 'mic' = 내 마이크 / 'system' = 재생 중인 탭·화면의 소리(영상 더빙용)
   */
  async start(source: 'mic' | 'system' = 'mic'): Promise<void> {
    if (source === 'system') {
      // 탭/화면 소리 캡처: 사용자가 공유할 탭을 고르고 '탭 오디오 공유'를 체크해야 함
      try {
        this.stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, // 브라우저 규격상 video:true가 있어야 탭 선택 UI가 뜸 (영상 트랙은 사용하지 않음)
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (err: any) {
        console.error('getDisplayMedia 실패:', err);
        throw new Error(`화면/탭 소리 캡처를 시작하지 못했습니다: ${err.name || err.message}`);
      }

      if (this.stream.getAudioTracks().length === 0) {
        this.stop();
        throw new Error("선택한 화면에 소리가 없습니다. 탭을 공유하면서 '탭 오디오 공유(Share tab audio)'를 반드시 체크해 주세요.");
      }
    } else {
      try {
        // 마이크 권한 요청 (블루투스 헤드셋 및 다중 입출력 기기 대응을 위해 단순한 true부터 순차 폴백 시도)
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
            },
            video: false,
          });
        } catch (firstErr) {
          console.warn('상세 옵션으로 마이크 획득 실패, 기본값으로 재시도:', firstErr);
          // 제약 조건을 최소화하여 장치 탐색 오류 방지
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        }
      } catch (err: any) {
        console.error('navigator.mediaDevices.getUserMedia 실패:', err);
        throw new Error(`마이크 권한을 승인받지 못했거나 기기를 찾을 수 없습니다: ${err.name || err.message}`);
      }
    }

    try {
      // 2. AudioContext 초기화 (기기 기본 샘플레이트 활용)
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass();
      
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      
      // 버퍼 사이즈 4096 (적정한 주기 설정)
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      const inputSampleRate = this.audioContext.sampleRate;

      this.processor.onaudioprocess = (e) => {
        if (!this.audioContext) return;
        
        const inputData = e.inputBuffer.getChannelData(0); // Float32Array
        
        // 입력 기기 샘플레이트에서 16kHz로 소프트웨어 다운샘플링 리샘플링 실행
        const resampledData = this.resampleTo16k(inputData, inputSampleRate);
        const pcm16Buffer = this.convertToPCM16(resampledData);
        
        this.onAudioChunk(pcm16Buffer);
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      // AudioContext가 정지 상태일 수 있으므로 재개
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
    } catch (err: any) {
      console.error('AudioContext 연결 생성 실패:', err);
      this.stop();
      throw new Error(`오디오 파이프라인 생성 실패: ${err.message}`);
    }
  }

  /**
   * 녹음 정지 및 자원 해제
   */
  stop(): void {
    if (this.processor && this.source) {
      this.processor.disconnect();
      this.source.disconnect();
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
    }

    this.processor = null;
    this.source = null;
    this.stream = null;
    this.audioContext = null;
  }

  /**
   * 임의의 입력 샘플레이트 버퍼를 16000Hz 속도로 선형 보간 다운샘플링
   */
  private resampleTo16k(inputBuffer: Float32Array, inputSampleRate: number): Float32Array {
    if (inputSampleRate === 16000) {
      return inputBuffer;
    }
    
    const sampleRateRatio = inputSampleRate / 16000;
    const newLength = Math.round(inputBuffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    
    let offsetResult = 0;
    let offsetInput = 0;
    
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      
      // 선형 보간 (Linear Interpolation) 계산
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
        accum += inputBuffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      
      offsetResult++;
      offsetInput = nextOffsetBuffer;
    }
    
    return result;
  }

  /**
   * Float32Array 오디오 데이터를 16-bit Signed PCM (Little-Endian) ArrayBuffer로 변환
   */
  private convertToPCM16(float32Array: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      const sample = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(i * 2, sample, true); // true = Little-Endian
    }

    return buffer;
  }
}
