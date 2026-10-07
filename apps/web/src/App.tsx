import type {OrderView} from '@gift-inspector/shared';
import {useState} from 'react';

import {AppHeader, Page} from './components/Layout';
import {ConnectionCheck} from './pages/ConnectionCheck';
import {Inspect} from './pages/Inspect';
import {OrderSelect} from './pages/OrderSelect';
import {isManualOrder} from './services/inspection';

type Screen = {kind: 'select'; order: OrderView | null} | {kind: 'inspect'; order: OrderView};

/** 2画面（オーダー選択 → 撮影・判定結果）。`?check=1` で接続確認画面（開発・導通確認用） */
export function App() {
  const [screen, setScreen] = useState<Screen>({kind: 'select', order: null});

  if (new URLSearchParams(location.search).has('check')) {
    return (
      <>
        <AppHeader title="接続確認" />
        <Page>
          <ConnectionCheck />
        </Page>
      </>
    );
  }

  if (screen.kind === 'inspect') {
    return (
      <Inspect
        // オーダーごとに状態を作り直す
        key={screen.order.orderCode}
        order={screen.order}
        // 手入力モードから戻るときは、オーダー確認ではなく選択画面に戻す（MANUAL をオーダーとして表示しない）
        onBack={() =>
          setScreen({kind: 'select', order: isManualOrder(screen.order) ? null : screen.order})
        }
        onNextOrder={() => setScreen({kind: 'select', order: null})}
      />
    );
  }

  return (
    <OrderSelect
      key={screen.order?.orderCode ?? 'none'}
      initialOrder={screen.order}
      onStart={order => setScreen({kind: 'inspect', order})}
    />
  );
}
