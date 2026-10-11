/**
 * 브라우저 입출력 오디오 장치 목록 조회 및 장치 변경 감지 유틸리티
 */

export interface AudioDeviceList {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

/**
 * 시스템의 오디오 입출력 장치 목록을 조회합니다.
 * 장치 라벨(이름)을 취득하기 위해 권한이 필요한 경우 임시로 마이크 권한을 요청한 뒤 해제합니다.
 */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }

  // 1. 디바이스 목록 1차 확인 (라벨이 비어있는지 확인)
  let devices = await navigator.mediaDevices.enumerateDevices();
  const hasLabels = devices.some(
    (d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && Boolean(d.label)
  );

  // 2. 라벨이 없으면 마이크 권한 요청 후 즉시 트랙 정지
  if (!hasLabels && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      console.warn('오디오 장치 라벨을 얻기 위한 마이크 권한 획득 실패 (라벨 없이 표시됨):', err);
    }
  }

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');

  return { inputs, outputs };
}

/**
 * 오디오 장치 연결/분리 이벤트(devicechange)를 구독합니다.
 * @param callback 장치 변경 시 실행할 콜백
 * @returns 구독 해제 함수
 */
export function onDeviceChange(callback: () => void): () => void {
  if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) {
    return () => {};
  }

  navigator.mediaDevices.addEventListener('devicechange', callback);
  return () => {
    navigator.mediaDevices.removeEventListener('devicechange', callback);
  };
}
