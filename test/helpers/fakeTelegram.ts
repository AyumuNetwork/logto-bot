export type FakeCall = { method: string; payload: Record<string, unknown> };

/**
 * Minimal stand-in for `https://api.telegram.org`: records every Bot API call
 * and answers with plausible results so grammY handlers can be exercised
 * without network access.
 */
export const createFakeTelegramFetch = (options: { chatMemberStatus?: string } = {}) => {
  const calls: FakeCall[] = [];
  let messageId = 100;

  const reply = (result: unknown): Response =>
    new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = url.split('/').pop() ?? 'unknown';
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, payload });

    switch (method) {
      case 'sendMessage':
      case 'editMessageText':
      case 'editMessageReplyMarkup':
      case 'sendDocument':
        messageId += 1;
        return reply({
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(payload.chat_id ?? 0), type: 'private' },
          text: payload.text ?? '',
        });

      case 'getMe':
        return reply({ id: 999, is_bot: true, first_name: 'TestBot', username: 'test_bot' });

      case 'getChatMember':
        return reply({
          status: options.chatMemberStatus ?? 'member',
          user: { id: Number(payload.user_id ?? 0), is_bot: false, first_name: 'Member' },
        });

      case 'getChatAdministrators':
        return reply([
          {
            status: 'creator',
            user: { id: 111, is_bot: false, first_name: 'Admin' },
          },
        ]);

      case 'setMyCommands':
        return reply(true);

      default:
        return reply(true);
    }
  };

  return { fetch: fetchImpl, calls };
};
