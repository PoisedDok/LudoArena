import { describe, expect, it } from 'vitest'
import { InvalidResultError, planSettlement as buildPlan } from '../src/services/settlement'
import { tierCommissionCents } from '../src/lib/money'
import type { CommissionSnapshot } from '../src/services/commissionSettings'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`)
const delta = (plan: ReturnType<typeof planSettlement>, id: string) => plan.deltas.get(id)
const soloRules: CommissionSnapshot = {
  commissionTierThresholdCents: 50_000,
  commissionHighRateBps: 500,
  commissionLowRateBps: 300,
  commissionFourPlayerSecondBps: null,
}
const fourPlayerRules: CommissionSnapshot = {
  commissionTierThresholdCents: null,
  commissionHighRateBps: null,
  commissionLowRateBps: null,
  commissionFourPlayerSecondBps: 1_000,
}
function planSettlement(input: Omit<Parameters<typeof buildPlan>[0], 'commission'> & { commission?: CommissionSnapshot }) {
  const commission = input.commission ?? (input.gameType === 'FOUR_PLAYER' ? fourPlayerRules : soloRules)
  return buildPlan({ ...input, commission })
}

describe('planSettlement: Solo', () => {
  it('pays the winner stake minus 5% and charges the loser the stake (stake 200)', () => {
    const plan = planSettlement({
      gameType: 'ONE_V_ONE',
      stakeCents: 20_000,
      players: ids(2).map((userId) => ({ userId, team: null })),
      winnerId: 'p1',
    })
    expect(delta(plan, 'p1')).toBe(19_000)
    expect(delta(plan, 'p2')).toBe(-20_000)
    expect(plan.entries.map((e) => [e.userId, e.type, e.amountCents])).toEqual([
      ['p1', 'GAME_WIN', 20_000],
      ['p1', 'COMMISSION', -1_000],
      ['p2', 'GAME_LOSS', -20_000],
    ])
  })

  it('uses the 3% tier above 500 (stake 1000)', () => {
    const plan = planSettlement({ gameType: 'ONE_V_ONE', stakeCents: 100_000, players: ids(2).map((userId) => ({ userId, team: null })), winnerId: 'p2' })
    expect(delta(plan, 'p2')).toBe(97_000)
    expect(delta(plan, 'p1')).toBe(-100_000)
  })

  it('uses the configured rate at the threshold and the lower rate one cent above', () => {
    const custom = { ...soloRules, commissionTierThresholdCents: 20_000, commissionHighRateBps: 250, commissionLowRateBps: 125 }
    const atThreshold = planSettlement({ gameType: 'ONE_V_ONE', stakeCents: 20_000, players: ids(2).map((userId) => ({ userId, team: null })), winnerId: 'p1', commission: custom })
    const above = planSettlement({ gameType: 'ONE_V_ONE', stakeCents: 20_001, players: ids(2).map((userId) => ({ userId, team: null })), winnerId: 'p1', commission: custom })
    expect(delta(atThreshold, 'p1')).toBe(19_500)
    expect(delta(above, 'p1')).toBe(19_751)
  })
})

describe('planSettlement: Teams', () => {
  const players = [
    { userId: 'p1', team: 1 },
    { userId: 'p2', team: 2 },
    { userId: 'p3', team: 1 },
    { userId: 'p4', team: 2 },
  ]

  it('pays both members of the winning team and charges both losers (stake 300)', () => {
    const plan = planSettlement({ gameType: 'TWO_V_TWO', stakeCents: 30_000, players, winnerId: 'p3' })
    expect(delta(plan, 'p1')).toBe(28_500)
    expect(delta(plan, 'p3')).toBe(28_500)
    expect(delta(plan, 'p2')).toBe(-30_000)
    expect(delta(plan, 'p4')).toBe(-30_000)
  })

  it('uses the independent Teams commission snapshot', () => {
    const commission: CommissionSnapshot = {
      commissionTierThresholdCents: 50_000,
      commissionHighRateBps: 250,
      commissionLowRateBps: 125,
      commissionFourPlayerSecondBps: null,
    }
    const plan = planSettlement({ gameType: 'TWO_V_TWO', stakeCents: 30_000, players, winnerId: 'p1', commission })
    expect(delta(plan, 'p1')).toBe(29_250)
    expect(delta(plan, 'p3')).toBe(29_250)
    expect(delta(plan, 'p2')).toBe(-30_000)
    expect(delta(plan, 'p4')).toBe(-30_000)
  })

  it('refuses a game whose teams are not two and two', () => {
    const broken = players.map((p) => ({ ...p, team: p.userId === 'p4' ? 1 : p.team }))
    expect(() => planSettlement({ gameType: 'TWO_V_TWO', stakeCents: 30_000, players: broken, winnerId: 'p1' })).toThrow(InvalidResultError)
    const noTeams = players.map((p) => ({ ...p, team: null }))
    expect(() => planSettlement({ gameType: 'TWO_V_TWO', stakeCents: 30_000, players: noTeams, winnerId: 'p1' })).toThrow(InvalidResultError)
  })
})

describe('planSettlement: 4 players', () => {
  const players = ids(4).map((userId) => ({ userId, team: null }))

  it('pays 1st the full stake, 2nd 90%, charges 3rd and 4th (stake 1000)', () => {
    const plan = planSettlement({ gameType: 'FOUR_PLAYER', stakeCents: 100_000, players, winnerId: 'p1', secondPlaceId: 'p3' })
    expect(delta(plan, 'p1')).toBe(100_000)
    expect(delta(plan, 'p3')).toBe(90_000)
    expect(delta(plan, 'p2')).toBe(-100_000)
    expect(delta(plan, 'p4')).toBe(-100_000)
  })

  it('uses the snapshotted second-place rate', () => {
    const commission = { ...fourPlayerRules, commissionFourPlayerSecondBps: 500 }
    const plan = planSettlement({ gameType: 'FOUR_PLAYER', stakeCents: 10_000, players, winnerId: 'p1', secondPlaceId: 'p2', commission })
    expect(delta(plan, 'p2')).toBe(9_500)
  })

  it.each([
    ['missing second place', undefined],
    ['second equals winner', 'p1'],
    ['second not in game', 'stranger'],
  ])('rejects %s', (_label, second) => {
    expect(() => planSettlement({ gameType: 'FOUR_PLAYER', stakeCents: 1_000, players, winnerId: 'p1', secondPlaceId: second })).toThrow(InvalidResultError)
  })
})

describe('planSettlement: invariants', () => {
  it('rejects a winner who is not in the game and a wrong player count', () => {
    expect(() => planSettlement({ gameType: 'ONE_V_ONE', stakeCents: 100, players: ids(2).map((userId) => ({ userId, team: null })), winnerId: 'x' })).toThrow(InvalidResultError)
    expect(() => planSettlement({ gameType: 'ONE_V_ONE', stakeCents: 100, players: ids(3).map((userId) => ({ userId, team: null })), winnerId: 'p1' })).toThrow(InvalidResultError)
    expect(() => planSettlement({ gameType: 'ONE_V_ONE', stakeCents: 0, players: ids(2).map((userId) => ({ userId, team: null })), winnerId: 'p1' })).toThrow(InvalidResultError)
  })

  it('every plan: deltas equal ledger sums, and money lost by players equals commission (random stakes)', () => {
    let seed = 12345
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 500; i++) {
      const stake = 1 + rnd(100_000_000)
      const kind = (['ONE_V_ONE', 'TWO_V_TWO', 'FOUR_PLAYER'] as const)[rnd(3)]!
      const n = kind === 'ONE_V_ONE' ? 2 : 4
      const players = ids(n).map((userId, index) => ({ userId, team: kind === 'TWO_V_TWO' ? (index % 2) + 1 : null }))
      const winner = players[rnd(n)]!.userId
      let second: string | undefined
      if (kind === 'FOUR_PLAYER') second = players.find((p) => p.userId !== winner && rnd(2) === 0)?.userId ?? players.find((p) => p.userId !== winner)!.userId
      const plan = planSettlement({ gameType: kind, stakeCents: stake, players, winnerId: winner, secondPlaceId: second })

      for (const p of players) {
        const ledger = plan.entries.filter((e) => e.userId === p.userId).reduce((s, e) => s + e.amountCents, 0)
        expect(plan.deltas.get(p.userId)).toBe(ledger)
      }
      const net = [...plan.deltas.values()].reduce((s, v) => s + v, 0)
      const commissions = plan.entries.filter((e) => e.type === 'COMMISSION').reduce((s, e) => s - e.amountCents, 0)
      // Everything players lose in total is the commission the platform keeps.
      expect(net).toBe(kind === 'ONE_V_ONE' ? -tierCommissionCents(stake, {
        tierThresholdCents: soloRules.commissionTierThresholdCents!,
        highRateBps: soloRules.commissionHighRateBps!,
        lowRateBps: soloRules.commissionLowRateBps!,
      }) : net)
      expect(-net).toBe(commissions)
    }
  })
})
