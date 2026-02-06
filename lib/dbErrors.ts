import { Prisma } from '@prisma/client';

const CONNECTIVITY_ERROR_CODES = new Set([
  'P1000', // Authentication failed
  'P1001', // Can't reach database server
  'P1002', // Timeout reached
  'P1008', // Operations timed out
  'P1010', // Access denied
  'P1017', // Server closed connection
]);

export function isDatabaseConnectivityError(error: unknown) {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientRustPanicError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError && CONNECTIVITY_ERROR_CODES.has(error.code)) return true;

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("can't reach database server") ||
      message.includes('connection refused') ||
      message.includes('connection reset') ||
      message.includes('connection terminated') ||
      message.includes('failed to connect')
    );
  }

  return false;
}
