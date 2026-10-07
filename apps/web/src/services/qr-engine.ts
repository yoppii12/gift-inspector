import {prepareZXingModule} from '@yudiel/react-qr-scanner';
// 読取エンジン（wasm）は自前で配信する。既定では外部 CDN から取得するため、
// デモ当日に CDN や社内ネットワークの都合で取得できないと QR が読めなくなる。
// バージョンは barcode-detector が依存する zxing-wasm と完全一致させること（package.json で固定）。
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

import {ClientError} from './api';

let loading: Promise<void> | null = null;

/**
 * QR 読取エンジンを読み込む。失敗したら QR_ENGINE_LOAD_FAILED を投げる。
 * これを待たずにカメラを起動すると、映像は出るのに読めない「気づけない失敗」になるため、
 * QR 読取画面は必ずこれの完了を待ってからカメラを起動する。
 */
export function loadQrEngine(): Promise<void> {
  loading ??= prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : prefix + path,
    },
    fireImmediately: true,
  }).then(
    () => undefined,
    (err: unknown) => {
      loading = null; // 次回は再試行できるようにする
      throw new ClientError('QR_ENGINE_LOAD_FAILED', {
        detail: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }
  );
  return loading;
}
