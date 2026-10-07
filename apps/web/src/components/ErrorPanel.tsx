import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import {Box, Button, Stack, Typography} from '@mui/material';
import {ERROR_CATALOG, type NextAction} from '@gift-inspector/shared';

import type {ClientError} from '../services/api';
import {tokens} from '../theme';

const ACTION_LABELS: Record<Exclude<NextAction, 'NONE'>, string> = {
  SELECT_FROM_LIST: '一覧から選ぶ',
  RESCAN: '読み直す',
  RETAKE: '撮り直す',
  RETRY: 'もう一度試す',
  RELOAD: '再読み込み',
  BACK_TO_START: '最初に戻る',
};

interface Props {
  error: ClientError;
  /** 見出し（既定: エラーが発生しました） */
  title?: string;
  /** 検品の ERROR のときに「品質の判定ではない」ことを明示する */
  notAJudgement?: boolean;
  onAction?: (action: NextAction) => void;
  occurredAt?: Date;
}

/**
 * すべてのエラー表示はこの部品を通す（docs/error-handling.md 5.1）。
 * 何が起きたか・次の操作・エラーコード・ID を必ず表示し、トーストのように消えない。
 * 色はメイン色（NG・判定不能のアクセント色と区別する）。
 */
export function ErrorPanel({error, title, notAJudgement, onAction, occurredAt}: Props) {
  const def = ERROR_CATALOG[error.code];
  const action = def.nextAction;
  const time = (occurredAt ?? new Date()).toLocaleTimeString('ja-JP');

  const handleAction = () => {
    if (action === 'RELOAD' && !onAction) {
      location.reload();
      return;
    }
    onAction?.(action);
  };

  return (
    <Box
      role="alert"
      aria-live="assertive"
      sx={{
        bgcolor: tokens.color.main04,
        border: `1px solid ${tokens.color.main15}`,
        borderRadius: `${tokens.radius.card}px`,
        p: `${tokens.space.card}px`,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{alignItems: 'flex-start'}}>
        <ErrorOutlineIcon sx={{color: tokens.color.main, mt: '2px'}} />
        <Box sx={{minWidth: 0}}>
          <Typography variant="h3" component="p">
            {title ?? 'エラーが発生しました'}
          </Typography>
          {notAJudgement && (
            <Typography variant="body2" sx={{mt: 0.5, color: tokens.color.main90}}>
              この結果は品質の判定ではありません。
            </Typography>
          )}
          <Typography variant="body1" sx={{mt: 1}}>
            {def.userMessage}
          </Typography>
          <Box component="dl" sx={{mt: 1.5, mb: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.25}}>
            <DetailRow label="エラーコード" value={error.code} />
            {error.inspectionId && <DetailRow label="検品ID" value={error.inspectionId} />}
            {error.requestId && <DetailRow label="受付ID" value={error.requestId} />}
            <DetailRow label="時刻" value={time} />
          </Box>
          {error.detail && (
            <Box component="details" sx={{mt: 1}}>
              <Typography component="summary" variant="caption" sx={{cursor: 'pointer'}}>
                詳細（担当者向け）
              </Typography>
              <Typography
                variant="caption"
                component="pre"
                sx={{m: 0, mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace'}}
              >
                {error.detail}
              </Typography>
            </Box>
          )}
        </Box>
      </Stack>
      {action !== 'NONE' && (onAction || action === 'RELOAD') && (
        <Button fullWidth variant="outlined" sx={{mt: 2}} onClick={handleAction}>
          {ACTION_LABELS[action]}
        </Button>
      )}
    </Box>
  );
}

function DetailRow({label, value}: {label: string; value: string}) {
  return (
    <>
      <Typography component="dt" variant="caption">
        {label}
      </Typography>
      <Typography component="dd" variant="caption" sx={{m: 0, wordBreak: 'break-all', fontFamily: 'monospace'}}>
        {value}
      </Typography>
    </>
  );
}
