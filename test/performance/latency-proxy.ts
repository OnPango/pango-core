// A TCP proxy in front of the local test database that delays every chunk by
// half the round trip in each direction, to measure what network latency to the
// database (Supabase in another machine or region) does to an import.
import net from 'node:net';

export interface LatencyProxy {
  port: number;
  close: () => Promise<void>;
}

export async function startLatencyProxy(
  target: { host: string; port: number },
  roundTripMs: number,
): Promise<LatencyProxy> {
  const oneWay = roundTripMs / 2;
  const sockets = new Set<net.Socket>();

  /** Forwards chunks in order, each after `oneWay` ms. */
  const relay = (from: net.Socket, to: net.Socket) => {
    let chain = Promise.resolve();
    from.on('data', (chunk) => {
      chain = chain.then(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              if (!to.destroyed) to.write(chunk);
              resolve();
            }, oneWay),
          ),
      );
    });
    from.on('end', () => void chain.then(() => to.end()));
    from.on('error', () => to.destroy());
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    relay(client, upstream);
    relay(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
