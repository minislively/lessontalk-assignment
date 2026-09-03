// The API package owns the dependencies; keeping the seed at the repository
// root avoids introducing a second package manifest solely for Prisma.
import { PrismaClient } from '../apps/api/node_modules/@prisma/client/index.js';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);

export function normalizeKoreanPhone(value: string): string {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (digits.startsWith('82')) return `0${digits.slice(2)}`;
  return digits;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function main() {
  const store = await prisma.store.upsert({
    where: { vendor_externalStoreId: { vendor: 'VENDOR_A', externalStoreId: 'A-1001' } },
    update: { name: 'A-1001 레슨톡 매장' },
    create: { vendor: 'VENDOR_A', externalStoreId: 'A-1001', name: 'A-1001 레슨톡 매장' },
  });

  const accounts = [
    { name: '한지우', phone: '010-0000-0001', role: 'MEMBER' as const, password: 'password123' },
    { name: '박프로', phone: '010-9000-0503', role: 'INSTRUCTOR' as const, password: 'password123' },
    { name: '점주', phone: '010-9000-0001', role: 'OWNER' as const, password: 'password123' },
  ];

  for (const account of accounts) {
    const passwordHash = await hashPassword(account.password);
    const user = await prisma.user.upsert({
      where: { phoneNormalized: normalizeKoreanPhone(account.phone) },
      update: { name: account.name, passwordHash },
      create: {
        name: account.name,
        phoneNormalized: normalizeKoreanPhone(account.phone),
        passwordHash,
      },
    });
    await prisma.membership.upsert({
      where: { userId_storeId: { userId: user.id, storeId: store.id } },
      update: { effectiveRole: account.role },
      create: { userId: user.id, storeId: store.id, effectiveRole: account.role },
    });
  }

  console.log('Seeded Lessontalk accounts. Password for all seeded accounts: password123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
