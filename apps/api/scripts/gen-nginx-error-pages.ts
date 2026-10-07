import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ERROR_LOCATIONS_PATH,
  ERROR_PAGES_PATH,
  renderErrorLocations,
  renderErrorPages,
} from '../src/edge/error-pages';

const root = fileURLToPath(new URL('../../../', import.meta.url));
writeFileSync(join(root, ERROR_PAGES_PATH), renderErrorPages());
writeFileSync(join(root, ERROR_LOCATIONS_PATH), renderErrorLocations());
console.error(`生成しました: ${ERROR_PAGES_PATH}, ${ERROR_LOCATIONS_PATH}`);
