import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import socketClientSource from '../src/socket-client.js';

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(payload) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}
MockWebSocket.instances = [];

describe('socket client shim', () => {
  let previousWindow;
  let previousWebSocket;

  beforeEach(() => {
    previousWindow = globalThis.window;
    previousWebSocket = globalThis.WebSocket;
    globalThis.window = { location: { protocol: 'https:', host: 'game.example.com' } };
    globalThis.WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    // eslint-disable-next-line no-new-func
    new Function(socketClientSource)();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.window = previousWindow;
    globalThis.WebSocket = previousWebSocket;
  });

  it('supports io/on/emit callback protocol over native websocket', () => {
    const socket = window.io({ auth: { token: 'abc' } });
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('wss://game.example.com/ws?token=abc');
    ws.open();
    expect(socket.connected).toBe(true);

    const roomHandler = vi.fn();
    socket.on('roomState', roomHandler);
    ws.message({ event: 'roomState', data: { id: 'r1' } });
    expect(roomHandler).toHaveBeenCalledWith({ id: 'r1' });

    const ack = vi.fn();
    socket.emit('joinRoom', { roomId: 'r1' }, ack);
    expect(ws.sent[0]).toMatchObject({ event: 'joinRoom', data: { roomId: 'r1' } });
    ws.message({ event: 'ack', data: { ackId: ws.sent[0].ackId, payload: { success: true } } });
    expect(ack).toHaveBeenCalledWith({ success: true });
  });

  it('reconnects automatically after an unexpected close', () => {
    vi.useFakeTimers();
    const socket = window.io({
      auth: { token: 'abc' },
      reconnectionDelay: 50,
      reconnectionDelayMax: 50
    });
    const reconnecting = vi.fn();
    const reconnect = vi.fn();
    socket.on('reconnecting', reconnecting);
    socket.on('reconnect', reconnect);

    const firstWs = MockWebSocket.instances[0];
    firstWs.open();
    firstWs.close();

    expect(socket.connected).toBe(false);
    expect(reconnecting).toHaveBeenCalledWith({ attempt: 1, delay: 50 });
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(50);
    expect(MockWebSocket.instances).toHaveLength(2);
    const secondWs = MockWebSocket.instances[1];
    expect(secondWs.url).toBe('wss://game.example.com/ws?token=abc');

    secondWs.open();
    expect(socket.connected).toBe(true);
    expect(reconnect).toHaveBeenCalledWith({ attempt: 1 });
  });

  it('returns a timeout response when an ack is not received', () => {
    vi.useFakeTimers();
    const socket = window.io({ auth: { token: 'abc' }, ackTimeout: 100 });
    const ws = MockWebSocket.instances[0];
    ws.open();

    const ack = vi.fn();
    socket.emit('joinRoom', { roomId: 'r1' }, ack);
    const ackId = ws.sent[0].ackId;

    vi.advanceTimersByTime(100);
    expect(ack).toHaveBeenCalledWith({ success: false, error: '请求超时' });

    ws.message({ event: 'ack', data: { ackId, payload: { success: true } } });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after a manual disconnect', () => {
    vi.useFakeTimers();
    const socket = window.io({ auth: { token: 'abc' }, reconnectionDelay: 50 });
    const ws = MockWebSocket.instances[0];
    ws.open();

    socket.disconnect();
    vi.advanceTimersByTime(50);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.connected).toBe(false);
  });
});
