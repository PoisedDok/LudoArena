import { Role } from '../../generated/prisma'
import prisma from '../lib/prisma'
import { invalidateDashboard } from './dashboard'
import { DEFAULT_COMMISSION_SETTINGS } from './commissionSettings'
import { emitToAll } from '../lib/socket'
import { removeAllStoredImages } from '../middleware/upload'
import { log } from '../lib/logger'
import { HttpError } from '../lib/errors'

export async function resetAdminData(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Match the lock order used by game settlement and ping responses before locking accounts.
    await tx.$queryRaw`SELECT "id" FROM "Ping" ORDER BY "id" FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "Game" ORDER BY "id" FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "User" ORDER BY "id" FOR UPDATE`

    await tx.idempotencyKey.deleteMany()
    await tx.shareLoginLink.deleteMany()
    await tx.screenshot.deleteMany()
    await tx.transaction.deleteMany()
    await tx.depositRequest.deleteMany()
    await tx.gamePlayer.deleteMany()
    await tx.game.deleteMany()
    await tx.pingRecipient.deleteMany()
    await tx.ping.deleteMany()
    await tx.commissionSettingChange.deleteMany()

    for (const { gameType, ...setting } of DEFAULT_COMMISSION_SETTINGS) {
      await tx.commissionSetting.update({
        where: { gameType },
        data: { ...setting, updatedById: null },
      })
    }
    await tx.user.updateMany({
      where: { role: Role.PLAYER },
      data: { balance: '0.00', creditLimit: '500.00', spendLimit: '1000.00', isActive: false },
    })
  })

  invalidateDashboard()
  emitToAll('system:data-reset', {})
  try {
    await removeAllStoredImages()
  } catch (error) {
    log.error('admin data reset committed but stored image cleanup failed', { err: error })
    throw new HttpError(500, 'Admin data was reset, but some stored screenshots could not be removed. Retry the reset to finish cleanup.')
  }
}
