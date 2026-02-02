import type { Server as HTTPServer } from 'http';
import type { Socket } from 'net';
import type { Server as IOServer } from 'socket.io';
import type { NextApiResponse } from 'next';

export {};

declare module 'next' {
  interface NextApiResponseServerIO extends NextApiResponse {
    socket: Socket & {
      server: HTTPServer & {
        io?: IOServer;
      };
    };
  }
}
