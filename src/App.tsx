import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder } from './utils/audioRecorder';
import { TranslationSession, type SessionTranscript } from './utils/translationSession';
import { CallSettings } from './components/CallSettings';
import {
  CallTranscriptView,
  type CallTranscriptMessage,
} from './components/CallTranscriptView';

interface TranscriptItem {
  id: string;
  type: 'input' | 'output';
  text: string;
  langCode?: string;
  timestamp: Date;
  side?: 'A' | 'B'; // 대면 양방향 모드에서 어느 화자 쪽 자막인지
  speaker?: string; // 화자 식별 정보 (SPEAKER_00, SPEAKER_01 등)
  frozen?: boolean; // 화자 전환으로 인해 해당 턴이 닫혔는지 여부
}

// 통역 모드: single = 영상 더빙/마이크 단방향, dual = 대면 양방향, call = 영상통화 양방향
type Mode = 'single' | 'dual' | 'call';

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const SUPPORTED_LANGUAGES = [
  { code: 'ko', name: '한국어 (Korean)' },
  { code: 'en', name: '영어 (English)' },
  { code: 'ja', name: '일본어 (Japanese)' },
  { code: 'zh-Hans', name: '중국어 간체 (Chinese Simplified)' },
  { code: 'es', name: '스페인어 (Spanish)' },
  { code: 'fr', name: '프랑스어 (French)' },
  { code: 'de', name: '독일어 (German)' },
  { code: 'it', name: '이탈리아어 (Italian)' },
  { code: 'pl', name: '폴란드어 (Polish)' },
];

// 통역할 소리를 어디서 가져올지: 내 마이크 vs 재생 중인 영상/탭 소리
type InputSource = 'mic' | 'system';

interface SessionStatusState {
  state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  detail?: string;
}

function App() {
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_API_KEY') || '';
  });
  const [mode, setMode] = useState<Mode>('single');
  const [targetLang, setTargetLang] = useState<string>('ko');
  const [langA, setLangA] = useState<string>('ko'); // 대면 양방향: 내 언어
  const [langB, setLangB] = useState<string>('en'); // 대면 양방향: 상대 언어
  const [inputSource, setInputSource] = useState<InputSource>('mic');
  const [voiceNameA, setVoiceNameA] = useState<string>(() => {
    return (
      localStorage.getItem('GEMINI_LIVE_VOICE_NAME_A') ||
      localStorage.getItem('GEMINI_LIVE_VOICE_NAME') ||
      'Kore'
    );
  });
  const [voiceNameB, setVoiceNameB] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_VOICE_NAME_B') || 'Puck'; // 기본값 남성 Puck
  });
  const [echoTarget, setEchoTarget] = useState<boolean>(true);
  const [outputVolume, setOutputVolume] = useState<number>(1); // 번역 음성 볼륨 (0 ~ 1)
  const [subtitleOnly, setSubtitleOnly] = useState<boolean>(false); // 자막 전용(더빙 음성 끄기)
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('API 키를 입력하고 통역을 시작하세요.');
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [maxSpeakers, setMaxSpeakers] = useState<number>(() => {
    return Number(localStorage.getItem('GEMINI_LIVE_MAX_SPEAKERS')) || 0; // 기본값 0 (자동)
  });

  // 영상통화(Call Mode) 설정 상태
  const [callMyLang, setCallMyLang] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_MY_LANG') || 'ko';
  });
  const [callRemoteLang, setCallRemoteLang] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_REMOTE_LANG') || 'en';
  });
  const [callMicDeviceId, setCallMicDeviceId] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_MIC_DEVICE_ID') || '';
  });
  const [callInboundSinkId, setCallInboundSinkId] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_INBOUND_SINK_ID') || '';
  });
  const [callOutboundSinkId, setCallOutboundSinkId] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_OUTBOUND_SINK_ID') || '';
  });
  const [callInboundAudio, setCallInboundAudio] = useState<boolean>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_INBOUND_AUDIO') !== 'false';
  });
  // 송신 번역 음성을 내 스피커로도 재생할지 (기본 꺼짐: 스피커로 나가면 화면 캡처/마이크로 되돌아와 하울링이 됨)
  const [callOutboundMonitor, setCallOutboundMonitor] = useState<boolean>(() => {
    return localStorage.getItem('GEMINI_LIVE_CALL_OUTBOUND_MONITOR') === 'true';
  });
  // 송신 번역 음성이 실제로 재생되는 조건: 전용 출력 장치(BlackHole 등)를 골랐거나 모니터링을 켰을 때
  const outboundAudible = Boolean(callOutboundSinkId) || callOutboundMonitor;

  // 영상통화 모드 전용 자막 및 상태
  const [inboundTranscripts, setInboundTranscripts] = useState<CallTranscriptMessage[]>([]);
  const [outboundTranscripts, setOutboundTranscripts] = useState<CallTranscriptMessage[]>([]);
  const [inboundStatus, setInboundStatus] = useState<SessionStatusState>({ state: 'idle' });
  const [outboundStatus, setOutboundStatus] = useState<SessionStatusState>({ state: 'idle' });

  // 세션 및 파이프라인 Ref
  const recordersRef = useRef<AudioRecorder[]>([]);
  const sessionsRef = useRef<TranslationSession[]>([]);
  const inboundSessionRef = useRef<TranslationSession | null>(null);
  const outboundSessionRef = useRef<TranslationSession | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const backendWsRef = useRef<WebSocket | null>(null);
  const currentSpeakerRef = useRef<string>('SPEAKER_00');

  // 실제 적용되는 출력 볼륨 (자막 전용이면 0)
  const effectiveVolume = subtitleOnly ? 0 : outputVolume;

  // 로컬 스토리지 동기화
  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_API_KEY', apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_VOICE_NAME_A', voiceNameA);
  }, [voiceNameA]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_VOICE_NAME_B', voiceNameB);
  }, [voiceNameB]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_MAX_SPEAKERS', String(maxSpeakers));
  }, [maxSpeakers]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_MY_LANG', callMyLang);
  }, [callMyLang]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_REMOTE_LANG', callRemoteLang);
  }, [callRemoteLang]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_MIC_DEVICE_ID', callMicDeviceId);
  }, [callMicDeviceId]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_INBOUND_SINK_ID', callInboundSinkId);
  }, [callInboundSinkId]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_OUTBOUND_SINK_ID', callOutboundSinkId);
  }, [callOutboundSinkId]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_INBOUND_AUDIO', String(callInboundAudio));
  }, [callInboundAudio]);

  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_CALL_OUTBOUND_MONITOR', String(callOutboundMonitor));
  }, [callOutboundMonitor]);

  // 대화 기록 추가 시 자동 스크롤
  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  // 볼륨 변경 시 진행 중인 세션에 즉시 반영
  useEffect(() => {
    if (mode === 'call') {
      inboundSessionRef.current?.setVolume(callInboundAudio ? effectiveVolume : 0);
      outboundSessionRef.current?.setVolume(outboundAudible ? effectiveVolume : 0);
    } else {
      for (const session of sessionsRef.current) {
        session.setVolume(effectiveVolume);
      }
    }
  }, [effectiveVolume, callInboundAudio, outboundAudible, mode]);

  // 통화 모드 출력 장치 변경 시 즉시 반영
  useEffect(() => {
    if (inboundSessionRef.current) {
      inboundSessionRef.current.setSinkId(callInboundSinkId).catch(() => {});
    }
  }, [callInboundSinkId]);

  useEffect(() => {
    if (outboundSessionRef.current) {
      outboundSessionRef.current.setSinkId(callOutboundSinkId).catch(() => {});
    }
  }, [callOutboundSinkId]);

  /**
   * 레코더/세션/백엔드 소켓 등 모든 자원만 해제 (UI 상태는 건드리지 않음 — 언마운트 정리용)
   */
  const releaseResources = useCallback(() => {
    // 모든 레코더 정지
    for (const rec of recordersRef.current) {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    recordersRef.current = [];

    // 화자 분할 WebSocket 정리
    if (backendWsRef.current) {
      try {
        backendWsRef.current.close();
      } catch {
        /* noop */
      }
      backendWsRef.current = null;
    }

    // 모든 세션 정리
    for (const session of sessionsRef.current) {
      try {
        session.close();
      } catch {
        /* noop */
      }
    }
    sessionsRef.current = [];
    inboundSessionRef.current = null;
    outboundSessionRef.current = null;
  }, []);

  /**
   * 통역 세션 중지: 자원 해제 + UI 상태 갱신.
   * message 를 주면 그 메시지를 표시 (오류 원인이 기본 문구에 덮어써지지 않도록).
   */
  const stopTranslationSession = useCallback(
    (message?: string) => {
      releaseResources();
      setIsTranslating(false);
      setStatusMessage(typeof message === 'string' ? message : '통역 세션이 중지되었습니다.');
      // 실제로 열려 있던 세션은 onStatus('closed') 콜백이 '종료됨'으로 갱신하고,
      // 연결 전에 실패한 세션은 대기 상태로 되돌린다.
      setInboundStatus({ state: 'idle' });
      setOutboundStatus({ state: 'idle' });
    },
    [releaseResources]
  );

  // 컴포넌트 언마운트 시 자원만 정리 (StrictMode 이중 마운트에서 UI 상태가 바뀌지 않도록)
  useEffect(() => {
    return () => {
      releaseResources();
    };
  }, [releaseResources]);

  // 세션이 보내온 자막(누적 텍스트) upsert (single/dual 모드용)
  const upsertTranscript = (t: SessionTranscript, side?: 'A' | 'B') => {
    setTranscripts((prev) => {
      const idx = prev.findIndex((it) => it.id === t.id);
      const existingSpeaker = idx >= 0 ? prev[idx].speaker : undefined;
      const existingFrozen = idx >= 0 ? prev[idx].frozen : false;

      const item: TranscriptItem = {
        id: t.id,
        type: t.role,
        text: t.text,
        langCode: t.langCode,
        timestamp: new Date(),
        side,
        speaker: t.role === 'input' ? existingSpeaker || currentSpeakerRef.current : undefined,
        frozen: existingFrozen,
      };
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...prev[idx], ...item };
        return updated;
      }
      return [...prev, item];
    });
  };

  // 통화 모드 세션 자막 upsert
  const upsertCallTranscript = (
    setter: React.Dispatch<React.SetStateAction<CallTranscriptMessage[]>>,
    t: SessionTranscript
  ) => {
    setter((prev) => {
      const idx = prev.findIndex((it) => it.id === t.id);
      const item: CallTranscriptMessage = {
        id: t.id,
        type: t.role,
        text: t.text,
        langCode: t.langCode,
        timestamp: new Date(),
      };
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...prev[idx], ...item };
        return updated;
      }
      return [...prev, item];
    });
  };

  // 세션 연결 상태 변화 처리 (single / dual 모드용)
  const handleSessionStatus = (
    state: 'open' | 'reconnecting' | 'closed',
    detail?: { code?: number; clean?: boolean; attempt?: number }
  ) => {
    if (state === 'open') {
      setStatusMessage('✨ 실시간 통역이 활성화되었습니다. 말씀하세요.');
    } else if (state === 'reconnecting') {
      setStatusMessage(`⚠️ 연결이 끊겨 재연결 시도 중입니다 (${detail?.attempt}/5)...`);
    } else if (state === 'closed' && !detail?.clean) {
      stopTranslationSession(
        `⚠️ 연결이 종료되었습니다 (코드: ${detail?.code}). API 키 권한/모델 지원을 확인하세요.`
      );
    }
  };

  const startTranslationSession = async () => {
    if (!apiKey.trim()) {
      setStatusMessage('⚠️ 먼저 Gemini API 키를 입력해 주세요.');
      return;
    }

    if (mode === 'dual' && langA === langB) {
      setStatusMessage('⚠️ 대면 통역은 서로 다른 두 언어를 선택해야 합니다.');
      return;
    }

    if (mode === 'call' && callMyLang === callRemoteLang) {
      setStatusMessage('⚠️ 영상통화 통역은 내 언어와 상대방 언어가 달라야 합니다.');
      return;
    }

    try {
      setIsTranslating(true);

      // ==========================================
      // Mode 3: 영상통화 통역 (Call Mode)
      // ==========================================
      if (mode === 'call') {
        setStatusMessage('📞 영상통화 세션 준비 중...');
        setInboundStatus({ state: 'connecting' });
        setOutboundStatus({ state: 'connecting' });

        // 1. 수신 세션 준비 (상대 소리 -> 내 언어 번역)
        const inboundSession = new TranslationSession(
          {
            apiKey,
            targetLang: callMyLang,
            echoTargetLanguage: false,
            emitInputTranscript: true,
            autoReconnect: true,
            volume: callInboundAudio ? effectiveVolume : 0,
            voiceName: voiceNameB, // 상대 목소리용
            sinkId: callInboundSinkId || undefined,
          },
          {
            onStatus: (state, detail) => {
              if (state === 'open') {
                setInboundStatus({ state: 'open' });
              } else if (state === 'reconnecting') {
                setInboundStatus({
                  state: 'reconnecting',
                  detail: `재연결 중 (${detail?.attempt}/5)`,
                });
              } else if (state === 'closed') {
                setInboundStatus({
                  state: 'closed',
                  detail: detail?.clean ? '종료됨' : `연결 끊김 (${detail?.code})`,
                });
                // 통화 모드에서는 한 세션이 닫혀도 다른 세션은 계속 유지!
              }
            },
            onTranscript: (t) => upsertCallTranscript(setInboundTranscripts, t),
          }
        );

        // 2. 송신 세션 준비 (내 소리 -> 상대 언어 번역)
        const outboundSession = new TranslationSession(
          {
            apiKey,
            targetLang: callRemoteLang,
            echoTargetLanguage: false,
            emitInputTranscript: true,
            autoReconnect: true,
            volume: outboundAudible ? effectiveVolume : 0,
            voiceName: voiceNameA, // 내 목소리용
            sinkId: callOutboundSinkId || undefined,
          },
          {
            onStatus: (state, detail) => {
              if (state === 'open') {
                setOutboundStatus({ state: 'open' });
              } else if (state === 'reconnecting') {
                setOutboundStatus({
                  state: 'reconnecting',
                  detail: `재연결 중 (${detail?.attempt}/5)`,
                });
              } else if (state === 'closed') {
                setOutboundStatus({
                  state: 'closed',
                  detail: detail?.clean ? '종료됨' : `연결 끊김 (${detail?.code})`,
                });
              }
            },
            onTranscript: (t) => upsertCallTranscript(setOutboundTranscripts, t),
          }
        );

        inboundSessionRef.current = inboundSession;
        outboundSessionRef.current = outboundSession;
        sessionsRef.current = [inboundSession, outboundSession];

        // 3. 수신 레코더 시작 (시스템/창 오디오 캡처)
        setStatusMessage(
          '공유할 텔레그램 창/화면을 선택해 주세요 (오디오 공유 체크 필수)...'
        );
        const inboundRecorder = new AudioRecorder((chunk: ArrayBuffer) => {
          const base64Data = arrayBufferToBase64(chunk);
          inboundSession.sendAudioBase64(base64Data);
        });
        // start 를 기다리기 전에 등록해야, 송신 레코더가 실패해도 화면 캡처가 정리된다
        recordersRef.current.push(inboundRecorder);
        await inboundRecorder.start({ source: 'system' });

        // 4. 송신 레코더 시작 (내 마이크 오디오 캡처)
        setStatusMessage('내 마이크 연결 중...');
        const outboundRecorder = new AudioRecorder((chunk: ArrayBuffer) => {
          const base64Data = arrayBufferToBase64(chunk);
          outboundSession.sendAudioBase64(base64Data);
        });
        recordersRef.current.push(outboundRecorder);
        await outboundRecorder.start({
          source: 'mic',
          deviceId: callMicDeviceId || undefined,
        });

        // 5. 세션 WebSocket 연결 시작 (화자 분할 WS는 통화 모드에서 미사용)
        inboundSession.connect();
        outboundSession.connect();

        setStatusMessage('✨ 영상통화 양방향 통역이 활성화되었습니다.');
        return;
      }

      // ==========================================
      // Mode 1, 2: 단방향(single) 및 대면 양방향(dual)
      // ==========================================
      if (mode === 'single') {
        const isProduction = import.meta.env.PROD;
        const backendUrl = isProduction
          ? (import.meta.env.VITE_BACKEND_URL ||
              'wss://translation-backend-517419857386.asia-northeast3.run.app')
          : 'ws://localhost:8000';
        const backendWs = new WebSocket(`${backendUrl}/ws/audio?max_speakers=${maxSpeakers}`);
        backendWsRef.current = backendWs;

        backendWs.onopen = () => {
          console.log('Connected to local diarization backend');
        };

        backendWs.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'speaker_merged') {
              setTranscripts((prev) =>
                prev.map((it) => (it.speaker === msg.from ? { ...it, speaker: msg.into } : it))
              );
              if (currentSpeakerRef.current === msg.from) {
                currentSpeakerRef.current = msg.into;
              }
              return;
            }
            if (msg.type === 'diarization') {
              if (msg.speaker === 'SILENCE') {
                setStatusMessage('✨ 대화 대기 중... (음소거 상태)');
              } else {
                const prevSpeaker = currentSpeakerRef.current;
                const nextSpeaker = msg.speaker;

                if (prevSpeaker !== nextSpeaker && prevSpeaker !== 'SILENCE') {
                  for (const session of sessionsRef.current) {
                    session.splitTurn();
                  }
                  setTranscripts((prev) =>
                    prev.map((it) => (it.type === 'input' ? { ...it, frozen: true } : it))
                  );
                }

                currentSpeakerRef.current = nextSpeaker;
                setStatusMessage(`🗣️ 화자 감지됨: ${nextSpeaker} (실시간 통역 진행 중)`);

                setTranscripts((prev) => {
                  if (prev.length === 0) return prev;
                  const updated = [...prev];
                  for (let i = updated.length - 1; i >= 0; i--) {
                    if (updated[i].type === 'input') {
                      if (!updated[i].frozen) {
                        updated[i].speaker = nextSpeaker;
                      }
                      break;
                    }
                  }
                  return updated;
                });
              }
            }
          } catch (err) {
            console.error('Diarization message parsing error:', err);
          }
        };

        backendWs.onclose = () => {
          console.log('Disconnected from local diarization backend');
        };
      }

      // 단일 레코더 준비 (single/dual 공용)
      const recorder = new AudioRecorder((chunk: ArrayBuffer) => {
        const base64Data = arrayBufferToBase64(chunk);
        for (const session of sessionsRef.current) {
          session.sendAudioBase64(base64Data);
        }
        if (mode === 'single' && backendWsRef.current?.readyState === WebSocket.OPEN) {
          backendWsRef.current.send(chunk);
        }
      });
      recordersRef.current = [recorder];

      const source: InputSource = mode === 'dual' ? 'mic' : inputSource;
      setStatusMessage(
        source === 'system'
          ? '공유할 탭/화면을 선택해 주세요 (탭 오디오 공유 체크 필수)...'
          : '마이크 권한 요청 중...'
      );
      await recorder.start({ source });

      setStatusMessage('연결 설정 중...');

      if (mode === 'dual') {
        const sessionA = new TranslationSession(
          {
            apiKey,
            targetLang: langB,
            echoTargetLanguage: false,
            autoReconnect: true,
            volume: effectiveVolume,
            emitInputTranscript: false,
            voiceName: voiceNameA,
            getCurrentSpeaker: () => currentSpeakerRef.current,
          },
          { onStatus: handleSessionStatus, onTranscript: (t) => upsertTranscript(t, 'B') }
        );
        const sessionB = new TranslationSession(
          {
            apiKey,
            targetLang: langA,
            echoTargetLanguage: false,
            autoReconnect: true,
            volume: effectiveVolume,
            emitInputTranscript: false,
            voiceName: voiceNameB,
            getCurrentSpeaker: () => currentSpeakerRef.current,
          },
          { onStatus: handleSessionStatus, onTranscript: (t) => upsertTranscript(t, 'A') }
        );
        sessionsRef.current = [sessionA, sessionB];
      } else {
        const session = new TranslationSession(
          {
            apiKey,
            targetLang,
            echoTargetLanguage: echoTarget,
            autoReconnect: true,
            volume: effectiveVolume,
            emitInputTranscript: true,
            voiceName: voiceNameA,
            getCurrentSpeaker: () => currentSpeakerRef.current,
          },
          { onStatus: handleSessionStatus, onTranscript: (t) => upsertTranscript(t) }
        );
        sessionsRef.current = [session];
      }

      for (const session of sessionsRef.current) {
        session.connect();
      }
    } catch (error: unknown) {
      console.error(error);
      const errMsg = error instanceof Error ? error.message : String(error);
      stopTranslationSession(`⚠️ 초기화 실패: ${errMsg}`);
    }
  };

  const renderBubble = (item: TranscriptItem) => {
    const isInput = item.type === 'input';

    let speakerColor = 'var(--accent-purple)';
    let speakerBgColor = 'rgba(139, 92, 246, 0.08)';

    if (item.speaker) {
      let hash = 0;
      for (let i = 0; i < item.speaker.length; i++) {
        hash = item.speaker.charCodeAt(i) + ((hash << 5) - hash);
      }
      const colors = [
        { border: 'var(--accent-purple)', bg: 'rgba(139, 92, 246, 0.08)' },
        { border: 'var(--accent-cyan)', bg: 'rgba(6, 182, 212, 0.08)' },
        { border: 'var(--accent-pink)', bg: 'rgba(236, 72, 153, 0.08)' },
        { border: 'var(--accent-yellow)', bg: 'rgba(234, 179, 8, 0.08)' },
      ];
      const index = Math.abs(hash) % colors.length;
      speakerColor = colors[index].border;
      speakerBgColor = colors[index].bg;
    }

    const borderLeftColor = isInput ? `3px solid ${speakerColor}` : '3px solid var(--accent-green)';
    const backgroundColor = isInput ? speakerBgColor : 'rgba(16, 185, 129, 0.08)';

    return (
      <div
        key={item.id}
        style={{
          ...styles.bubbleCard,
          alignSelf: isInput ? 'flex-start' : 'flex-end',
          borderLeft: borderLeftColor,
          backgroundColor: backgroundColor,
        }}
      >
        <div style={styles.bubbleHeader}>
          <span style={styles.bubbleRole}>
            {isInput
              ? `🗣️ 내 음성 ${item.speaker ? `(${item.speaker})` : ''}`
              : '🤖 번역 결과'}
          </span>
          {item.langCode && <span style={styles.bubbleLang}>{item.langCode.toUpperCase()}</span>}
        </div>
        <p style={styles.bubbleText}>{item.text}</p>
        <span style={styles.bubbleTime}>
          {item.timestamp.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </span>
      </div>
    );
  };

  const renderDualSide = (side: 'A' | 'B', langCode: string) => {
    const items = transcripts.filter((t) => t.side === side).slice(-6);
    return (
      <div style={styles.dualScroll}>
        {items.length === 0 ? (
          <div style={styles.dualEmpty}>{langCode.toUpperCase()} 자막이 여기에 표시됩니다</div>
        ) : (
          items.map((item) => (
            <div key={item.id} style={styles.dualBubble}>
              <span style={styles.bubbleLang}>{(item.langCode || langCode).toUpperCase()}</span>
              <p style={styles.dualBubbleText}>{item.text}</p>
            </div>
          ))
        )}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      {/* 상단 네비게이션 헤더 */}
      <header style={styles.header}>
        <div style={styles.logoContainer}>
          <span style={styles.logoIcon}>🌐</span>
          <h1 style={styles.logoText}>Gemini Live Interpreter</h1>
        </div>
        <div style={styles.pwaBadge}>PWA Supported</div>
      </header>

      {/* 설정 패널 */}
      <section style={styles.settingsPanel}>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Google AI Studio API Key</label>
          <input
            type="password"
            placeholder="AI Studio에서 발급받은 API 키를 입력하세요"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={styles.input}
            disabled={isTranslating}
          />
        </div>

        {/* 통역 모드 선택 */}
        <div style={styles.fieldRow}>
          <label style={styles.label}>통역 모드</label>
          <div style={styles.modeToggle}>
            <button
              type="button"
              onClick={() => setMode('single')}
              disabled={isTranslating}
              style={{
                ...styles.modeButton,
                ...(mode === 'single' ? styles.modeButtonActive : {}),
              }}
            >
              🎬 영상·마이크 (단방향)
            </button>
            <button
              type="button"
              onClick={() => setMode('dual')}
              disabled={isTranslating}
              style={{
                ...styles.modeButton,
                ...(mode === 'dual' ? styles.modeButtonActive : {}),
              }}
            >
              💬 대면 양방향
            </button>
            <button
              type="button"
              onClick={() => setMode('call')}
              disabled={isTranslating}
              style={{
                ...styles.modeButton,
                ...(mode === 'call' ? styles.modeButtonActive : {}),
              }}
            >
              📞 영상통화 통역
            </button>
          </div>
        </div>

        {mode === 'call' ? (
          <CallSettings
            myLang={callMyLang}
            onMyLangChange={setCallMyLang}
            remoteLang={callRemoteLang}
            onRemoteLangChange={setCallRemoteLang}
            micDeviceId={callMicDeviceId}
            onMicDeviceIdChange={setCallMicDeviceId}
            inboundSinkId={callInboundSinkId}
            onInboundSinkIdChange={setCallInboundSinkId}
            outboundSinkId={callOutboundSinkId}
            onOutboundSinkIdChange={setCallOutboundSinkId}
            inboundAudio={callInboundAudio}
            onInboundAudioChange={setCallInboundAudio}
            outboundMonitor={callOutboundMonitor}
            onOutboundMonitorChange={setCallOutboundMonitor}
            supportedLanguages={SUPPORTED_LANGUAGES}
            disabled={isTranslating}
          />
        ) : mode === 'single' ? (
          <>
            <div style={styles.fieldRow}>
              <label style={styles.label}>소리 입력 소스</label>
              <select
                value={inputSource}
                onChange={(e) => setInputSource(e.target.value as InputSource)}
                style={styles.select}
                disabled={isTranslating}
              >
                <option value="mic">🎙️ 내 마이크 (직접 말하기)</option>
                <option value="system">🔊 영상/탭 소리 (외국어 영상 더빙)</option>
              </select>
            </div>

            <div style={styles.fieldRow}>
              <label style={styles.label}>화자 식별 수 (상한 설정)</label>
              <select
                value={maxSpeakers}
                onChange={(e) => setMaxSpeakers(Number(e.target.value))}
                style={styles.select}
                disabled={isTranslating}
              >
                <option value={0}>⚙️ 자동 (자기 치유 병합 모드)</option>
                <option value={2}>👥 2명 고정</option>
                <option value={3}>👪 3명 고정</option>
                <option value={4}>👨‍👩‍👧‍👦 4명 고정</option>
              </select>
            </div>

            <div style={styles.fieldRow}>
              <label style={styles.label}>번역 음성 목소리 (성별)</label>
              <select
                value={voiceNameA}
                onChange={(e) => setVoiceNameA(e.target.value)}
                style={styles.select}
                disabled={isTranslating}
              >
                <option value="Kore">👩 여성 음성 (Kore)</option>
                <option value="Puck">👨 남성 음성 (Puck)</option>
              </select>
            </div>

            <div style={styles.gridRow}>
              <div style={styles.fieldCol}>
                <label style={styles.label}>번역 대상 언어</label>
                <select
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  style={styles.select}
                  disabled={isTranslating}
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={styles.fieldCol}>
                <label style={styles.label}>대상 언어 에코(반복)</label>
                <div style={styles.toggleContainer}>
                  <input
                    type="checkbox"
                    id="echoToggle"
                    checked={echoTarget}
                    onChange={(e) => setEchoTarget(e.target.checked)}
                    style={styles.checkbox}
                    disabled={isTranslating}
                  />
                  <label htmlFor="echoToggle" style={styles.toggleLabel}>
                    {echoTarget ? '켜짐 (상대방 언어 반복)' : '꺼짐 (무반응)'}
                  </label>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={styles.gridRow}>
              <div style={styles.fieldCol}>
                <label style={styles.label}>내 언어 (아래쪽 화면)</label>
                <select
                  value={langA}
                  onChange={(e) => setLangA(e.target.value)}
                  style={styles.select}
                  disabled={isTranslating}
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
              </div>
              <div style={styles.fieldCol}>
                <label style={styles.label}>상대 언어 (위쪽·회전)</label>
                <select
                  value={langB}
                  onChange={(e) => setLangB(e.target.value)}
                  style={styles.select}
                  disabled={isTranslating}
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={styles.gridRow}>
              <div style={styles.fieldCol}>
                <label style={styles.label}>내 목소리 번역음 (A)</label>
                <select
                  value={voiceNameA}
                  onChange={(e) => setVoiceNameA(e.target.value)}
                  style={styles.select}
                  disabled={isTranslating}
                >
                  <option value="Kore">👩 여성 음성 (Kore)</option>
                  <option value="Puck">👨 남성 음성 (Puck)</option>
                </select>
              </div>
              <div style={styles.fieldCol}>
                <label style={styles.label}>상대 목소리 번역음 (B)</label>
                <select
                  value={voiceNameB}
                  onChange={(e) => setVoiceNameB(e.target.value)}
                  style={styles.select}
                  disabled={isTranslating}
                >
                  <option value="Kore">👩 여성 음성 (Kore)</option>
                  <option value="Puck">👨 남성 음성 (Puck)</option>
                </select>
              </div>
            </div>
            <span style={styles.hint}>
              기기를 두 사람 사이에 놓으세요. 상대방 쪽(위) 자막은 180° 회전되어 마주 본 사람이 바로
              읽을 수 있습니다.
            </span>
          </>
        )}

        <div style={styles.fieldRow}>
          <label style={styles.label}>
            🔉 번역 음성 볼륨 —{' '}
            {subtitleOnly ? '자막 전용 (음소거)' : `${Math.round(outputVolume * 100)}%`}
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(outputVolume * 100)}
            onChange={(e) => setOutputVolume(Number(e.target.value) / 100)}
            style={styles.slider}
            disabled={subtitleOnly}
          />
          {mode === 'single' && (
            <div style={styles.toggleContainer}>
              <input
                type="checkbox"
                id="subtitleOnlyToggle"
                checked={subtitleOnly}
                onChange={(e) => setSubtitleOnly(e.target.checked)}
                style={styles.checkbox}
              />
              <label htmlFor="subtitleOnlyToggle" style={styles.toggleLabel}>
                📝 자막 전용 모드 (더빙 음성 끄고 자막만 — 원본 소리와 겹침 방지)
              </label>
            </div>
          )}
        </div>
      </section>

      {/* 상태 및 조작 컨트롤 */}
      <section style={styles.controlPanel}>
        <div style={styles.statusBox}>
          <span
            style={{
              ...styles.statusIndicator,
              backgroundColor: isTranslating ? 'var(--accent-green)' : 'var(--text-muted)',
            }}
            className={isTranslating ? 'pulse-active' : ''}
          />
          <span style={styles.statusText}>{statusMessage}</span>
        </div>

        <button
          onClick={() => (isTranslating ? stopTranslationSession() : startTranslationSession())}
          style={{
            ...styles.actionButton,
            backgroundColor: isTranslating ? 'var(--accent-red)' : 'var(--accent-purple)',
          }}
        >
          {isTranslating ? '⏹️ 통역 중지하기' : '🎙️ 실시간 통역 시작'}
        </button>
      </section>

      {/* 실시간 통역 자막 피드 */}
      {mode === 'call' ? (
        <section style={styles.callPanel}>
          <CallTranscriptView
            inboundTranscripts={inboundTranscripts}
            outboundTranscripts={outboundTranscripts}
            inboundStatus={inboundStatus}
            outboundStatus={outboundStatus}
            myLang={callMyLang}
            remoteLang={callRemoteLang}
          />
        </section>
      ) : mode === 'dual' ? (
        <section style={styles.dualPanel}>
          {/* 상대방 쪽 (위, 180도 회전) */}
          <div style={{ ...styles.dualHalf, transform: 'rotate(180deg)' }}>
            {renderDualSide('B', langB)}
          </div>
          <div style={styles.dualDivider} />
          {/* 내 쪽 (아래, 정방향) */}
          <div style={styles.dualHalf}>{renderDualSide('A', langA)}</div>
        </section>
      ) : (
        <section style={styles.feedPanel}>
          <h2 style={styles.feedTitle}>통역 타임라인</h2>
          <div style={styles.timeline}>
            {transcripts.length === 0 ? (
              <div style={styles.emptyFeed}>
                <span style={styles.emptyIcon}>💬</span>
                <p>마이크를 켜고 말씀하시면 실시간 통역 번역본이 아래에 채워집니다.</p>
              </div>
            ) : (
              transcripts.map((item) => renderBubble(item))
            )}
            <div ref={timelineEndRef} />
          </div>
        </section>
      )}
    </div>
  );
}

// 프리미엄 다크 스타일 인라인 정의 (Vanilla CSS와 협업)
const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: '780px',
    width: '100%',
    margin: '0 auto',
    padding: '24px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    flexGrow: 1,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--panel-border)',
    paddingBottom: '16px',
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  logoIcon: {
    fontSize: '28px',
  },
  logoText: {
    fontSize: '22px',
    margin: 0,
    fontWeight: '700',
    background: 'linear-gradient(90deg, #a78bfa 0%, #ec4899 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  pwaBadge: {
    fontSize: '11px',
    background: 'rgba(255, 255, 255, 0.08)',
    padding: '4px 10px',
    borderRadius: '20px',
    color: 'var(--text-secondary)',
    border: '1px solid var(--panel-border)',
  },
  settingsPanel: {
    background: 'var(--panel-bg)',
    border: '1px solid var(--panel-border)',
    borderRadius: '16px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  gridRow: {
    display: 'flex',
    gap: '16px',
  },
  fieldCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  label: {
    fontSize: '13px',
    fontWeight: '500',
    color: 'var(--text-secondary)',
    letterSpacing: '0.5px',
  },
  input: {
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid var(--panel-border)',
    borderRadius: '8px',
    padding: '10px 14px',
    fontSize: '14px',
    color: 'var(--text-primary)',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  select: {
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid var(--panel-border)',
    borderRadius: '8px',
    padding: '10px 14px',
    fontSize: '14px',
    color: 'var(--text-primary)',
    outline: 'none',
  },
  toggleContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    height: '42px',
  },
  slider: {
    width: '100%',
    accentColor: 'var(--accent-purple)',
    cursor: 'pointer',
  },
  hint: {
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  modeToggle: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
  modeButton: {
    flex: 1,
    minWidth: '120px',
    padding: '10px 12px',
    fontSize: '13px',
    fontWeight: '600',
    color: 'var(--text-secondary)',
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid var(--panel-border)',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  modeButtonActive: {
    color: '#ffffff',
    background: 'var(--accent-purple)',
    border: '1px solid var(--accent-purple)',
  },
  dualPanel: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: '420px',
    background: 'var(--panel-bg)',
    border: '1px solid var(--panel-border)',
    borderRadius: '16px',
    overflow: 'hidden',
  },
  dualHalf: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    padding: '16px',
    overflow: 'hidden',
  },
  dualDivider: {
    height: '2px',
    background: 'linear-gradient(90deg, transparent, var(--accent-purple), transparent)',
  },
  dualScroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    overflowY: 'auto',
  },
  dualEmpty: {
    margin: 'auto',
    fontSize: '13px',
    color: 'var(--text-muted)',
    textAlign: 'center',
  },
  dualBubble: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '12px 14px',
    borderRadius: '12px',
    background: 'rgba(6, 182, 212, 0.10)',
    borderLeft: '3px solid var(--accent-cyan)',
  },
  dualBubbleText: {
    fontSize: '20px',
    lineHeight: '1.35',
    margin: 0,
    color: 'var(--text-primary)',
    wordBreak: 'break-word',
  },
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
    accentColor: 'var(--accent-purple)',
  },
  toggleLabel: {
    fontSize: '13px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  controlPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'center',
  },
  statusBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: 'rgba(0, 0, 0, 0.15)',
    padding: '8px 16px',
    borderRadius: '30px',
    border: '1px solid var(--panel-border)',
  },
  statusIndicator: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    display: 'inline-block',
  },
  statusText: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  actionButton: {
    width: '100%',
    maxWidth: '350px',
    border: 'none',
    borderRadius: '30px',
    padding: '16px 28px',
    fontSize: '16px',
    fontWeight: '600',
    color: '#ffffff',
    cursor: 'pointer',
    transition: 'transform 0.1s, filter 0.2s',
    boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
  },
  callPanel: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  feedPanel: {
    flexGrow: 1,
    background: 'var(--panel-bg)',
    border: '1px solid var(--panel-border)',
    borderRadius: '16px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    minHeight: '280px',
    maxHeight: '400px',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  feedTitle: {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 12px 0',
    textAlign: 'left',
    color: 'var(--text-primary)',
  },
  timeline: {
    flexGrow: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    paddingRight: '4px',
  },
  emptyFeed: {
    margin: 'auto',
    textAlign: 'center',
    color: 'var(--text-muted)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
  },
  emptyIcon: {
    fontSize: '36px',
  },
  bubbleCard: {
    maxWidth: '85%',
    padding: '12px 16px',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    animation: 'fadeIn 0.2s ease-out',
  },
  bubbleHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
  },
  bubbleRole: {
    fontSize: '11px',
    fontWeight: '600',
    color: 'var(--text-secondary)',
  },
  bubbleLang: {
    fontSize: '10px',
    background: 'rgba(255, 255, 255, 0.1)',
    padding: '2px 6px',
    borderRadius: '4px',
    color: 'var(--text-secondary)',
  },
  bubbleText: {
    fontSize: '15px',
    margin: 0,
    lineHeight: '1.4',
    textAlign: 'left',
    color: 'var(--text-primary)',
    wordBreak: 'break-word',
  },
  bubbleTime: {
    fontSize: '9px',
    color: 'var(--text-muted)',
    alignSelf: 'flex-end',
  },
};

export default App;
