import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import {Box, Button, LinearProgress, Stack, Typography} from '@mui/material';
import type {InspectionResult, NextAction, OrderView} from '@gift-inspector/shared';
import {type ChangeEvent, useEffect, useRef, useState} from 'react';

import {ErrorPanel} from '../components/ErrorPanel';
import {AppHeader, Card, Page, Stepper} from '../components/Layout';
import {ResultView} from '../components/ResultView';
import {ClientError, toClientError} from '../services/api';
import {isManualOrder, newInspectionId, postInspection} from '../services/inspection';
import {prepareImage} from '../services/media';
import {reportClientError} from '../services/report';
import {tokens} from '../theme';

type State =
  | {kind: 'ready'}
  // 写真を変換中（この間も操作できないようにする）
  | {kind: 'preparing'}
  | {kind: 'sending'; inspectionId: string}
  | {kind: 'result'; result: InspectionResult}
  | {kind: 'error'; error: ClientError; occurredAt: Date};

/**
 * ② 撮影 → ③ 判定結果。
 * - 撮影は OS のカメラ（D8）。端末で長辺 1600px の JPEG に変換してから送る
 * - 撮影・再試行ごとに新しい検品 ID を発行する
 * - 送信中は操作できない。画面を離れたら送信を中断して REQUEST_ABORTED を表示する
 * - 判定が行われなかったとき（ERROR）は「品質の判定ではない」ことを明示して ErrorPanel で表示する
 */
export function Inspect({
  order,
  onBack,
  onNextOrder,
}: {
  order: OrderView;
  onBack: () => void;
  onNextOrder: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 画面を離れた（アンマウントした）後に送信を始めない・状態を更新しないため */
  const disposedRef = useRef(false);
  const [state, setState] = useState<State>({kind: 'ready'});
  const [photo, setPhoto] = useState<{blob: Blob; url: string} | null>(null);

  // 写真の URL を解放する
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url);
    },
    [photo]
  );

  // 画面を離れたら（別アプリ・ロック）送信を中断する。サーバー側は処理を続け、記録は残る
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') abortRef.current?.abort();
    };
    document.addEventListener('visibilitychange', onHide);
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      document.removeEventListener('visibilitychange', onHide);
      abortRef.current?.abort();
    };
  }, []);

  const send = async (blob: Blob) => {
    if (disposedRef.current) return;
    const inspectionId = newInspectionId();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({kind: 'sending', inspectionId});
    try {
      const result = await postInspection(inspectionId, order.orderCode, blob, {
        signal: controller.signal,
        manual: isManualOrder(order) ? order : null,
      });
      if (!disposedRef.current) setState({kind: 'result', result});
    } catch (err: unknown) {
      const e = toClientError(err);
      const withId =
        e.inspectionId === null
          ? new ClientError(e.code, {
              httpStatus: e.httpStatus,
              requestId: e.requestId,
              inspectionId,
              detail: e.detail ?? undefined,
              cause: e.cause,
            })
          : e;
      reportClientError(withId);
      if (!disposedRef.current) setState({kind: 'error', error: withId, occurredAt: new Date()});
    } finally {
      abortRef.current = null;
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || state.kind === 'sending' || state.kind === 'preparing') return;
    // 前の結果やボタンを残したまま変換しない（変換中に「次のオーダーへ」を押せないように）
    setState({kind: 'preparing'});
    try {
      const prepared = await prepareImage(file);
      if (disposedRef.current) return;
      setPhoto({blob: prepared.blob, url: URL.createObjectURL(prepared.blob)});
      await send(prepared.blob);
    } catch (err: unknown) {
      const e = toClientError(err);
      reportClientError(e);
      if (disposedRef.current) return;
      // 読めなかった写真の代わりに前の写真を出さない
      setPhoto(null);
      setState({kind: 'error', error: e, occurredAt: new Date()});
    }
  };

  const openCamera = () => inputRef.current?.click();

  const handleAction = (action: NextAction) => {
    switch (action) {
      case 'RETRY':
        if (photo) void send(photo.blob);
        else openCamera();
        return;
      case 'RETAKE':
        setState({kind: 'ready'});
        openCamera();
        return;
      case 'RELOAD':
        location.reload();
        return;
      default:
        // BACK_TO_START / RESCAN / SELECT_FROM_LIST
        onNextOrder();
    }
  };

  const busy = state.kind === 'sending' || state.kind === 'preparing';
  // ERROR は判定が行われていないので、判定完了の見た目（ステッパー③・「判定結果」）にしない
  const judged = state.kind === 'result';
  const title = judged ? '判定結果' : state.kind === 'error' ? '判定できませんでした' : '撮影';

  return (
    <>
      <AppHeader title={title} onBack={busy ? undefined : onBack} devMode={isManualOrder(order)} />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={e => void handleFile(e)}
      />
      <Page
        footer={
          state.kind === 'result' ? (
            <Stack direction="row" spacing={1.5}>
              <Button fullWidth variant="outlined" size="large" onClick={openCamera}>
                撮り直す
              </Button>
              <Button fullWidth variant="contained" size="large" onClick={onNextOrder}>
                次のオーダーへ
              </Button>
            </Stack>
          ) : state.kind === 'ready' ? (
            <Button
              fullWidth
              variant="contained"
              size="large"
              startIcon={<PhotoCameraOutlinedIcon />}
              onClick={openCamera}
            >
              撮影する
            </Button>
          ) : undefined
        }
      >
        <Stepper current={judged ? 2 : 1} />
        <Typography variant="caption" component="p" sx={{mb: 1}}>
          {isManualOrder(order) ? '開発モード（正解を手入力）' : `オーダーNo ${order.orderCode}`}
        </Typography>

        {state.kind === 'ready' && <CaptureGuide />}

        {state.kind === 'preparing' && (
          <Box>
            <Typography variant="h3" component="p">
              写真を準備しています
            </Typography>
            <LinearProgress sx={{mt: 1.5, borderRadius: 1}} />
          </Box>
        )}

        {state.kind === 'sending' && (
          <Box>
            {photo && <Preview url={photo.url} />}
            <Typography variant="h3" component="p" sx={{mt: 2}}>
              AIが照合しています
            </Typography>
            <LinearProgress sx={{mt: 1.5, borderRadius: 1}} />
            <Typography variant="caption" component="p" sx={{mt: 1}}>
              画面を閉じずにお待ちください（最大1分半ほど）
            </Typography>
          </Box>
        )}

        {state.kind === 'result' && (
          <ResultView result={state.result} photoUrl={photo?.url ?? null} />
        )}

        {state.kind === 'error' && (
          <Box>
            {photo && <Preview url={photo.url} />}
            <Box sx={{mt: 2}}>
              <ErrorPanel
                error={state.error}
                title="判定できませんでした"
                notAJudgement
                occurredAt={state.occurredAt}
                onAction={handleAction}
              />
            </Box>
          </Box>
        )}
      </Page>
    </>
  );
}

function CaptureGuide() {
  return (
    <Card tinted>
      <Box sx={{py: 1}}>
        <Typography variant="h3" component="p">
          撮影のしかた
        </Typography>
        <Box component="ol" sx={{m: 0, mt: 1, pl: 2.5, '& li': {mb: 0.5}}}>
          <Typography component="li" variant="body2">
            のしとメッセージカードを、作業台に重ならないように並べる
          </Typography>
          <Typography component="li" variant="body2">
            真上から、文字全体が画面に入るように撮る
          </Typography>
          <Typography component="li" variant="body2">
            明るい場所で、影や反射が文字にかからないようにする
          </Typography>
        </Box>
      </Box>
    </Card>
  );
}

function Preview({url}: {url: string}) {
  return (
    <Box
      component="img"
      src={url}
      alt="撮影した写真"
      sx={{
        display: 'block',
        width: '100%',
        maxHeight: 280,
        objectFit: 'contain',
        bgcolor: tokens.color.main04,
        borderRadius: `${tokens.radius.card}px`,
      }}
    />
  );
}
