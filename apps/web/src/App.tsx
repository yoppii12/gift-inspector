import {Box, Typography} from '@mui/material';

import {ConnectionCheck} from './pages/ConnectionCheck';
import {tokens} from './theme';

/** 画面の外枠（アプリバー＋本文）。スマホ幅 390px 基準、タブレット以上は最大幅 480px で中央寄せ */
export function App() {
  return (
    <Box sx={{minHeight: '100dvh', bgcolor: tokens.color.base}}>
      <Box
        component="header"
        sx={{
          bgcolor: tokens.color.main,
          color: tokens.color.base,
          pt: 'env(safe-area-inset-top)',
        }}
      >
        <Box sx={{maxWidth: tokens.maxWidth, mx: 'auto', px: `${tokens.space.page}px`, py: 2}}>
          <Typography variant="h1" component="h1">
            ギフト検品
          </Typography>
        </Box>
      </Box>
      <Box
        component="main"
        sx={{
          maxWidth: tokens.maxWidth,
          mx: 'auto',
          px: `${tokens.space.page}px`,
          py: 2,
          pb: 'calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        {/* T4 でオーダー選択・撮影判定の2画面に置き換える。接続確認は ?check=1 で残す */}
        <ConnectionCheck />
      </Box>
    </Box>
  );
}
