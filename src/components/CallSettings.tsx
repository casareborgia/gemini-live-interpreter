import React, { useEffect, useState, useCallback } from 'react';
import { listAudioDevices, onDeviceChange, type AudioDeviceList } from '../utils/audioDevices';

export interface CallSettingsProps {
  myLang: string;
  onMyLangChange: (lang: string) => void;
  remoteLang: string;
  onRemoteLangChange: (lang: string) => void;
  micDeviceId: string;
  onMicDeviceIdChange: (id: string) => void;
  inboundSinkId: string;
  onInboundSinkIdChange: (id: string) => void;
  outboundSinkId: string;
  onOutboundSinkIdChange: (id: string) => void;
  inboundAudio: boolean;
  onInboundAudioChange: (enabled: boolean) => void;
  outboundMonitor: boolean;
  onOutboundMonitorChange: (enabled: boolean) => void;
  supportedLanguages: { code: string; name: string }[];
  disabled?: boolean;
}

export const CallSettings: React.FC<CallSettingsProps> = ({
  myLang,
  onMyLangChange,
  remoteLang,
  onRemoteLangChange,
  micDeviceId,
  onMicDeviceIdChange,
  inboundSinkId,
  onInboundSinkIdChange,
  outboundSinkId,
  onOutboundSinkIdChange,
  inboundAudio,
  onInboundAudioChange,
  outboundMonitor,
  onOutboundMonitorChange,
  supportedLanguages,
  disabled = false,
}) => {
  const [devices, setDevices] = useState<AudioDeviceList>({ inputs: [], outputs: [] });
  const [isLoadingDevices, setIsLoadingDevices] = useState<boolean>(false);

  const refreshDevices = useCallback(async () => {
    setIsLoadingDevices(true);
    try {
      const devList = await listAudioDevices();
      setDevices(devList);
    } catch (err) {
      console.warn('오디오 장치 목록 갱신 실패:', err);
    } finally {
      setIsLoadingDevices(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    listAudioDevices()
      .then((devList) => {
        if (active) setDevices(devList);
      })
      .catch((err) => {
        console.warn('오디오 장치 목록 초기 로드 실패:', err);
      });

    const unsubscribe = onDeviceChange(() => {
      listAudioDevices()
        .then((devList) => {
          if (active) setDevices(devList);
        })
        .catch(() => {});
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const hasBlankLabels = devices.inputs.some((d) => !d.label) || devices.outputs.some((d) => !d.label);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>📞 영상통화 통역(Call Mode) 설정</span>
        <button
          type="button"
          onClick={refreshDevices}
          disabled={disabled || isLoadingDevices}
          style={styles.refreshBtn}
          title="오디오 장치 목록 새로고침"
        >
          🔄 장치 새로고침
        </button>
      </div>

      {/* 하울링 안전 경고 알림 */}
      <div style={styles.alertWarning}>
        <span style={styles.alertIcon}>⚠️</span>
        <div>
          <strong>하울링(루프) 방지 주의사항:</strong> 수신 번역 음성은 반드시 <strong>헤드폰</strong>으로
          들으세요. 스피커로 들으면 마이크가 다시 받아 송신 세션이 번역을 반복합니다. 송신 번역 음성은
          <strong>BlackHole 등 전용 출력 장치</strong>로 보내고, 그 전까지는 아래 "내 스피커로도 재생"을 끈 채
          자막으로만 확인하세요. 하울링이 계속되면 <strong>수신 번역 음성을 끄고 자막만</strong> 사용하세요.
        </div>
      </div>

      {hasBlankLabels && (
        <div style={styles.alertInfo}>
          ℹ️ 마이크 권한이 허용된 후 정확한 오디오 장치 이름(라벨)이 표시됩니다.
        </div>
      )}

      {/* 언어 설정 섹션 */}
      <div style={styles.grid2}>
        <div style={styles.formGroup}>
          <label style={styles.label}>
            <span>🗣️ 내 언어 (내가 말할 언어)</span>
            <select
              value={myLang}
              onChange={(e) => onMyLangChange(e.target.value)}
              disabled={disabled}
              style={styles.select}
            >
              {supportedLanguages.map((l) => (
                <option key={`my-${l.code}`} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={styles.formGroup}>
          <label style={styles.label}>
            <span>🌐 상대방 언어 (상대방이 말할 언어)</span>
            <select
              value={remoteLang}
              onChange={(e) => onRemoteLangChange(e.target.value)}
              disabled={disabled}
              style={styles.select}
            >
              {supportedLanguages.map((l) => (
                <option key={`remote-${l.code}`} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* 장치 라우팅 설정 섹션 */}
      <div style={styles.deviceSection}>
        <div style={styles.formGroup}>
          <label style={styles.label}>
            <span>🎤 내 마이크 입력 장치</span>
            <select
              value={micDeviceId}
              onChange={(e) => onMicDeviceIdChange(e.target.value)}
              disabled={disabled}
              style={styles.select}
            >
              <option value="">기본 마이크 (시스템 기본값)</option>
              {devices.inputs.map((d, idx) => (
                <option key={d.deviceId || idx} value={d.deviceId}>
                  {d.label || `마이크 입력 ${idx + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={styles.grid2}>
          <div style={styles.formGroup}>
            <label style={styles.label}>
              <span>🎧 수신 번역 출력 장치 (내가 들을 곳)</span>
              <select
                value={inboundSinkId}
                onChange={(e) => onInboundSinkIdChange(e.target.value)}
                style={styles.select}
              >
                <option value="">기본 스피커 / 헤드폰</option>
                {devices.outputs.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `출력 장치 ${idx + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>
              <span>🔊 송신 번역 출력 장치 (상대에게 전송 - BlackHole)</span>
              <select
                value={outboundSinkId}
                onChange={(e) => onOutboundSinkIdChange(e.target.value)}
                style={styles.select}
              >
                <option value="">선택 안 함 (송신 음성 재생하지 않음 — 자막만)</option>
                {devices.outputs.map((d, idx) => (
                  <option key={d.deviceId || idx} value={d.deviceId}>
                    {d.label || `출력 장치 ${idx + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <span style={styles.helperText}>
              💡 텔레그램 마이크로 내 번역 음성을 보내려면 BlackHole 2ch을 선택하세요. 선택하지 않으면 송신
              번역 음성은 재생되지 않고 자막으로만 표시됩니다 (스피커 재생은 하울링의 원인).
            </span>
          </div>
        </div>
      </div>

      {/* 수신 번역 음성 재생 토글 */}
      <div style={styles.toggleRow}>
        <div>
          <div style={styles.toggleTitle}>수신 번역 음성 재생</div>
          <div style={styles.toggleDesc}>
            상대방 말을 통역한 음성을 내 헤드폰으로 들을지 여부 (끄면 화면 자막만 표시)
          </div>
        </div>
        <label style={styles.switch}>
          <input
            type="checkbox"
            checked={inboundAudio}
            onChange={(e) => onInboundAudioChange(e.target.checked)}
          />
          <span style={styles.slider} />
        </label>
      </div>

      {/* 송신 번역 음성 로컬 모니터링 토글 (기본 꺼짐) */}
      <div style={styles.toggleRow}>
        <div>
          <div style={styles.toggleTitle}>송신 번역 음성을 내 스피커로도 재생 (테스트용)</div>
          <div style={styles.toggleDesc}>
            기본 꺼짐. 켜면 스피커로 나간 번역 음성이 화면 캡처와 마이크로 되돌아와 하울링이 생길 수 있습니다.
            전용 출력 장치를 선택한 경우에는 이 설정과 무관하게 그 장치로만 출력됩니다.
          </div>
        </div>
        <label style={styles.switch}>
          <input
            type="checkbox"
            checked={outboundMonitor}
            onChange={(e) => onOutboundMonitorChange(e.target.checked)}
          />
          <span style={styles.slider} />
        </label>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: '14px',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    padding: '18px',
    marginBottom: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#e2e8f0',
  },
  refreshBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: '6px',
    color: '#cbd5e1',
    fontSize: '12px',
    padding: '5px 10px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  alertWarning: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    backgroundColor: 'rgba(234, 179, 8, 0.1)',
    border: '1px solid rgba(234, 179, 8, 0.3)',
    borderRadius: '8px',
    padding: '10px 12px',
    color: '#fef08a',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  alertIcon: {
    fontSize: '14px',
    flexShrink: 0,
    marginTop: '1px',
  },
  alertInfo: {
    backgroundColor: 'rgba(59, 130, 246, 0.08)',
    border: '1px solid rgba(59, 130, 246, 0.2)',
    borderRadius: '8px',
    padding: '8px 12px',
    color: '#93c5fd',
    fontSize: '12px',
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '12px',
  },
  deviceSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
    paddingTop: '12px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    fontSize: '13px',
    color: '#94a3b8',
    fontWeight: 500,
  },
  select: {
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: '8px',
    color: '#f8fafc',
    padding: '8px 10px',
    fontSize: '13px',
    outline: 'none',
  },
  helperText: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '4px',
  },
  toggleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: '12px',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
  },
  toggleTitle: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#e2e8f0',
  },
  toggleDesc: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '2px',
  },
  switch: {
    position: 'relative',
    display: 'inline-block',
    width: '42px',
    height: '24px',
    flexShrink: 0,
  },
  slider: {
    position: 'absolute',
    cursor: 'pointer',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#334155',
    transition: '.2s',
    borderRadius: '24px',
  },
};
