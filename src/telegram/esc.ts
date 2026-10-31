/**
 * MarkdownV2 escaping for Telegram: every reserved character must be escaped
 * with a single backslash, otherwise the Bot API rejects the message.
 */
const RESERVED = /([_*[\]()~`>#+\-=|{}.!\\])/g;

export const escapeMarkdown = (input: string): string => input.replace(RESERVED, '\\$1');

export const MAX_MESSAGE_LENGTH = 4096;

/** Split a long message on line boundaries so it fits into Telegram limits. */
export const splitMessage = (text: string, limit = MAX_MESSAGE_LENGTH): string[] => {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let buffer = '';

  for (const line of text.split('\n')) {
    if ((buffer + line).length + 1 > limit) {
      if (buffer) {
        chunks.push(buffer);
      }
      buffer = line.slice(0, limit);
    } else {
      buffer = buffer ? `${buffer}\n${line}` : line;
    }
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
};
