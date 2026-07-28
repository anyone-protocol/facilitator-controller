/**
 * INTEGRATION test — talks to a real HyperBEAM node holding a real staking-rewards process.
 *
 * Requires: HB_URL, STAKING_REWARDS_PROCESS_ID, STAKING_REWARDS_CONTROLLER_KEY.
 */
import { Logger } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'

import { StakingRewardsService } from './staking-rewards.service'

const HAVE_NODE = !!process.env.STAKING_REWARDS_PROCESS_ID && !!process.env.HB_URL
const itNode = HAVE_NODE ? it : it.skip

describe('StakingRewardsService', () => {
  let module: TestingModule
  let service: StakingRewardsService

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [StakingRewardsService]
    })
      .setLogger(new Logger())
      .compile()
    service = module.get<StakingRewardsService>(StakingRewardsService)
    await service.onApplicationBootstrap()
  })

  afterEach(async () => {
    await module.close()
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  itNode('claims rewards for a seeded hodler and sums across operators', async () => {
    const dump: any = await (service as any).ao.readView(
      process.env.STAKING_REWARDS_PROCESS_ID,
      'dump'
    )
    const [hodler] = Object.keys(dump.Rewarded)
    expect(hodler).toBeDefined()

    const claimed = await service.claimRewards(hodler)

    // Staking returns the PER-OPERATOR map, which the service sums — unlike relay, which
    // returns a single amount. That difference is the contract's, not the client's.
    expect(claimed.kind).toBe('staking')
    expect(claimed.noReward).toBeUndefined()
    const expected = Object.values(dump.Rewarded[hodler] as Record<string, string>)
      .reduce((acc, v) => acc + BigInt(v), 0n)
    expect(BigInt(claimed.amount)).toBe(expected)
  }, 180_000)

  itNode('reports noReward when the contract says there is none', async () => {
    const claimed = await service.claimRewards('0x' + '8'.repeat(40))

    expect(claimed.noReward).toBe(true)
    expect(claimed.amount).toBe('0')
    expect(claimed.kind).toBe('staking')
  }, 180_000)
})
