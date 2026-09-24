/**
 * INTEGRATION test — talks to a real HyperBEAM node holding a real relay-rewards process.
 *
 * Requires:
 *   HB_URL, RELAY_REWARDS_PROCESS_ID, RELAY_REWARDS_CONTROLLER_KEY (owner/admin, or a
 *   Claim-Rewards role holder — the facilitator claims ON BEHALF of an address).
 *
 * To stand one up locally see smart-contracts/ao/scripts/run-e2e.ts.
 */
import { Logger } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'

import { RelayRewardsService } from './relay-rewards.service'

const HAVE_NODE = !!process.env.RELAY_REWARDS_PROCESS_ID && !!process.env.HB_URL
const itNode = HAVE_NODE ? it : it.skip

describe('RelayRewardsService', () => {
  let module: TestingModule
  let service: RelayRewardsService

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [RelayRewardsService]
    })
      .setLogger(new Logger())
      .compile()
    service = module.get<RelayRewardsService>(RelayRewardsService)
    await service.onApplicationBootstrap()
  })

  afterEach(async () => {
    await module.close()
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  itNode('reads an allocation for a seeded address', async () => {
    // Pick a real rewarded address out of the migrated state rather than inventing one.
    const rewards: any = await (service as any).ao.readView(
      process.env.RELAY_REWARDS_PROCESS_ID,
      'dump'
    )
    const [address] = Object.keys(rewards.TotalAddressReward)
    expect(address).toBeDefined()

    const allocation = await service.getAllocation(address)

    // The `rewards` view returns { address, reward } — the amount is a FIELD now, where the
    // legacy Get-Rewards dryrun made it the whole response body.
    expect(allocation).toBeDefined()
    expect(allocation.address).toBe(address)
    expect(allocation.amount).toMatch(/^\d+$/)
    expect(BigInt(allocation.amount)).toBeGreaterThan(0n)
  }, 120_000)

  itNode('returns undefined for an address with no allocation', async () => {
    const allocation = await service.getAllocation('0x' + '9'.repeat(40))

    expect(allocation).toBeUndefined()
  }, 120_000)

  itNode('claims rewards for a seeded address', async () => {
    const rewards: any = await (service as any).ao.readView(
      process.env.RELAY_REWARDS_PROCESS_ID,
      'dump'
    )
    const [address] = Object.keys(rewards.TotalAddressReward)

    const claimed = await service.claimRewards(address)

    expect(claimed.kind).toBe('relay')
    expect(claimed.noReward).toBeUndefined()
    expect(BigInt(claimed.amount)).toBeGreaterThan(0n)
  }, 180_000)

  itNode('reports noReward when the contract says there is none', async () => {
    // The contract asserts 'No rewards for <addr>'. That arrives as an AoContractError, NOT
    // as an HTTP failure — a client trusting the status code would report a successful claim
    // of nothing here.
    const claimed = await service.claimRewards('0x' + '8'.repeat(40))

    expect(claimed.noReward).toBe(true)
    expect(claimed.amount).toBe('0')
    expect(claimed.kind).toBe('relay')
  }, 180_000)
})
