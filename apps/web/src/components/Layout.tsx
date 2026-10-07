import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import {Box, IconButton, Stack, Typography} from '@mui/material';
import type {ReactNode} from 'react';

import {tokens} from '../theme';

const {color} = tokens;

/** アプリバー（main 塗り）。戻る操作がある画面だけ onBack を渡す */
export function AppHeader({
  title,
  onBack,
  devMode,
}: {
  title: string;
  onBack?: () => void;
  /** 開発用の手入力モードのとき、通常の検品と見分けられるよう目印を出す */
  devMode?: boolean;
}) {
  return (
    <Box
      component="header"
      sx={{bgcolor: color.main, color: color.base, pt: 'env(safe-area-inset-top)'}}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: 'center',
          maxWidth: tokens.maxWidth,
          mx: 'auto',
          px: onBack ? 0.5 : `${tokens.space.page}px`,
          minHeight: 56,
        }}
      >
        {onBack && (
          <IconButton
            aria-label="戻る"
            onClick={onBack}
            sx={{color: color.base, width: 44, height: 44}}
          >
            <ChevronLeftIcon />
          </IconButton>
        )}
        <Typography variant="h1" component="h1" sx={{flex: 1}}>
          {title}
        </Typography>
        {devMode && (
          <Box
            component="span"
            sx={{
              border: `1px solid ${color.base}`,
              borderRadius: `${tokens.radius.chip}px`,
              px: 1.25,
              py: 0.25,
              mr: onBack ? 1.5 : 0,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            開発モード
          </Box>
        )}
      </Stack>
    </Box>
  );
}

/** 本文の外枠。スマホ幅 390px 基準、PC では最大幅 480px で中央寄せ */
export function Page({children, footer}: {children: ReactNode; footer?: ReactNode}) {
  return (
    <>
      <Box
        component="main"
        sx={{
          maxWidth: tokens.maxWidth,
          mx: 'auto',
          px: `${tokens.space.page}px`,
          pt: 2,
          pb: footer ? 12 : 'calc(24px + env(safe-area-inset-bottom))',
        }}
      >
        {children}
      </Box>
      {footer && (
        <Box
          sx={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            bgcolor: color.base,
            borderTop: `1px solid ${color.main08}`,
            pb: 'env(safe-area-inset-bottom)',
          }}
        >
          <Box sx={{maxWidth: tokens.maxWidth, mx: 'auto', px: `${tokens.space.page}px`, py: 1.5}}>
            {footer}
          </Box>
        </Box>
      )}
    </>
  );
}

const STEPS = ['読取', '撮影', '判定'] as const;

/** 3段のステッパー。完了はチェック、現在は塗り円に番号、未到達は枠線のみ */
export function Stepper({current}: {current: 0 | 1 | 2}) {
  return (
    <Stack
      component="ol"
      direction="row"
      sx={{alignItems: 'flex-start', justifyContent: 'center', mb: 2, p: 0, listStyle: 'none'}}
      aria-label="進み具合"
    >
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <Stack key={label} component="li" direction="row" sx={{alignItems: 'flex-start'}}>
            {i > 0 && (
              <Box
                sx={{
                  width: 56,
                  height: 2,
                  mt: '13px',
                  bgcolor: i <= current ? color.main : color.main15,
                }}
              />
            )}
            <Stack
              sx={{alignItems: 'center', width: 56}}
              aria-current={active ? 'step' : undefined}
            >
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                  bgcolor: done || active ? color.main : color.base,
                  color: done || active ? color.base : color.main40,
                  border: done || active ? 'none' : `1.5px solid ${color.main25}`,
                }}
              >
                {done ? <CheckRoundedIcon sx={{fontSize: 18}} /> : i + 1}
              </Box>
              <Typography
                variant="body2"
                sx={{
                  mt: 0.5,
                  color: done || active ? color.main : color.main40,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {label}
              </Typography>
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}

/** 見出し（左）と補足（右） */
export function SectionTitle({title, aside}: {title: string; aside?: ReactNode}) {
  return (
    <Stack
      direction="row"
      sx={{alignItems: 'baseline', justifyContent: 'space-between', mt: 3, mb: 1}}
    >
      <Typography variant="h2">{title}</Typography>
      {aside && <Typography variant="caption">{aside}</Typography>}
    </Stack>
  );
}

/** 枠線つきのカード（影は使わない） */
export function Card({children, tinted}: {children: ReactNode; tinted?: boolean}) {
  return (
    <Box
      sx={{
        border: tinted ? 'none' : `1px solid ${color.main15}`,
        bgcolor: tinted ? color.main04 : color.base,
        borderRadius: `${tokens.radius.card}px`,
        px: `${tokens.space.card}px`,
        py: 1,
      }}
    >
      {children}
    </Box>
  );
}
