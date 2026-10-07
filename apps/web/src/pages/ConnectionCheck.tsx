import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import {Box, Button, CircularProgress, Stack, Typography} from '@mui/material';
import {ORDER_CODE_PATTERN} from '@gift-inspector/shared';
import {type ChangeEvent, useEffect, useRef, useState} from 'react';

import {ErrorPanel} from '../components/ErrorPanel';
import {QrScanner} from '../components/QrScanner';
import {ClientError, request, toClientError} from '../services/api';
import {type PreparedImage, prepareImage} from '../services/media';
import {loadQrEngine} from '../services/qr-engine';
import {reportClientError} from '../services/report';
import {tokens} from '../theme';

/**
 * 接続確認（10/8 の VPS 導通確認・実機確認用）。本番の2画面ができたら開発用として残す。
 * HTTPS・BASIC認証・API・DB・QR読取カメラ・OSカメラ撮影・画像の再エンコードを1画面で確認する。
 */
export function ConnectionCheck() {
  return (
    <Stack spacing={2}>
      <EnvironmentSection />
      <HealthSection />
      <QrSection />
      <PhotoSection />
    </Stack>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <Box
      component="section"
      sx={{
        border: `1px solid ${tokens.color.main15}`,
        borderRadius: `${tokens.radius.card}px`,
        p: 2,
      }}
    >
      <Typography variant="h2" sx={{mb: 1.5}}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function StatusRow({ok, label, detail}: {ok: boolean; label: string; detail?: string}) {
  return (
    <Stack direction="row" spacing={1} sx={{alignItems: 'center', py: 0.25}}>
      {ok ? (
        <CheckCircleIcon fontSize="small" sx={{color: tokens.color.main}} />
      ) : (
        <ErrorIcon fontSize="small" sx={{color: tokens.color.accent}} />
      )}
      <Typography variant="body2">{label}</Typography>
      {detail && (
        <Typography variant="caption" sx={{wordBreak: 'break-all'}}>
          {detail}
        </Typography>
      )}
    </Stack>
  );
}

function EnvironmentSection() {
  return (
    <Section title="端末">
      <StatusRow ok={window.isSecureContext} label="HTTPS で接続" />
      <StatusRow ok={'mediaDevices' in navigator} label="カメラ機能に対応" />
      <StatusRow ok={navigator.onLine} label="オンライン" />
      <Typography variant="caption" component="p" sx={{mt: 1, wordBreak: 'break-all'}}>
        版 {__APP_VERSION__} / {navigator.userAgent}
      </Typography>
    </Section>
  );
}

interface Health {
  status: 'OK' | 'NG';
  checks: Record<string, {ok: boolean; detail?: string}>;
  memory?: {rssMB: number};
}

function HealthSection() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 503 でもヘルスチェックは失敗項目を JSON で返すので、それを表示する
    request<Health>('/api/health', {acceptStatuses: [503]})
      .then(
        res => {
          if (cancelled) return;
          setHealth(res);
          setError(null);
        },
        (err: unknown) => {
          const e = toClientError(err);
          reportClientError(e);
          if (cancelled) return;
          setHealth(null);
          setError(e);
        }
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setLoading(true);
    setAttempt(n => n + 1);
  };

  return (
    <Section title="サーバー">
      {loading && <CircularProgress size={20} />}
      {health &&
        Object.entries(health.checks).map(([key, c]) => (
          <StatusRow key={key} ok={c.ok} label={key} detail={c.detail} />
        ))}
      {error && <ErrorPanel error={error} onAction={retry} />}
    </Section>
  );
}

interface OrderResponse {
  order: {orderCode: string; omotegaki: string | null; atena: string | null; cardRequired: boolean};
}

function QrSection() {
  const [active, setActive] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderResponse['order'] | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  const start = async () => {
    setError(null);
    try {
      await loadQrEngine();
      setActive(true);
    } catch (err: unknown) {
      const e = toClientError(err);
      setError(e);
      reportClientError(e);
    }
  };

  const handleScan = async (value: string) => {
    setActive(false);
    setCode(value);
    setOrder(null);
    setError(null);
    if (!ORDER_CODE_PATTERN.test(value)) {
      setError(new ClientError('QR_INVALID_FORMAT', {detail: value.slice(0, 64)}));
      return;
    }
    try {
      const res = await request<OrderResponse>(`/api/orders/${encodeURIComponent(value)}`);
      setOrder(res.order);
    } catch (err: unknown) {
      const e = toClientError(err);
      setError(e);
      reportClientError(e);
    }
  };

  return (
    <Section title="QRコードの読み取り">
      {active ? (
        <QrScanner
          onScan={value => void handleScan(value)}
          onError={e => {
            setActive(false);
            setError(e);
            reportClientError(e);
          }}
        />
      ) : (
        <Button fullWidth variant="contained" size="large" onClick={() => void start()}>
          カメラを起動
        </Button>
      )}
      {code && <StatusRow ok={!error} label="読み取った値" detail={code} />}
      {order && (
        <StatusRow
          ok
          label="登録済みオーダー"
          detail={`${order.omotegaki ?? '-'} / ${order.atena ?? '-'}`}
        />
      )}
      {error && (
        <Box sx={{mt: 1}}>
          <ErrorPanel error={error} onAction={() => setError(null)} />
        </Box>
      )}
    </Section>
  );
}

function PhotoSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<(PreparedImage & {url: string}) | null>(null);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image]
  );

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const prepared = await prepareImage(file);
      setImage({...prepared, url: URL.createObjectURL(prepared.blob)});
    } catch (err: unknown) {
      const e = toClientError(err);
      setImage(null);
      setError(e);
      reportClientError(e);
    }
  };

  return (
    <Section title="撮影（OSのカメラ）">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={e => void handleFile(e)}
      />
      <Button fullWidth variant="outlined" size="large" onClick={() => inputRef.current?.click()}>
        撮影する
      </Button>
      {image && (
        <Box sx={{mt: 1.5}}>
          <Box
            component="img"
            src={image.url}
            alt="撮影した写真"
            sx={{width: '100%', borderRadius: `${tokens.radius.box}px`, display: 'block'}}
          />
          <StatusRow
            ok
            label="変換後"
            detail={`${image.width}×${image.height} / ${Math.round(image.blob.size / 1024)}KB（元 ${Math.round(image.originalBytes / 1024)}KB）`}
          />
        </Box>
      )}
      {error && (
        <Box sx={{mt: 1}}>
          <ErrorPanel error={error} onAction={() => inputRef.current?.click()} />
        </Box>
      )}
    </Section>
  );
}
