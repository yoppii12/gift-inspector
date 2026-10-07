import {defineProject} from 'vitest/config';

export default defineProject({
  test: {
    name: 'web',
    include: ['test/**/*.spec.ts'],
  },
});
