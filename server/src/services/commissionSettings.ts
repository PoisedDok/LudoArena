import { GameType } from '../../generated/prisma'
import type { CommissionSetting, PrismaClient } from '../../generated/prisma'
import prisma, { Prisma, lockUsers, type Tx } from '../lib/prisma'

export type CommissionSnapshot = {
  commissionTierThresholdCents: number | null
  commissionHighRateBps: number | null
  commissionLowRateBps: number | null
  commissionFourPlayerSecondBps: number | null
}

export type CommissionSettingInput = {
  tierThresholdCents: number | null
  highRateBps: number | null
  lowRateBps: number | null
  fourPlayerSecondBps: number | null
}

export const DEFAULT_COMMISSION_SETTINGS = [
  { gameType: GameType.ONE_V_ONE, tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, fourPlayerSecondBps: null },
  { gameType: GameType.TWO_V_TWO, tierThresholdCents: 50_000, highRateBps: 500, lowRateBps: 300, fourPlayerSecondBps: null },
  { gameType: GameType.FOUR_PLAYER, tierThresholdCents: null, highRateBps: null, lowRateBps: null, fourPlayerSecondBps: 1_000 },
] satisfies Array<{ gameType: GameType } & CommissionSettingInput>

export type CommissionSettingView = CommissionSettingInput & {
  gameType: GameType
  updatedAt: string
  updatedBy: { id: string; username: string } | null
}

type SettingsClient = PrismaClient | Tx

function fieldsFromSetting(setting: CommissionSetting): CommissionSettingInput {
  const fields = {
    tierThresholdCents: setting.tierThresholdCents,
    highRateBps: setting.highRateBps,
    lowRateBps: setting.lowRateBps,
    fourPlayerSecondBps: setting.fourPlayerSecondBps,
  }
  const isTiered = setting.gameType === GameType.ONE_V_ONE || setting.gameType === GameType.TWO_V_TWO
  const valid = isTiered
    ? fields.tierThresholdCents !== null && fields.highRateBps !== null && fields.lowRateBps !== null && fields.fourPlayerSecondBps === null
    : fields.tierThresholdCents === null && fields.highRateBps === null && fields.lowRateBps === null && fields.fourPlayerSecondBps !== null
  if (!valid) throw new Error(`Invalid commission setting stored for ${setting.gameType}`)
  return fields
}

export function snapshotFromSetting(setting: CommissionSetting): CommissionSnapshot {
  const fields = fieldsFromSetting(setting)
  return {
    commissionTierThresholdCents: fields.tierThresholdCents,
    commissionHighRateBps: fields.highRateBps,
    commissionLowRateBps: fields.lowRateBps,
    commissionFourPlayerSecondBps: fields.fourPlayerSecondBps,
  }
}

export async function lockAndReadCommissionSnapshot(tx: Tx, gameType: GameType): Promise<CommissionSnapshot> {
  const locked = await tx.$queryRaw<Array<{ gameType: GameType }>>`
    SELECT "gameType" FROM "CommissionSetting"
    WHERE "gameType" = ${gameType}::"GameType"
    FOR SHARE
  `
  if (locked.length !== 1) throw new Error(`Missing commission setting for ${gameType}`)
  const setting = await tx.commissionSetting.findUniqueOrThrow({ where: { gameType } })
  return snapshotFromSetting(setting)
}

export async function listCommissionSettings(client: SettingsClient): Promise<CommissionSettingView[]> {
  const settings = await client.commissionSetting.findMany({
    orderBy: { gameType: 'asc' },
    include: { updatedBy: { select: { id: true, username: true } } },
  })
  if (settings.length !== 3) throw new Error('Commission settings are not fully initialized')
  return settings.map((setting) => ({
    gameType: setting.gameType,
    ...fieldsFromSetting(setting),
    updatedAt: setting.updatedAt.toISOString(),
    updatedBy: setting.updatedBy,
  }))
}

export async function updateCommissionSetting(
  gameType: GameType,
  input: CommissionSettingInput,
  actorId: string,
): Promise<CommissionSettingView> {
  return prisma.$transaction(async (tx) => {
    await lockUsers(tx, [actorId])
    const locked = await tx.$queryRaw<Array<{ gameType: GameType }>>`
      SELECT "gameType" FROM "CommissionSetting"
      WHERE "gameType" = ${gameType}::"GameType"
      FOR UPDATE
    `
    if (locked.length !== 1) throw new Error(`Missing commission setting for ${gameType}`)
    const existing = await tx.commissionSetting.findUniqueOrThrow({ where: { gameType } })
    const before = fieldsFromSetting(existing)
    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorId }, select: { username: true } })
    const data: Prisma.CommissionSettingUpdateInput = {
      ...input,
      updatedBy: { connect: { id: actorId } },
    }
    const updated = await tx.commissionSetting.update({
      where: { gameType },
      data,
      include: { updatedBy: { select: { id: true, username: true } } },
    })
    const after = fieldsFromSetting(updated)
    await tx.commissionSettingChange.create({
      data: {
        gameType,
        actorId,
        actorUsername: actor.username,
        before: before as Prisma.InputJsonValue,
        after: after as Prisma.InputJsonValue,
      },
    })
    return {
      gameType: updated.gameType,
      ...after,
      updatedAt: updated.updatedAt.toISOString(),
      updatedBy: updated.updatedBy,
    }
  })
}
