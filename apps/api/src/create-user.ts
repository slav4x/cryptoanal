import { createPrismaClient } from "@cryptoanal/persistence";
import { argon2id, hash } from "argon2";

const email = readArgument("--email")?.trim().toLowerCase();
const displayName = readArgument("--name")?.trim();
const workspaceId = readArgument("--workspace")?.trim() ?? "development";
const password = process.env.CRYPTOANAL_NEW_USER_PASSWORD;

if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  throw new Error("Укажите корректный --email");
}
if (!displayName) throw new Error("Укажите --name");
if (!password || password.length < 12) {
  throw new Error("CRYPTOANAL_NEW_USER_PASSWORD должен содержать минимум 12 символов");
}

const prisma = createPrismaClient();

try {
  const [workspace, existingUser] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } }),
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  ]);
  if (!workspace) throw new Error(`Workspace ${workspaceId} не найден`);
  if (existingUser) throw new Error(`Пользователь ${email} уже существует`);

  const passwordHash = await hash(password, { type: argon2id });
  await prisma.user.create({
    data: {
      email,
      displayName,
      passwordHash,
      memberships: { create: { workspaceId, role: "OWNER" } },
    },
  });
  process.stdout.write(`Создан владелец ${email} для workspace ${workspace.name}\n`);
} finally {
  await prisma.$disconnect();
}

function readArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
