import { AudioPlayer } from './audioPlayer';

/**
 * 하나의 Gemini Live 번역 WebSocket 세션을 캡슐화.
 * - 단방향(영상 더빙/마이크)에서는 1개,
 * - 대면 양방향 통역에서는 서로 반대 타깃으로 2개를 띄워 사용한다.
 */

export interface SessionTranscript {
  id: string;
  role: 'input' | 'output';
  text: string;
  langCode?: string;
}

export interface TranslationSessionCallbacks {
  /** 연결/재연결/오류 등 상태 변화 */
  onStatus?: (state: 'open' | 'reconnecting' | 'closed', detail?: { code?: number; clean?: boolean; attempt?: number }) => void;
  /** 자막(누적된 전체 텍스트)이 갱신될 때마다 호출. App은 id 기준으로 upsert */
  onTranscript?: (t: SessionTranscript) => void;
}

export interface TranslationSessionOptions {
  apiKey: string;
  targetLang: string;
  echoTargetLanguage: boolean;
  autoReconnect?: boolean;
  volume?: number;
  /** 입력(원문) 자막도 보고할지. 양방향에서는 중복이라 false로 끈다 */
  emitInputTranscript?: boolean;
  /** 번역 음성 출력 목소리 이름 (예: Puck, Kore 등) */
  voiceName?: string;
}

const MODEL_NAME = 'gemini-3.5-live-translate-preview';
const MAX_RECONNECT = 5;

export class TranslationSession {
  readonly player: AudioPlayer;
  private ws: WebSocket | null = null;
  private opts: TranslationSessionOptions;
  private cb: TranslationSessionCallbacks;
  private closedByUser = false;
  private reconnectAttempts = 0;

  // 델타 누적용: 현재 발화 턴의 입력/출력 말풍선 상태
  private inputId: string | null = null;
  private outputId: string | null = null;
  private inputText = '';
  private outputText = '';

  constructor(opts: TranslationSessionOptions, cb: TranslationSessionCallbacks = {}) {
    this.opts = opts;
    this.cb = cb;
    this.player = new AudioPlayer();
  }

  /** 세션 시작 (오디오 플레이어 + WebSocket 연결) */
  connect(): void {
    this.closedByUser = false;
    this.player.init();
    this.player.setVolume(this.opts.volume ?? 1);
    this.openSocket();
  }

  /** 마이크/시스템 오디오 청크(base64 PCM 16k)를 서버로 전송 */
  sendAudioBase64(base64Data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ data: base64Data, mimeType: 'audio/pcm;rate=16000' }],
        },
      }));
    }
  }

  setVolume(volume: number): void {
    this.player.setVolume(volume);
  }

  /** 사용자가 의도적으로 종료 (자동 재연결 안 함) */
  close(): void {
    this.closedByUser = true;
    try { this.player.stop(); } catch { /* noop */ }
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
  }

  private buildWsUrl(): string {
    const isSecure = window.location.protocol === 'https:';
    const wsProtocol = isSecure ? 'wss:' : 'ws:';
    return `${wsProtocol}//${window.location.host}/ws-api/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.opts.apiKey}`;
  }

  private buildSetupMessage() {
    const voiceConfig = this.opts.voiceName ? {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: this.opts.voiceName,
        },
      },
    } : undefined;

    return {
      setup: {
        model: `models/${MODEL_NAME}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          ...(voiceConfig ? { speechConfig: voiceConfig } : {}),
          translationConfig: {
            targetLanguageCode: this.opts.targetLang,
            echoTargetLanguage: this.opts.echoTargetLanguage,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // 여러 명이 빠르게 번갈아 말하는 상황에서 화자 전환을 잘 잡도록 발화 감지(VAD) 튜닝
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 60,
            silenceDurationMs: 200,
          },
        },
      },
    };
  }

  private openSocket(): void {
    const ws = new WebSocket(this.buildWsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.cb.onStatus?.('open');
      ws.send(JSON.stringify(this.buildSetupMessage()));
    };

    ws.onmessage = async (event) => {
      try {
        // Gemini Live 서버는 응답을 바이너리(Blob) 프레임으로 보내므로 텍스트로 변환 후 파싱
        const raw = event.data instanceof Blob ? await event.data.text() : event.data;
        const response = JSON.parse(raw);
        if (response.serverContent) this.handleServerContent(response.serverContent);
      } catch (err) {
        console.error('웹소켓 메시지 파싱 오류:', err);
      }
    };

    ws.onerror = (e) => {
      console.error('웹소켓 에러 상세:', e);
    };

    ws.onclose = (e) => {
      console.log('웹소켓 종료됨 - Code:', e.code, 'Reason:', e.reason, 'WasClean:', e.wasClean);
      if (this.closedByUser) {
        this.cb.onStatus?.('closed', { code: e.code, clean: true });
        return;
      }
      // 비정상 종료 시 자동 재연결 (장시간 영상/회의 안정성)
      if (this.opts.autoReconnect && this.reconnectAttempts < MAX_RECONNECT) {
        this.reconnectAttempts++;
        this.cb.onStatus?.('reconnecting', { attempt: this.reconnectAttempts });
        const delay = Math.min(500 * this.reconnectAttempts, 3000);
        setTimeout(() => {
          if (!this.closedByUser) this.openSocket();
        }, delay);
      } else {
        this.cb.onStatus?.('closed', { code: e.code, clean: e.wasClean });
      }
    };
  }

  private handleServerContent(content: any): void {
    // 입력(원문) 자막 누적
    if (this.opts.emitInputTranscript !== false) {
      const inT = content.inputTranscription ?? content.input_transcription;
      if (inT?.text) {
        if (!this.inputId) this.inputId = randomId();
        this.inputText += inT.text;
        this.cb.onTranscript?.({
          id: this.inputId,
          role: 'input',
          text: this.inputText,
          langCode: inT.languageCode ?? inT.language_code,
        });
      }
    }

    // 출력(번역) 자막 누적
    const outT = content.outputTranscription ?? content.output_transcription;
    if (outT?.text) {
      if (!this.outputId) this.outputId = randomId();
      this.outputText += outT.text;
      this.cb.onTranscript?.({
        id: this.outputId,
        role: 'output',
        text: this.outputText,
        langCode: this.opts.targetLang,
      });
    }

    // 번역된 오디오 청크 재생
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData) this.player.playChunk(part.inlineData.data);
      }
    }

    // 발화 턴 종료 → 다음 문장은 새 말풍선으로 시작
    if (content.turnComplete || content.generationComplete) {
      this.inputId = null;
      this.outputId = null;
      this.inputText = '';
      this.outputText = '';
    }
  }
}

function randomId(): string {
  return Math.random().toString(36).substr(2, 9);
}
