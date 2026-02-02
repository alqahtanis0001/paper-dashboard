import { Server as IOServer } from 'socket.io';
import type { NextApiRequest, NextApiResponse } from 'next';
import { setIO } from '@/lib/socketServer';
import { dealEngine } from '@/lib/engine/dealEngine';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // ensure engine is initialized
  dealEngine.getCurrentPrice();

  const anyRes = res as any;
  if (!anyRes.socket.server.io) {
    const io = new IOServer(anyRes.socket.server, {
      path: '/api/socket',
      cors: { origin: '*' },
    });
    anyRes.socket.server.io = io;
    setIO(io);
  }
  res.end();
}
