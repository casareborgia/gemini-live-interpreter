import React, { useState, useEffect, useRef } from 'react';
import { AudioRecorder } from './utils/audioRecorder';
import { TranslationSession, type SessionTranscript } from './utils/translationSession';

interface TranscriptItem {
  id: string;
  type: 'input' | 'output';
  text: string;
  langCode?: string;
  timestamp: Date;
  side?: 'A' | 'B'; // 대면 양방향 모드에서 어느 화자 쪽 자막인지
}

// 통역 모드: single = 영상 더빙/마이크 단방향, dual = 대면 양방향
type Mode = 'single' | 'dual';

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

function App() {
  const [apiKey, setApiKey] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_API_KEY') || '';
  });
  const [mode, setMode] = useState<Mode>('single');
  const [targetLang, setTargetLang] = useState<string>('ko');
  const [langA, setLangA] = useState<string>('ko'); // 대면 양방향: 내 언어
  const [langB, setLangB] = useState<string>('en'); // 대면 양방향: 상대 언어
  const [inputSource, setInputSource] = useState<InputSource>('mic');
  const [voiceName, setVoiceName] = useState<string>(() => {
    return localStorage.getItem('GEMINI_LIVE_VOICE_NAME') || 'Kore'; // 기본값 여성 Kore
  });
  const [echoTarget, setEchoTarget] = useState<boolean>(true);
  const [outputVolume, setOutputVolume] = useState<number>(1); // 번역 음성 볼륨 (0 ~ 1)
  const [subtitleOnly, setSubtitleOnly] = useState<boolean>(false); // 자막 전용(더빙 음성 끄기)
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('API 키를 입력하고 통역을 시작하세요.');
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);

  const recorderRef = useRef<AudioRecorder | null>(null);
  const sessionsRef = useRef<TranslationSession[]>([]);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  // 실제 적용되는 출력 볼륨 (자막 전용이면 0)
  const effectiveVolume = subtitleOnly ? 0 : outputVolume;

  // 로컬 스토리지에 API 키 저장
  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_API_KEY', apiKey);
  }, [apiKey]);

  // 로컬 스토리지에 보이스 이름 저장
  useEffect(() => {
    localStorage.setItem('GEMINI_LIVE_VOICE_NAME', voiceName);
  }, [voiceName]);

  // 대화 기록 추가 시 자동 스크롤
  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  // 볼륨/자막전용 변경 시 진행 중인 모든 세션에 즉시 반영
  useEffect(() => {
    for (const session of sessionsRef.current) {
      session.setVolume(effectiveVolume);
    }
  }, [effectiveVolume]);

  // 컴포넌트 언마운트 시 클린업
  useEffect(() => {
    return () => {
      stopTranslationSession();
    };
  }, []);

  // 세션이 보내온 자막(이미 누적된 전체 텍스트)을 id 기준으로 추가/갱신
  const upsertTranscript = (t: SessionTranscript, side?: 'A' | 'B') => {
    setTranscripts((prev) => {
      const item: TranscriptItem = {
        id: t.id,
        type: t.role,
        text: t.text,
        langCode: t.langCode,
        timestamp: new Date(),
        side,
      };
      const idx = prev.findIndex((it) => it.id === t.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...prev[idx], ...item };
        return updated;
      }
      return [...prev, item];
    });
  };

  // 세션 연결 상태 변화 처리 (재연결/종료 등)
  const handleSessionStatus = (
    state: 'open' | 'reconnecting' | 'closed',
    detail?: { code?: number; clean?: boolean; attempt?: number }
  ) => {
    if (state === 'open') {
      setStatusMessage('✨ 실시간 통역이 활성화되었습니다. 말씀하세요.');
    } else if (state === 'reconnecting') {
      setStatusMessage(`⚠️ 연결이 끊겨 재연결 시도 중입니다 (${detail?.attempt}/5)...`);
    } else if (state === 'closed' && !detail?.clean) {
      setStatusMessage(`⚠️ 연결이 종료되었습니다 (코드: ${detail?.code}). API 키 권한/모델 지원을 확인하세요.`);
      stopTranslationSession();
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

    try {
      setIsTranslating(true);

      // 1. 마이크/시스템 오디오 레코더 준비 — 받은 청크를 모든 세션에 전달
      recorderRef.current = new AudioRecorder((chunk: ArrayBuffer) => {
        const base64Data = arrayBufferToBase64(chunk);
        for (const session of sessionsRef.current) {
          session.sendAudioBase64(base64Data);
        }
      });

      // 대면 모드는 항상 마이크, 영상 더빙 모드는 선택된 입력 소스 사용
      const source: InputSource = mode === 'dual' ? 'mic' : inputSource;
      setStatusMessage(
        source === 'system'
          ? '공유할 탭/화면을 선택해 주세요 (탭 오디오 공유 체크 필수)...'
          : '마이크 권한 요청 중...'
      );
      await recorderRef.current.start(source);

      setStatusMessage('연결 설정 중...');

      // 2. 모드에 따라 세션 구성
      if (mode === 'dual') {
        // 대면 양방향: 서로 반대 타깃 2세션, echo=false → 이미 타깃 언어인 입력은 침묵 처리되어 중복 방지
        // 세션A(target=langB): langA 화자의 말을 langB로 번역 → 상대(B)쪽 자막
        const sessionA = new TranslationSession(
          { apiKey, targetLang: langB, echoTargetLanguage: false, autoReconnect: true, volume: effectiveVolume, emitInputTranscript: false, voiceName },
          { onStatus: handleSessionStatus, onTranscript: (t) => upsertTranscript(t, 'B') }
        );
        // 세션B(target=langA): langB 화자의 말을 langA로 번역 → 내(A)쪽 자막
        const sessionB = new TranslationSession(
          { apiKey, targetLang: langA, echoTargetLanguage: false, autoReconnect: true, volume: effectiveVolume, emitInputTranscript: false, voiceName },
          { onStatus: handleSessionStatus, onTranscript: (t) => upsertTranscript(t, 'A') }
        );
        sessionsRef.current = [sessionA, sessionB];
      } else {
        const session = new TranslationSession(
          { apiKey, targetLang, echoTargetLanguage: echoTarget, autoReconnect: true, volume: effectiveVolume, emitInputTranscript: true, voiceName },
          { onStatus: handleSessionStatus, onTranscript: (t) => upsertTranscript(t) }
        );
        sessionsRef.current = [session];
      }

      // 3. 세션 연결 시작
      for (const session of sessionsRef.current) {
        session.connect();
      }
    } catch (error: any) {
      console.error(error);
      setStatusMessage(`⚠️ 마이크 획득 또는 초기화 실패: ${error.message || error}`);
      stopTranslationSession();
    }
  };

  const stopTranslationSession = () => {
    setIsTranslating(false);
    setStatusMessage('통역 세션이 중지되었습니다.');

    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }

    for (const session of sessionsRef.current) {
      session.close();
    }
    sessionsRef.current = [];
  };

  const renderBubble = (item: TranscriptItem) => (
    <div
      key={item.id}
      style={{
        ...styles.bubbleCard,
        alignSelf: item.type === 'input' ? 'flex-start' : 'flex-end',
        borderLeft: item.type === 'input' ? '3px solid var(--accent-purple)' : '3px solid var(--accent-cyan)',
        backgroundColor: item.type === 'input' ? 'rgba(139, 92, 246, 0.08)' : 'rgba(6, 182, 212, 0.08)',
      }}
    >
      <div style={styles.bubbleHeader}>
        <span style={styles.bubbleRole}>
          {item.type === 'input' ? '🗣️ 내 음성' : '🤖 번역 결과'}
        </span>
        {item.langCode && (
          <span style={styles.bubbleLang}>{item.langCode.toUpperCase()}</span>
        )}
      </div>
      <p style={styles.bubbleText}>{item.text}</p>
      <span style={styles.bubbleTime}>
        {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
    </div>
  );

  // 대면 양방향: 한 화자 쪽 자막 패널 (가장 최근 발화 위주로 크게 표시)
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
              style={{ ...styles.modeButton, ...(mode === 'single' ? styles.modeButtonActive : {}) }}
            >
              🎬 영상·마이크 (단방향)
            </button>
            <button
              type="button"
              onClick={() => setMode('dual')}
              disabled={isTranslating}
              style={{ ...styles.modeButton, ...(mode === 'dual' ? styles.modeButtonActive : {}) }}
            >
              💬 대면 양방향
            </button>
          </div>
        </div>

        {mode === 'single' ? (
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
              <label style={styles.label}>번역 음성 목소리 (성별)</label>
              <select
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
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
                    <option key={lang.code} value={lang.code}>{lang.name}</option>
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
                    <option key={lang.code} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <span style={styles.hint}>
              기기를 두 사람 사이에 놓으세요. 상대방 쪽(위) 자막은 180° 회전되어 마주 본 사람이 바로 읽을 수 있습니다.
            </span>
          </>
        )}

        <div style={styles.fieldRow}>
          <label style={styles.label}>
            🔉 번역 음성 볼륨 — {subtitleOnly ? '자막 전용 (음소거)' : `${Math.round(outputVolume * 100)}%`}
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
          <span style={{
            ...styles.statusIndicator,
            backgroundColor: isTranslating ? 'var(--accent-green)' : 'var(--text-muted)'
          }} className={isTranslating ? 'pulse-active' : ''}></span>
          <span style={styles.statusText}>{statusMessage}</span>
        </div>

        <button
          onClick={isTranslating ? stopTranslationSession : startTranslationSession}
          style={{
            ...styles.actionButton,
            backgroundColor: isTranslating ? 'var(--accent-red)' : 'var(--accent-purple)'
          }}
        >
          {isTranslating ? '⏹️ 통역 중지하기' : '🎙️ 실시간 통역 시작'}
        </button>
      </section>

      {/* 실시간 통역 자막 피드 */}
      {mode === 'dual' ? (
        <section style={styles.dualPanel}>
          {/* 상대방 쪽 (위, 180도 회전) */}
          <div style={{ ...styles.dualHalf, transform: 'rotate(180deg)' }}>
            {renderDualSide('B', langB)}
          </div>
          <div style={styles.dualDivider} />
          {/* 내 쪽 (아래, 정방향) */}
          <div style={styles.dualHalf}>
            {renderDualSide('A', langA)}
          </div>
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
    maxWidth: '650px',
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
  },
  modeButton: {
    flex: 1,
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
    borderColor: 'var(--accent-purple)',
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
