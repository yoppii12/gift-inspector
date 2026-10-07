import {Box} from '@mui/material';
import {Scanner} from '@yudiel/react-qr-scanner';
import {useState} from 'react';

import type {ClientError} from '../services/api';
import {cameraErrorToClientError} from '../services/media';
import {tokens} from '../theme';

// ライブラリの既定値は width/height に min 640 を含み、解像度の低いカメラで起動に失敗する。
// min を持たない希望値（ideal）だけで上書きする
const RESOLUTION: MediaTrackConstraints = {
  width: {ideal: 1280},
  height: {ideal: 720},
};
const REAR_CAMERA: MediaTrackConstraints = {...RESOLUTION, facingMode: 'environment'};
const ANY_CAMERA: MediaTrackConstraints = RESOLUTION;

interface Props {
  onScan: (value: string) => void;
  onError: (error: ClientError) => void;
}

/**
 * QR コード読取（Mcs の Scanner.tsx を簡略化して移植。読むのは QR のみ）。
 * 呼び出し側は loadQrEngine() の完了を待ってから描画すること。
 * 背面カメラがない端末（PC など）では、カメラ指定なしで自動的に1回だけ再試行する。
 */
export function QrScanner({onScan, onError}: Props) {
  const [constraints, setConstraints] = useState(REAR_CAMERA);

  return (
    <Box
      sx={{
        aspectRatio: '1',
        borderRadius: `${tokens.radius.card}px`,
        overflow: 'hidden',
        bgcolor: tokens.color.main,
      }}
    >
      <Scanner
        key={constraints === REAR_CAMERA ? 'rear' : 'any'}
        formats={['qr_code']}
        constraints={constraints}
        components={{finder: true}}
        // 効果音は data: URL で再生され、本番の CSP（media-src 'self' blob:）で拒否されてコンソールエラーになるため無効化する（#5）
        sound={false}
        onScan={codes => {
          const first = codes[0];
          if (first) onScan(first.rawValue);
        }}
        onError={scannerError => {
          if (scannerError.kind === 'overconstrained' && constraints === REAR_CAMERA) {
            setConstraints(ANY_CAMERA);
            return;
          }
          const e = cameraErrorToClientError(scannerError);
          if (e) onError(e); // null は画面を離れたときの正常な停止
        }}
      />
    </Box>
  );
}
