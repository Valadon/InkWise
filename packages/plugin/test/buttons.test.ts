import { describe, expect, it } from 'vitest';
import { ScreenStore } from '../src/buttons';

describe('ScreenStore', () => {
  it('counts a button reported twice in quick succession as one press', () => {
    const s = new ScreenStore();
    s.set('sync', 1000);
    s.set('sync', 1300);
    expect(s.pressCount).toBe(1);
    s.set('sync', 5000);
    expect(s.pressCount).toBe(2);
  });

  it('still counts quick presses of different buttons', () => {
    const s = new ScreenStore();
    s.set('sync', 1000);
    s.set('done', 1100);
    expect(s.pressCount).toBe(2);
    expect(s.screen).toBe('done');
  });

  it('claims each press once, so a remounted screen does not redo it', () => {
    const s = new ScreenStore();
    s.set('sync', 1000);
    expect(s.claim(s.pressCount)).toBe(true);
    expect(s.claim(s.pressCount)).toBe(false);
  });
});
