import type {Config} from '../../config';
import type {AiProvider} from '../types';
import {GoogleProvider} from './google';
import {MockProvider} from './mock';

/**
 * 設定から AI プロバイダを作る。
 * 未実装のプロバイダを指定した場合は起動時に失敗させる（気づかないまま動かさない）。
 */
export function createProvider(config: Config): AiProvider {
  switch (config.AI_PROVIDER) {
    case 'mock':
      return MockProvider.fromScenario(config.AI_MOCK_SCENARIO);
    case 'google':
      return new GoogleProvider({apiKey: config.GEMINI_API_KEY, model: config.AI_MODEL});
    case 'anthropic':
      throw new Error('AI_PROVIDER=anthropic はまだ実装されていません（#19）');
  }
}
