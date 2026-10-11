import React, { useEffect, useRef } from 'react';

export interface CallTranscriptMessage {
  id: string;
  type: 'input' | 'output';
  text: string;
  langCode?: string;
  timestamp: Date;
}

export interface CallTranscriptViewProps {
  inboundTranscripts: CallTranscriptMessage[];
  outboundTranscripts: CallTranscriptMessage[];
  inboundStatus: {
    state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
    detail?: string;
  };
  outboundStatus: {
    state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
    detail?: string;
  };
  myLang: string;
  remoteLang: string;
  maxItems?: number;
}

export const CallTranscriptView: React.FC<CallTranscriptViewProps> = ({
  inboundTranscripts,
  outboundTranscripts,
  inboundStatus,
  outboundStatus,
  myLang,
  remoteLang,
  maxItems = 8,
}) => {
  const inboundEndRef = useRef<HTMLDivElement | null>(null);
  const outboundEndRef = useRef<HTMLDivElement | null>(null);

  // 최근 N개만 추려서 표시
  const recentInbound = inboundTranscripts.slice(-maxItems);
  const recentOutbound = outboundTranscripts.slice(-maxItems);

  useEffect(() => {
    inboundEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recentInbound]);

  useEffect(() => {
    outboundEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recentOutbound]);

  const renderStatusBadge = (status: {
    state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
    detail?: string;
  }) => {
    let dotColor = '#64748b';
    let text = '대기 중';

    if (status.state === 'open') {
      dotColor = '#10b981';
      text = '연결됨';
    } else if (status.state === 'reconnecting') {
      dotColor = '#f59e0b';
      text = status.detail || '재연결 중...';
    } else if (status.state === 'connecting') {
      dotColor = '#3b82f6';
      text = '연결 중...';
    } else if (status.state === 'closed') {
      dotColor = '#ef4444';
      text = status.detail || '종료됨';
    }

    return (
      <span style={styles.badge}>
        <span style={{ ...styles.dot, backgroundColor: dotColor }} />
        <span style={styles.badgeText}>{text}</span>
      </span>
    );
  };

  const renderCards = (
    items: CallTranscriptMessage[],
    accentColor: string,
    isRemote: boolean
  ) => {
    if (items.length === 0) {
      return (
        <div style={styles.emptyState}>
          {isRemote
            ? '상대방의 음성이 감지되면 여기에 실시간 자막과 번역이 표시됩니다.'
            : '내가 마이크에 말하면 여기에 내 원문과 상대방 언어 번역이 표시됩니다.'}
        </div>
      );
    }

    return items.map((item) => {
      const isInput = item.type === 'input';
      return (
        <div
          key={item.id}
          style={{
            ...styles.card,
            borderLeft: isInput
              ? '3px solid rgba(255, 255, 255, 0.2)'
              : `3px solid ${accentColor}`,
            backgroundColor: isInput
              ? 'rgba(255, 255, 255, 0.03)'
              : `${accentColor}14`,
          }}
        >
          <div style={styles.cardHeader}>
            <span style={styles.cardRole}>
              {isInput
                ? isRemote
                  ? '🗣️ 상대 원문'
                  : '🗣️ 내 원문'
                : isRemote
                ? '🤖 내 언어로 번역'
                : '🤖 상대 언어로 번역'}
            </span>
            {item.langCode && (
              <span style={styles.cardLang}>{item.langCode.toUpperCase()}</span>
            )}
          </div>
          <div
            style={
              isInput ? styles.cardTextOriginal : styles.cardTextTranslated
            }
          >
            {item.text}
          </div>
        </div>
      );
    });
  };

  return (
    <div style={styles.container}>
      {/* 상대방 패널 (수신 세션: 탭/시스템 오디오 -> 내 언어 번역) */}
      <div style={styles.panel}>
        <div style={styles.panelHeader}>
          <div style={styles.panelTitleGroup}>
            <span style={styles.panelTitle}>👤 상대방 음성 및 번역</span>
            <span style={styles.panelSubtitle}>
              {remoteLang.toUpperCase()} → {myLang.toUpperCase()}
            </span>
          </div>
          {renderStatusBadge(inboundStatus)}
        </div>
        <div style={styles.scrollArea}>
          {renderCards(recentInbound, '#06b6d4', true)}
          <div ref={inboundEndRef} />
        </div>
      </div>

      {/* 내 패널 (송신 세션: 내 마이크 -> 상대방 언어 번역) */}
      <div style={styles.panel}>
        <div style={styles.panelHeader}>
          <div style={styles.panelTitleGroup}>
            <span style={styles.panelTitle}>🎙️ 내 음성 및 번역</span>
            <span style={styles.panelSubtitle}>
              {myLang.toUpperCase()} → {remoteLang.toUpperCase()}
            </span>
          </div>
          {renderStatusBadge(outboundStatus)}
        </div>
        <div style={styles.scrollArea}>
          {renderCards(recentOutbound, '#8b5cf6', false)}
          <div ref={outboundEndRef} />
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: '16px',
    width: '100%',
    minHeight: '420px',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    borderRadius: '16px',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 18px',
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  panelTitleGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  panelTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#f1f5f9',
  },
  panelSubtitle: {
    fontSize: '11px',
    color: '#94a3b8',
    fontWeight: 500,
  },
  badge: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 8px',
    borderRadius: '12px',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
  },
  badgeText: {
    fontSize: '11px',
    color: '#cbd5e1',
    fontWeight: 500,
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxHeight: '480px',
  },
  emptyState: {
    margin: 'auto',
    textAlign: 'center',
    color: '#64748b',
    fontSize: '13px',
    padding: '40px 20px',
    lineHeight: 1.6,
  },
  card: {
    borderRadius: '10px',
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardRole: {
    fontSize: '11px',
    color: '#94a3b8',
    fontWeight: 500,
  },
  cardLang: {
    fontSize: '10px',
    color: '#64748b',
    fontWeight: 600,
  },
  cardTextOriginal: {
    fontSize: '13px',
    color: '#94a3b8',
    lineHeight: 1.4,
  },
  cardTextTranslated: {
    fontSize: '15px',
    fontWeight: 600,
    color: '#f8fafc',
    lineHeight: 1.5,
  },
};
