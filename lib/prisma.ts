import { Prisma, PrismaClient } from '@prisma/client';
import { runtimeEnv } from './runtimeEnv';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaBootLogged?: boolean };

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

if (!globalForPrisma.prismaBootLogged) {
  console.info('[server][runtime.storage] INFO', {
    runtimeTarget: runtimeEnv.runtimeTarget,
    storageMode: runtimeEnv.storageMode,
    hasDatabase: runtimeEnv.hasDatabase,
    databaseHost: runtimeEnv.databaseHost,
    databaseSource: runtimeEnv.databaseSource,
    databaseUrlAdapted: runtimeEnv.databaseUrlAdapted,
    secureCookies: runtimeEnv.secureCookies,
  });
  if (runtimeEnv.notes.length > 0) {
    console.info('[server][runtime.storage] NOTES', runtimeEnv.notes);
  }
  globalForPrisma.prismaBootLogged = true;
}
