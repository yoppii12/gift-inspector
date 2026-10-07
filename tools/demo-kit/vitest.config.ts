import {defineProject} from 'vitest/config';

export default defineProject({
  test: {
    name: 'demo-kit',
    include: ['test/**/*.spec.ts'],
  },
});
