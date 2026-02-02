import { Server as IOServer } from 'socket.io';
import type { NextApiRequest, NextApiResponse } from 'next';
import { setIO } from '@/lib/socketServer';
import { dealEngine } from '@/lib/engine/dealEngine';
import type { Server as HTTPServer } from 'http';
import type { Socket } from 'net';

type NextApiResponseServerIO = NextApiResponse & {
  socket: Socket & {
    server: HTTPServer & {
      io?: IOServer;
    };
  };
};

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req: NextApiRequest, res: NextApiResponseServerIO) {
  // ensure engine is initialized
  dealEngine.getCurrentPrice();

  if (!res.socket.server.io) {
    const io = new IOServer(res.socket.server, {
      path: '/api/socket',
      cors: { origin: '*' },
    });
    res.socket.server.io = io;
    setIO(io);
  }
  res.end();
}
