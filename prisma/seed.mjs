import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo-workspace' },
    update: {
      name: 'Demo Workspace',
      status: 'active',
    },
    create: {
      name: 'Demo Workspace',
      slug: 'demo-workspace',
      status: 'active',
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: 'owner@example.com' },
    update: {
      name: 'Workspace Owner',
      status: 'active',
    },
    create: {
      email: 'owner@example.com',
      name: 'Workspace Owner',
      status: 'active',
    },
  });

  await prisma.membership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: owner.id,
      },
    },
    update: {
      role: 'owner',
    },
    create: {
      workspaceId: workspace.id,
      userId: owner.id,
      role: 'owner',
    },
  });

  await prisma.platform.upsert({
    where: { key: 'facebook' },
    update: {
      name: 'Facebook',
      status: 'active',
    },
    create: {
      key: 'facebook',
      name: 'Facebook',
      status: 'active',
    },
  });

  console.log('Seed completed:', {
    workspaceId: workspace.id,
    ownerId: owner.id,
    platforms: ['facebook'],
  });
}

main()
  .catch((error) => {
    console.error('Prisma seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
