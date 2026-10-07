/**
 * モック AI（ローカル開発・障害注入訓練・テスト用）。本番（NODE_ENV=production）では config で使用を禁止している。
 * 画像の中身は見ない。シナリオに応じて決まった応答や失敗を返す。
 */
import type {AiReadResult} from '@gift-inspector/shared';

import {type AiProvider, ProviderError, type ProviderResponse, type ReadRequest} from '../types';

export type MockScenario = 'ok' | 'schema_invalid' | 'timeout' | 'rate_limited' | 'auth';

/** 'ok' のときに返す読取結果（デモ用オーダー GIFT-DEMO-001 の印刷物と同じ内容） */
export const MOCK_READING: AiReadResult = {
  noshi_present: true,
  mizuhiki_type: '蝶結び',
  omotegaki: '御祝',
  atena: '佐藤 花子',
  card_present: true,
  card_text: 'ご出産おめでとうございます。心ばかりの品をお贈りします。',
};

const MOCK_LATENCY_MS = 800;

/** 1回分のふるまい。テストでは試行ごとに並べて渡す */
export type MockStep =
  | {type: 'tool_use'; input: unknown}
  | {type: 'stop'; stopReason: string; input?: unknown}
  | {type: 'error'; error: ProviderError}
  | {type: 'throw'; error: Error}
  | {type: 'hang'};

export function scenarioSteps(scenario: MockScenario): MockStep[] {
  switch (scenario) {
    case 'ok':
      return [{type: 'tool_use', input: MOCK_READING}];
    case 'schema_invalid':
      return [{type: 'tool_use', input: {...MOCK_READING, extra: 'x'}}];
    case 'timeout':
      return [{type: 'hang'}];
    case 'rate_limited':
      return [{type: 'error', error: new ProviderError('http', 'mock 429', {status: 429})}];
    case 'auth':
      return [{type: 'error', error: new ProviderError('http', 'mock 401', {status: 401})}];
  }
}

export class MockProvider implements AiProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  readonly requests: ReadRequest[] = [];
  private calls = 0;

  /** steps を試行ごとに順に使う。足りなければ最後のものを繰り返す */
  constructor(
    private readonly steps: MockStep[],
    private readonly latencyMs = MOCK_LATENCY_MS
  ) {
    if (steps.length === 0) throw new Error('MockProvider: steps が空です');
  }

  static fromScenario(scenario: MockScenario): MockProvider {
    return new MockProvider(scenarioSteps(scenario));
  }

  async read(request: ReadRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)] as MockStep;
    this.calls++;

    if (step.type === 'hang') {
      await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () =>
            reject(new ProviderError('timeout', 'mock timeout', {cause: request.signal.reason})),
          {once: true}
        );
      });
    }
    if (this.latencyMs > 0) await new Promise(r => setTimeout(r, this.latencyMs));
    switch (step.type) {
      case 'tool_use':
        return response('tool_use', step.input);
      case 'stop':
        return response(step.stopReason, step.input ?? null);
      case 'error':
        throw step.error;
      case 'throw':
        throw step.error;
      case 'hang':
        throw new Error('unreachable');
    }
  }
}

function response(stopReason: string, toolInput: unknown): ProviderResponse {
  return {
    stopReason,
    toolInput,
    raw: {mock: true, stopReason, toolInput},
    requestId: `mock-${Date.now()}`,
    tokensIn: null,
    tokensOut: null,
  };
}
