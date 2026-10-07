import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  MANUAL_ORDER_CODE,
  MIZUHIKI_TYPES,
  type MizuhikiType,
  type OrderView,
} from '@gift-inspector/shared';
import {type FormEvent, useState} from 'react';

import {tokens} from '../theme';
import {Card, SectionTitle} from './Layout';

/**
 * 開発用の手入力モード（#22）。正解を手で入れて、撮影に進む。URL に ?dev=1 があるときだけ表示する。
 * サーバー側も DEV_MODE_ENABLED=true でなければ受け付けない（デモ環境では無効）。
 * 必須項目が空でないかなどの検査はサーバーが通常と同じ規則で行う。
 */
export function ManualEntry({onStart}: {onStart: (order: OrderView) => void}) {
  const [noshiRequired, setNoshiRequired] = useState(true);
  const [cardRequired, setCardRequired] = useState(true);
  const [omotegaki, setOmotegaki] = useState('');
  const [atena, setAtena] = useState('');
  const [noshiType, setNoshiType] = useState<MizuhikiType>('蝶結び');
  const [cardText, setCardText] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onStart({
      orderCode: MANUAL_ORDER_CODE,
      noshiRequired,
      cardRequired,
      omotegaki: noshiRequired ? omotegaki : null,
      atena: noshiRequired ? atena : null,
      noshiType: noshiRequired ? noshiType : null,
      cardText: cardRequired ? cardText : null,
    });
  };

  return (
    <Box component="form" onSubmit={submit} aria-label="開発モード（正解を手入力）">
      <SectionTitle title="開発モード（正解を手入力）" aside="?dev=1" />
      <Card>
        <Stack spacing={1.5} sx={{py: 1.5}}>
          <Typography variant="caption">
            通常の画面には出ない開発用の機能です。判定は通常と同じ規則で行い、記録には開発モードと残ります。
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={noshiRequired}
                onChange={e => setNoshiRequired(e.target.checked)}
              />
            }
            label="のしあり"
          />
          {noshiRequired && (
            <>
              <TextField
                label="表書き"
                value={omotegaki}
                onChange={e => setOmotegaki(e.target.value)}
                required
              />
              <TextField
                label="名入れ・宛名"
                value={atena}
                onChange={e => setAtena(e.target.value)}
                required
              />
              <TextField
                select
                label="水引"
                value={noshiType}
                onChange={e => setNoshiType(e.target.value as MizuhikiType)}
              >
                {MIZUHIKI_TYPES.map(t => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            </>
          )}
          <FormControlLabel
            control={
              <Checkbox checked={cardRequired} onChange={e => setCardRequired(e.target.checked)} />
            }
            label="メッセージカードあり"
          />
          {cardRequired && (
            <TextField
              label="カードの印刷文面"
              value={cardText}
              onChange={e => setCardText(e.target.value)}
              multiline
              minRows={3}
              required
            />
          )}
          <Button
            type="submit"
            variant="outlined"
            size="large"
            disabled={!noshiRequired && !cardRequired}
            sx={{borderColor: tokens.color.main}}
          >
            この正解で撮影に進む
          </Button>
        </Stack>
      </Card>
    </Box>
  );
}
