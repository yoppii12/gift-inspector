import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import QrCodeScannerOutlinedIcon from '@mui/icons-material/QrCodeScannerOutlined';
import {Box, Button, ButtonBase, CircularProgress, Stack, Typography} from '@mui/material';
import type {NextAction, OrderView} from '@gift-inspector/shared';
import {useEffect, useRef, useState} from 'react';

import {ErrorPanel} from '../components/ErrorPanel';
import {ManualEntry} from '../components/ManualEntry';
import {AppHeader, Card, Page, SectionTitle, Stepper} from '../components/Layout';
import {OrderDetails} from '../components/OrderDetails';
import {QrScanner} from '../components/QrScanner';
import {type ClientError, toClientError} from '../services/api';
import {getOrder, isDevModeRequested, listOrders} from '../services/inspection';
import {loadQrEngine} from '../services/qr-engine';
import {reportClientError} from '../services/report';
import {tokens} from '../theme';

const {color} = tokens;

const ORDER_LIST_ID = 'order-list';

/** ① オーダー選択: QR 読取または一覧から選び、正解情報を確認して撮影に進む */
export function OrderSelect({
  initialOrder,
  onStart,
}: {
  initialOrder: OrderView | null;
  onStart: (order: OrderView) => void;
}) {
  const [order, setOrder] = useState<OrderView | null>(initialOrder);

  if (order) {
    return (
      <>
        <AppHeader title="オーダー確認" onBack={() => setOrder(null)} />
        <Page
          footer={
            <Button fullWidth variant="contained" size="large" onClick={() => onStart(order)}>
              撮影に進む
            </Button>
          }
        >
          <Stepper current={0} />
          <Card tinted>
            <Stack direction="row" spacing={1} sx={{alignItems: 'center', pt: 1}}>
              <CheckCircleIcon sx={{color: color.main}} />
              <Typography variant="body1">オーダーを読み込みました</Typography>
            </Stack>
            <Typography variant="caption" component="p" sx={{mt: 1}}>
              オーダーNo
            </Typography>
            <Typography sx={{fontSize: 17, fontWeight: 600, pb: 1}}>{order.orderCode}</Typography>
          </Card>
          <SectionTitle title="検品する内容" aside="登録情報" />
          <OrderDetails order={order} />
          <Typography variant="caption" component="p" sx={{mt: 2}}>
            のし・メッセージカードを作業台に並べて撮影します
          </Typography>
        </Page>
      </>
    );
  }

  return (
    <>
      <AppHeader title="オーダー選択" />
      <Page>
        <Stepper current={0} />
        <ScanSection onFound={setOrder} />
        <OrderList onSelect={setOrder} />
        {isDevModeRequested() && <ManualEntry onStart={onStart} />}
      </Page>
    </>
  );
}

function ScanSection({onFound}: {onFound: (order: OrderView) => void}) {
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  // 連続して読み取られても1回だけ処理する（state は描画まで反映されないため ref で持つ）
  const handlingRef = useRef(false);
  const [error, setError] = useState<{error: ClientError; occurredAt: Date} | null>(null);

  const fail = (err: unknown) => {
    const e = toClientError(err);
    handlingRef.current = false;
    setScanning(false);
    setBusy(false);
    setError({error: e, occurredAt: new Date()});
    reportClientError(e);
  };

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      await loadQrEngine();
      setScanning(true);
    } catch (err: unknown) {
      fail(err);
      return;
    }
    setBusy(false);
  };

  const handleScan = async (value: string) => {
    if (handlingRef.current) return;
    handlingRef.current = true;
    setScanning(false);
    setBusy(true);
    try {
      onFound(await getOrder(value));
    } catch (err: unknown) {
      fail(err);
    }
  };

  const handleAction = (action: NextAction) => {
    setError(null);
    if (action === 'RESCAN') {
      void start();
      return;
    }
    // SELECT_FROM_LIST など: 下の一覧へ移動する
    document.getElementById(ORDER_LIST_ID)?.scrollIntoView({behavior: 'smooth', block: 'start'});
  };

  return (
    <Box>
      <Typography variant="body1" sx={{mb: 1.5}}>
        オーダーの QR コードを読み取ってください
      </Typography>
      {scanning ? (
        <>
          <QrScanner onScan={value => void handleScan(value)} onError={fail} />
          <Button fullWidth variant="outlined" sx={{mt: 1}} onClick={() => setScanning(false)}>
            読み取りをやめる
          </Button>
        </>
      ) : (
        <Button
          fullWidth
          variant="contained"
          size="large"
          startIcon={
            busy ? <CircularProgress size={18} color="inherit" /> : <QrCodeScannerOutlinedIcon />
          }
          disabled={busy}
          onClick={() => void start()}
        >
          カメラで読み取る
        </Button>
      )}
      {error && (
        <Box sx={{mt: 1.5}}>
          <ErrorPanel
            error={error.error}
            occurredAt={error.occurredAt}
            title="オーダーを読み込めませんでした"
            onAction={handleAction}
          />
        </Box>
      )}
    </Box>
  );
}

function OrderList({onSelect}: {onSelect: (order: OrderView) => void}) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listOrders().then(
      list => {
        if (!cancelled) setOrders(list);
      },
      (err: unknown) => {
        const e = toClientError(err);
        reportClientError(e);
        if (!cancelled) setError(e);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <Box>
      <Box id={ORDER_LIST_ID} sx={{scrollMarginTop: 16}}>
        <SectionTitle title="一覧から選ぶ" aside="デモ用オーダー" />
      </Box>
      {error ? (
        <ErrorPanel
          error={error}
          title="オーダーの一覧を読み込めませんでした"
          onAction={() => {
            setError(null);
            setOrders(null);
            setAttempt(n => n + 1);
          }}
        />
      ) : orders === null ? (
        <CircularProgress size={24} />
      ) : (
        <Card>
          {orders.map(o => (
            <ButtonBase
              key={o.orderCode}
              onClick={() => onSelect(o)}
              sx={{
                display: 'flex',
                width: '100%',
                justifyContent: 'space-between',
                textAlign: 'left',
                minHeight: tokens.touchTarget,
                py: 1.25,
                '& + &': {borderTop: `1px solid ${color.main08}`},
              }}
            >
              <Box sx={{minWidth: 0}}>
                <Typography variant="body1">{o.orderCode}</Typography>
                <Typography variant="caption" component="p">
                  {o.noshiRequired ? `${o.omotegaki ?? ''}／${o.atena ?? ''}` : 'のしなし'}
                  {o.cardRequired ? '／カードあり' : ''}
                </Typography>
              </Box>
              <Typography variant="body2" sx={{color: color.main40}} aria-hidden>
                ›
              </Typography>
            </ButtonBase>
          ))}
        </Card>
      )}
    </Box>
  );
}
