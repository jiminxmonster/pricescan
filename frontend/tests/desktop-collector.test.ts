import test from 'node:test';
import assert from 'node:assert/strict';
import { canShowDesktopScreen } from '../src/desktop-collector.ts';

test('stale or cancelled collection tasks do not offer a missing browser screen', () => {
  assert.equal(canShowDesktopScreen({ hasScreen: false }), false);
  assert.equal(canShowDesktopScreen({ hasScreen: true }), true);
});
