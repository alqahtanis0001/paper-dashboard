import type { Server as IOServer } from 'socket.io';

const globalStore = globalThis as unknown as { io?: IOServer };

export function setIO(io: IOServer) {
  globalStore.io = io;
}

export function getIO(): IOServer | null {
  return globalStore.io ?? null;
}
