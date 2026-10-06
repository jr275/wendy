import EventEmitter from 'node:events';

/**
 * In-process notification bus used by the legacy prototype to push pipeline output to SSE clients.
 */
export class EventBus extends EventEmitter {}

export const globalEventBus = new EventBus();
