/**
 * 실시간 마이크/시스템 오디오 녹음 및 16kHz 16-bit PCM 변환 유틸리티 (하드웨어 샘플레이트 자동 리샘플링 대응)
 */

export interface RecorderOptions {
  source: 'mic' | 'system';
  deviceId?: string; // source === 'mic' 일 때 getUserMedia 의 deviceId: { exact }
}

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
   * @param options 입력 소스 ('mic' | 'system') 및 장치 ID 설정
   */
  async start(options: RecorderOptions): Promise<void> {
    const { source, deviceId } = options;

    if (source === 'system') {
      // 탭/화면 소리 캡처: 사용자가 공유할 화면/창/탭을 고르고 '오디오 공유'를 체크해야 함
      try {
        this.stream = await navigator.mediaDevices.getDisplayMedia({
          video: true, // 브라우저 규격상 video:true가 있어야 선택 UI가 뜸 (영상 트랙은 사용하지 않음)
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (err: unknown) {
        console.error('getDisplayMedia 실패:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`화면/시스템 소리 캡처를 시작하지 못했습니다: ${errMsg}`, { cause: err });
      }

      if (this.stream.getAudioTracks().length === 0) {
        this.stop();
        throw new Error(
          "선택한 화면에 오디오가 포함되지 않았습니다. 텔레그램 창이나 전체 화면을 공유할 때 '시스템 오디오 공유(Share system/tab audio)'를 반드시 체크해 주세요."
        );
      }
    } else {
      // 마이크 오디오 캡처
      if (deviceId) {
        // 특정 deviceId가 지정된 경우 정확한 장치를 획득. 실패 시 기본 장치로 폴백하지 않고 즉시 에러 발생
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: deviceId },
              echoCancellation: true,
              noiseSuppression: true,
            },
            video: false,
          });
        } catch (err: unknown) {
          console.error('지정된 마이크 획득 실패:', err);
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new Error(`지정한 마이크 장치(${deviceId})를 열 수 없습니다: ${errMsg}`, { cause: err });
        }
      } else {
        // 기본 마이크 획득 시도 (실패 시 최소 제약조건으로 순차 폴백)
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
            },
            video: false,
          });
        } catch (firstErr) {
          console.warn('상세 옵션으로 마이크 획득 실패, 기본 옵션으로 재시도:', firstErr);
          try {
            this.stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false,
            });
          } catch (err: unknown) {
            console.error('navigator.mediaDevices.getUserMedia 실패:', err);
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new Error(`마이크 권한을 승인받지 못했거나 기기를 찾을 수 없습니다: ${errMsg}`, { cause: err });
          }
        }
      }
    }

    try {
      // AudioContext 초기화 (기기 기본 샘플레이트 활용)
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('이 브라우저는 AudioContext를 지원하지 않습니다.');
      }
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
    } catch (err: unknown) {
      console.error('AudioContext 연결 생성 실패:', err);
      this.stop();
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`오디오 파이프라인 생성 실패: ${errMsg}`, { cause: err });
    }
  }

  /**
   * 녹음 정지 및 자원 해제
   */
  stop(): void {
    if (this.processor && this.source) {
      try {
        this.processor.disconnect();
      } catch {
        /* noop */
      }
      try {
        this.source.disconnect();
      } catch {
        /* noop */
      }
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
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      const sample = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i * 2, sample, true); // true = Little-Endian
    }

    return buffer;
  }
}
