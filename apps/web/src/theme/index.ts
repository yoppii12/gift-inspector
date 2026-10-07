import {createTheme} from '@mui/material/styles';

/**
 * デザイントークン（docs/design/DESIGN_SPEC.md 2章）。画面側で色やサイズを直書きしない。
 * accent は NG・判定不能だけに使い、画面面積の3%未満に抑える。
 */
export const tokens = {
  color: {
    base: '#FFFFFF',
    main: '#171A31',
    accent: '#F05A22',
    main90: '#393C4F',
    main60: '#737583',
    main40: '#9D9EA8',
    main25: '#CBCCD1',
    main15: '#E0E1E4',
    main08: '#EEEEF0',
    main04: '#F6F6F7',
  },
  radius: {card: 12, button: 10, chip: 999, box: 2},
  space: {page: 16, card: 16},
  touchTarget: 44,
  maxWidth: 480,
} as const;

const fontFamily = '"Inter", "Noto Sans JP", sans-serif';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {main: tokens.color.main, contrastText: tokens.color.base},
    secondary: {main: tokens.color.main60},
    // 状態色（緑・赤）は使わない。NG・判定不能はアクセント色
    error: {main: tokens.color.accent, contrastText: tokens.color.base},
    warning: {main: tokens.color.accent},
    success: {main: tokens.color.main},
    info: {main: tokens.color.main},
    text: {
      primary: tokens.color.main,
      secondary: tokens.color.main60,
      disabled: tokens.color.main40,
    },
    divider: tokens.color.main15,
    background: {default: tokens.color.base, paper: tokens.color.base},
  },
  shape: {borderRadius: tokens.radius.button},
  typography: {
    fontFamily,
    h1: {fontSize: 18, fontWeight: 600},
    h2: {fontSize: 15, fontWeight: 600},
    h3: {fontSize: 14, fontWeight: 600},
    body1: {fontSize: 14, fontWeight: 500},
    body2: {fontSize: 12.5, fontWeight: 500},
    caption: {fontSize: 11.5, fontWeight: 400, color: tokens.color.main60},
    button: {fontSize: 15, fontWeight: 600, textTransform: 'none'},
  },
  shadows: Array(25).fill('none') as ReturnType<typeof createTheme>['shadows'],
  components: {
    MuiButton: {
      defaultProps: {disableElevation: true},
      styleOverrides: {
        root: {minHeight: tokens.touchTarget, borderRadius: tokens.radius.button},
        sizeLarge: {minHeight: 50},
        outlined: {borderWidth: 1.3, borderColor: tokens.color.main, '&:hover': {borderWidth: 1.3}},
      },
    },
    MuiPaper: {
      styleOverrides: {root: {backgroundImage: 'none'}},
    },
  },
});
