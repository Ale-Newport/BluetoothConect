/**
 * A Link whose other end is a Bluetooth radio in another process.
 *
 * `write` hands a datagram to whatever owns the radio; `deliver` is how a
 * datagram the radio received gets in. The protocol above sees an ordinary
 * `Link`, which is the point: it cannot tell this from the one the phone has.
 */
import {
  LinkState,
  TransportKind,
  TypedEmitter,
  type Link,
  type LinkEvents,
  type LinkMetrics,
  type SendMode,
} from '../../packages/core/src/index.js';

export class RadioLink implements Link {
  readonly id: string;
  readonly transport = TransportKind.BLE;
  readonly isHighBandwidth = false;
  readonly events = new TypedEmitter<LinkEvents>();
  state: LinkState = LinkState.CONNECTED;
  queuedCount = 0;

  private packetsSent = 0;
  private packetsReceived = 0;
  private bytesSent = 0;
  private bytesReceived = 0;

  constructor(
    readonly endpointId: string,
    readonly maxDatagramSize: number,
    private readonly write: (bytes: Uint8Array) => void,
  ) {
    this.id = `radio-${endpointId.slice(0, 8)}-${Date.now().toString(36)}`;
  }

  async send(bytes: Uint8Array, _mode: SendMode): Promise<void> {
    if (this.state !== LinkState.CONNECTED) throw new Error('link is closed');
    if (bytes.length > this.maxDatagramSize) {
      throw new Error(`datagram of ${bytes.length} bytes exceeds the link's ${this.maxDatagramSize}`);
    }
    this.packetsSent += 1;
    this.bytesSent += bytes.length;
    this.write(bytes);
  }

  deliver(bytes: Uint8Array): void {
    if (this.state !== LinkState.CONNECTED) return;
    this.packetsReceived += 1;
    this.bytesReceived += bytes.length;
    this.events.emit('data', { bytes });
  }

  /** The iPhone unsubscribed: nothing more will cross this link. */
  peerClosed(): void {
    if (this.state === LinkState.CLOSED) return;
    this.state = LinkState.CLOSED;
    this.events.emit('state', { state: LinkState.CLOSED, reason: 'the iPhone unsubscribed' });
  }

  async close(reason?: string): Promise<void> {
    if (this.state === LinkState.CLOSED) return;
    this.state = LinkState.CLOSED;
    this.events.emit('state', { state: LinkState.CLOSED, ...(reason ? { reason } : {}) });
  }

  metrics(): LinkMetrics {
    return {
      transport: TransportKind.BLE,
      maxDatagramSize: this.maxDatagramSize,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      packetsDropped: 0,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
    };
  }
}
