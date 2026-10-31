import { EventEmitter } from 'node:events';

export type BusEvent = {
  name: 'logto_event' | 'outbox' | 'binding' | 'role_sync' | 'error';
  at: number;
  data: Record<string, unknown>;
};

const MAX_BUFFER = 100;

/**
 * In-process event bus for the `/ws` control channel. Keeps a small ring buffer
 * so a freshly connected client can catch up on the latest events.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: BusEvent[] = [];

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(name: BusEvent['name'], data: Record<string, unknown> = {}): void {
    const event: BusEvent = { name, at: Date.now(), data };

    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }
    this.emitter.emit('event', event);
  }

  onEvent(listener: (event: BusEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  recent(topics?: string[], limit = 20): BusEvent[] {
    const filtered = topics?.length
      ? this.buffer.filter((event) => topics.includes(event.name))
      : this.buffer;
    return filtered.slice(-limit);
  }
}

export const eventBus = new EventBus();
