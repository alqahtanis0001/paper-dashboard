import { Prisma, PrismaClient } from '@prisma/client';
import { printRuntimeModeOnce, runtimeEnv } from './runtimeEnv';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const prismaDatasourceUrl = runtimeEnv.databaseUrl ?? 'postgresql://invalid:invalid@localhost:5432/unconfigured';
const prismaLogLevel: Prisma.LogLevel[] =
  runtimeEnv.runtimeTarget === 'local'
    ? ['query', 'info', 'warn', 'error']
    : runtimeEnv.runtimeTarget === 'render'
      ? ['warn', 'error']
      : ['error'];

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: prismaDatasourceUrl } },
    log: prismaLogLevel,
  });

if (runtimeEnv.runtimeTarget !== 'render') {
  globalForPrisma.prisma = prisma;
}
printRuntimeModeOnce();
