import {Box, Typography} from '@mui/material';
import type {OrderView} from '@gift-inspector/shared';

import {tokens} from '../theme';
import {Card} from './Layout';

function Row({label, value, sub}: {label: string; value: string; sub?: string | null}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr',
        columnGap: 1.5,
        py: 1.5,
        '& + &': {borderTop: `1px solid ${tokens.color.main08}`},
      }}
    >
      <Typography variant="body2" sx={{color: tokens.color.main60, fontWeight: 400}}>
        {label}
      </Typography>
      <Box sx={{minWidth: 0}}>
        <Typography variant="body1" sx={{wordBreak: 'break-all'}}>
          {value}
        </Typography>
        {sub && (
          <Typography variant="caption" component="p" sx={{mt: 0.25, wordBreak: 'break-all'}}>
            {sub}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/** 検品する内容（オーダーの正解情報） */
export function OrderDetails({order}: {order: OrderView}) {
  return (
    <Card>
      <Row label="のし" value={order.noshiRequired ? `あり・${order.noshiType ?? ''}` : 'なし'} />
      {order.noshiRequired && <Row label="表書き" value={order.omotegaki ?? '—'} />}
      {order.noshiRequired && <Row label="名入れ・宛名" value={order.atena ?? '—'} />}
      <Row
        label="メッセージカード"
        value={order.cardRequired ? 'あり（印刷）' : 'なし'}
        sub={order.cardRequired ? order.cardText : null}
      />
    </Card>
  );
}
