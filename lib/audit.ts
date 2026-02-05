import { Prisma, Role } from '@prisma/client';
import { prisma } from './prisma';

export async function logAuditEvent(eventType: string, actorRole: Role, metadata: Prisma.InputJsonObject) {
  await prisma.auditLog.create({
    data: {
      eventType,
      actorRole,
      metadata,
    },
  }).catch(() => null);
}
