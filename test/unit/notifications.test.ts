import { describe, expect, it } from 'vitest';

import { planNotification, renderNotification } from '../../src/services/notifications.js';
import { escapeMarkdown, splitMessage } from '../../src/telegram/esc.js';

const base = {
  hookId: 'hook_1',
  createdAt: '2026-10-31T02:00:00.000Z',
  userAgent: 'Mozilla/5.0',
  ip: '203.0.113.7',
  userId: 'user_1',
  application: { id: 'app_1', name: 'GitLab', type: 'Traditional' },
};

describe('planNotification', () => {
  it('maps sign-in to the signin kind with app/ip/time', () => {
    const plan = planNotification({ ...base, event: 'PostSignIn' });
    expect(plan.kind).toBe('signin');
    expect(plan.title).toContain('登录');
    expect(plan.lines.join('\n')).toContain('GitLab');
    expect(plan.lines.join('\n')).toContain('203.0.113.7');
  });

  it('maps password reset to the password kind', () => {
    expect(planNotification({ ...base, event: 'PostResetPassword' }).kind).toBe('password');
  });

  it('maps lockout to security', () => {
    expect(planNotification({ ...base, event: 'Identifier.Lockout' }).kind).toBe('security');
  });

  it('keeps noisy events silent', () => {
    expect(planNotification({ ...base, event: 'Message.RateLimited' }).kind).toBe('none');
    expect(planNotification({ ...base, event: 'Role.Created' }).kind).toBe('none');
  });

  it('describes user data changes', () => {
    const plan = planNotification({
      ...base,
      event: 'User.Data.Updated',
      data: { primaryEmail: 'a@b.c', identities: { Telegram: {} } },
    });
    expect(plan.lines.join('\n')).toContain('a@b.c');
    expect(plan.lines.join('\n')).toContain('Telegram');
  });
});

describe('renderNotification', () => {
  it('escapes markdown reserved characters', () => {
    const plan = planNotification({ ...base, event: 'PostSignIn', application: { id: 'a', name: 'a_b*c', type: 'Traditional' } });
    const text = renderNotification(plan);
    expect(text).toContain('a\\_b\\*c');
    expect(text.startsWith('🔐 *')).toBe(true);
  });

  it('escapes every reserved character', () => {
    expect(escapeMarkdown('a.b!c#d(e)')).toBe('a\\.b\\!c\\#d\\(e\\)');
  });
});

describe('splitMessage', () => {
  it('splits long messages on line boundaries', () => {
    const text = Array.from({ length: 100 }, (_, index) => `line-${index}-${'x'.repeat(50)}`).join('\n');
    const chunks = splitMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('returns the original message when short enough', () => {
    expect(splitMessage('hi')).toEqual(['hi']);
  });
});
