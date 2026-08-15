import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('LuminaRail Backend Express App', () => {
  it('should initialize and have a health check route', () => {
    const app = createApp();
    expect(app).toBeDefined();
  });
});
