import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/noto-sans-jp/600.css';

import {CssBaseline, ThemeProvider} from '@mui/material';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './App';
import {ErrorBoundary} from './components/ErrorBoundary';
import {installGlobalErrorHandlers} from './services/report';
import {theme} from './theme';

// 画面のどこでも捕まらなかった例外も、報告してコンソールに残す（握りつぶさない）
installGlobalErrorHandlers(err => console.error('捕捉されなかったエラー', err));

const root = document.getElementById('root');
if (!root) throw new Error('#root がありません');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>
);
