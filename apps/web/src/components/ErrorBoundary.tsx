import {Box} from '@mui/material';
import {Component, type ErrorInfo, type ReactNode} from 'react';

import {type ClientError, toClientError} from '../services/api';
import {reportClientError} from '../services/report';
import {ErrorPanel} from './ErrorPanel';

interface State {
  error: ClientError | null;
}

/** 描画中の想定外の例外を捕まえ、SYS_UNEXPECTED として表示・報告する（白画面にしない） */
export class ErrorBoundary extends Component<{children: ReactNode}, State> {
  override state: State = {error: null};

  static getDerivedStateFromError(error: unknown): State {
    return {error: toClientError(error)};
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('描画中にエラーが発生しました', error, info.componentStack);
    reportClientError(error, {force: true});
  }

  override render() {
    if (this.state.error) {
      return (
        <Box sx={{p: 2}}>
          <ErrorPanel
            error={this.state.error}
            onAction={() => {
              location.href = '/';
            }}
          />
        </Box>
      );
    }
    return this.props.children;
  }
}
