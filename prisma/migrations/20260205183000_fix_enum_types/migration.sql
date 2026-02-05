-- Ensure enum types exist for Prisma enum-backed fields
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role') THEN
    CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoginAttemptRole') THEN
    CREATE TYPE "LoginAttemptRole" AS ENUM ('USER', 'ADMIN');
  END IF;
END $$;

-- AuthSession.role: TEXT -> Role
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AuthSession'
      AND column_name = 'role'
      AND udt_name <> 'Role'
  ) THEN
    ALTER TABLE "AuthSession"
      ALTER COLUMN "role" DROP DEFAULT,
      ALTER COLUMN "role" TYPE "Role" USING "role"::"Role",
      ALTER COLUMN "role" SET DEFAULT 'USER';
  END IF;
END $$;

-- LoginAttempt.roleAttempted: TEXT -> LoginAttemptRole
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'LoginAttempt'
      AND column_name = 'roleAttempted'
      AND udt_name <> 'LoginAttemptRole'
  ) THEN
    ALTER TABLE "LoginAttempt"
      ALTER COLUMN "roleAttempted" TYPE "LoginAttemptRole" USING "roleAttempted"::"LoginAttemptRole";
  END IF;
END $$;

-- AuditLog.actorRole: TEXT -> Role
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AuditLog'
      AND column_name = 'actorRole'
      AND udt_name <> 'Role'
  ) THEN
    ALTER TABLE "AuditLog"
      ALTER COLUMN "actorRole" TYPE "Role" USING "actorRole"::"Role";
  END IF;
END $$;
