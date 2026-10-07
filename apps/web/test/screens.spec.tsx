// @vitest-environment jsdom
/**
 * 画面のテスト（docs/error-handling.md 5.1）。4状態の見分け、参考警告、撮影〜送信の状態遷移。
 */
import {ThemeProvider} from '@mui/material';
import type {InspectionItem, InspectionResult, OrderView} from '@gift-inspector/shared';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ResultView} from '../src/components/ResultView';
import {Inspect} from '../src/pages/Inspect';
import {ClientError} from '../src/services/api';
import {theme} from '../src/theme';

const services = vi.hoisted(() => ({
  postInspection: vi.fn(),
  newInspectionId: vi.fn(),
  prepareImage: vi.fn(),
  reportClientError: vi.fn(),
}));
vi.mock('../src/services/inspection', () => ({
  postInspection: services.postInspection,
  newInspectionId: services.newInspectionId,
}));
vi.mock('../src/services/media', () => ({prepareImage: services.prepareImage}));
vi.mock('../src/services/report', () => ({reportClientError: services.reportClientError}));

const wrap = (ui: ReactNode) => render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

const item = (
  key: InspectionItem['key'],
  result: InspectionItem['result'],
  extra: Partial<InspectionItem> = {}
): InspectionItem => ({
  key,
  label: key,
  result,
  reason: result === 'OK' ? 'MATCH' : 'MISMATCH',
  expected: '御祝',
  read: '御祝',
  ...extra,
});

function result(overrides: Partial<InspectionResult> = {}): InspectionResult {
  return {
    inspectionId: 'id-1',
    orderCode: 'GIFT-DEMO-001',
    overall: 'OK',
    ngReason: null,
    unreadableReason: null,
    items: [
      item('omotegaki', 'OK'),
      item('atena', 'OK'),
      item('card_text', 'SKIP', {reason: 'NOT_REQUIRED'}),
    ],
    refWarnings: [],
    reference: {
      noshiPresent: true,
      cardPresent: false,
      mizuhikiRead: '蝶結び',
      mizuhikiExpected: '蝶結び',
    },
    completedAt: '2026-10-07T00:00:00Z',
    replayed: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ResultView', () => {
  it('OK: 「すべて一致」「出荷に進めます」', () => {
    wrap(<ResultView result={result()} photoUrl={null} />);
    expect(screen.getByText('すべて登録内容と一致しました')).toBeTruthy();
    expect(screen.getByText('出荷に進めます。')).toBeTruthy();
  });

  it('OK でも参考警告があれば「出荷に進めます」と言い切らず、警告を先に出す', () => {
    wrap(<ResultView result={result({refWarnings: ['CARD_UNEXPECTED']})} photoUrl={null} />);
    expect(screen.queryByText('出荷に進めます。')).toBeNull();
    expect(screen.getByText(/参考判定に警告があります/)).toBeTruthy();
    const alerts = screen.getAllByRole('status').map(e => e.textContent ?? '');
    expect(alerts[0]).toContain('参考判定の警告');
    expect(alerts[1]).toContain('すべて登録内容と一致しました');
  });

  it('NG: 不一致の項目名を見出しに出す', () => {
    wrap(
      <ResultView
        result={result({
          overall: 'NG',
          items: [item('omotegaki', 'NG', {read: '御礼'}), item('atena', 'OK')],
        })}
        photoUrl={null}
      />
    );
    expect(screen.getByText('omotegakiが登録内容と一致しません')).toBeTruthy();
    expect(screen.queryByText('すべて登録内容と一致しました')).toBeNull();
  });

  it('判定不能: NG とは別の見出しで撮り直しを促す', () => {
    wrap(
      <ResultView
        result={result({
          overall: 'UNREADABLE',
          unreadableReason: 'TEXT_UNREADABLE',
          items: [item('omotegaki', 'UNREADABLE', {read: null, reason: 'TEXT_UNREADABLE'})],
        })}
        photoUrl={null}
      />
    );
    expect(screen.getByText('読み取れませんでした（NG扱い）')).toBeTruthy();
    expect(screen.getByText('（読み取れず）')).toBeTruthy();
  });

  it('対象物が写っていない NG は「写っていません」と出し、読み取れずと区別する', () => {
    wrap(
      <ResultView
        result={result({
          overall: 'NG',
          items: [item('omotegaki', 'NG', {read: null, reason: 'NOT_PRESENT'})],
        })}
        photoUrl={null}
      />
    );
    expect(screen.getByText('（写っていません）')).toBeTruthy();
    expect(screen.queryByText('（読み取れず）')).toBeNull();
  });
});

describe('Inspect（撮影〜送信）', () => {
  const order: OrderView = {
    orderCode: 'GIFT-DEMO-001',
    omotegaki: '御祝',
    atena: '佐藤 花子',
    cardText: null,
    noshiType: '蝶結び',
    noshiRequired: true,
    cardRequired: false,
  };
  let ids: number;

  beforeEach(() => {
    ids = 0;
    services.newInspectionId.mockImplementation(() => `id-${++ids}`);
    services.prepareImage.mockResolvedValue({
      blob: new Blob(['x']),
      width: 1600,
      height: 1200,
      originalBytes: 1,
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  const choosePhoto = (container: HTMLElement) =>
    act(async () => {
      const input = container.querySelector('input[type=file]') as HTMLInputElement;
      fireEvent.change(input, {target: {files: [new File(['x'], 'p.jpg', {type: 'image/jpeg'})]}});
      await Promise.resolve();
    });

  it('エラーのときは「判定できませんでした」で、判定結果の見た目にしない', async () => {
    services.postInspection.mockRejectedValue(
      new ClientError('AI_TIMEOUT', {inspectionId: 'id-1'})
    );
    const {container} = wrap(<Inspect order={order} onBack={vi.fn()} onNextOrder={vi.fn()} />);
    await choosePhoto(container);
    await waitFor(() =>
      expect(screen.getAllByText('判定できませんでした').length).toBeGreaterThan(0)
    );
    expect(screen.getByText('この結果は品質の判定ではありません。')).toBeTruthy();
    expect(screen.queryByText('判定結果')).toBeNull();
    expect(services.reportClientError).toHaveBeenCalled();
  });

  it('「もう一度試す」は新しい検品 ID で送り直す', async () => {
    services.postInspection
      .mockRejectedValueOnce(new ClientError('AI_TIMEOUT', {inspectionId: 'id-1'}))
      .mockResolvedValueOnce(result({inspectionId: 'id-2'}));
    const {container} = wrap(<Inspect order={order} onBack={vi.fn()} onNextOrder={vi.fn()} />);
    await choosePhoto(container);
    await waitFor(() => screen.getByRole('button', {name: 'もう一度試す'}));
    fireEvent.click(screen.getByRole('button', {name: 'もう一度試す'}));
    await waitFor(() => screen.getByText('すべて登録内容と一致しました'));
    expect(services.postInspection.mock.calls.map(c => c[0] as unknown)).toEqual(['id-1', 'id-2']);
  });

  it('送信中に画面を離れたら中断する（signal が abort される）', async () => {
    let signal: AbortSignal | undefined;
    services.postInspection.mockImplementation(
      (_id: string, _o: string, _b: Blob, opts: {signal: AbortSignal}) =>
        new Promise((_res, rej) => {
          signal = opts.signal;
          opts.signal.addEventListener('abort', () =>
            rej(new ClientError('REQUEST_ABORTED', {inspectionId: 'id-1'}))
          );
        })
    );
    const {container} = wrap(<Inspect order={order} onBack={vi.fn()} onNextOrder={vi.fn()} />);
    await choosePhoto(container);
    await waitFor(() => screen.getByText('AIが照合しています'));
    expect(screen.queryByRole('button', {name: '戻る'})).toBeNull();
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => screen.getByText('REQUEST_ABORTED'));
    expect(signal?.aborted).toBe(true);
    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
  });

  it('写真を変換中に画面を離れたら、送信しない', async () => {
    let finish: (v: unknown) => void = () => {};
    services.prepareImage.mockReturnValue(new Promise(r => (finish = r)));
    const {container, unmount} = wrap(
      <Inspect order={order} onBack={vi.fn()} onNextOrder={vi.fn()} />
    );
    await choosePhoto(container);
    expect(screen.getByText('写真を準備しています')).toBeTruthy();
    unmount();
    await act(async () => finish({blob: new Blob(['x']), width: 1, height: 1, originalBytes: 1}));
    expect(services.postInspection).not.toHaveBeenCalled();
  });

  it('写真を読み込めなければ、前の写真を表示しない', async () => {
    services.postInspection.mockResolvedValueOnce(result({inspectionId: 'id-1'}));
    const {container} = wrap(<Inspect order={order} onBack={vi.fn()} onNextOrder={vi.fn()} />);
    await choosePhoto(container);
    await waitFor(() => screen.getByText('すべて登録内容と一致しました'));
    services.prepareImage.mockRejectedValueOnce(new ClientError('IMAGE_DECODE_FAILED'));
    await choosePhoto(container);
    await waitFor(() => screen.getByText('IMAGE_DECODE_FAILED'));
    expect(screen.queryByAltText('撮影した写真')).toBeNull();
  });
});
