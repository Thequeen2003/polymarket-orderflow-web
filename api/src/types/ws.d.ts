declare module 'ws' {
  export type RawData = unknown;

  export default class WebSocket {
    static OPEN: number;
    constructor(url: string, protocols?: unknown);
    readyState: number;
    send(data: unknown): void;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    onopen?: (() => void) | null;
    onmessage?: ((ev: { data: unknown }) => void) | null;
    onerror?: (() => void) | null;
    onclose?: (() => void) | null;
  }

  export class WebSocketServer {
    constructor(opts: { server: unknown; path?: string });
    on(event: 'connection', listener: (client: WebSocket) => void | Promise<void>): void;
    on(event: string, listener: (...args: any[]) => void): void;
  }
}

