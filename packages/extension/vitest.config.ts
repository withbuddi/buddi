/** Node by default; the tree builder asks for jsdom in its own docblock. */
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
