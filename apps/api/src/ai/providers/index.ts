import type {Config} from '../../config';
import type {AiProvider} from '../types';
import {MockProvider} from './mock';

/**
 * 設定から AI プロバイダを作る。実プロバイダは AI キー受領後に追加する。
 * 未実装のプロバイダを指定した場合は起動時に失敗させる（気づかないまま動かさない）。
 */
export function createProvider(config: Config): AiProvider {
  switch (config.AI_PROVIDER) {
    case 'mock':
      return MockProvider.fromScenario(config.AI_MOCK_SCENARIO);
    default:
      throw new Error(`AI_PROVIDER=${config.AI_PROVIDER} はまだ実装されていません`);
  }
}
