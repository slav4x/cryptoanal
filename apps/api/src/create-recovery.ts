import { loadServerConfig } from "@cryptoanal/config";
import {
  AuthRecoveryInvalidError,
  AuthRepository,
  createPrismaClient,
} from "@cryptoanal/persistence";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const email = readArgument("--email")?.trim().toLowerCase();
if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  throw new Error("Укажите корректный --email");
}

const config = loadServerConfig();
const prisma = createPrismaClient();
const repository = new AuthRepository(prisma);
const token = randomBytes(32).toString("base64url");
const expiresAt = new Date(Date.now() + config.AUTH_RECOVERY_TTL_MINUTES * 60_000);

try {
  const user = await repository.createPasswordRecovery({
    email,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt,
    actorId: "system:admin-cli",
    requestId: `recovery-cli:${randomUUID()}`,
  });
  const origin = config.DASHBOARD_ORIGIN.replace(/\/$/, "");
  process.stdout.write(
    `Создана одноразовая ссылка восстановления для ${user.displayName}:\n${origin}/recovery/${token}\nДействует до ${expiresAt.toISOString()}\n`,
  );
} catch (error) {
  if (error instanceof AuthRecoveryInvalidError) {
    throw new Error(`Активный пользователь ${email} не найден`, { cause: error });
  }
  throw error;
} finally {
  await prisma.$disconnect();
}

function readArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
