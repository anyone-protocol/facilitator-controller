import { BullModule } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'
import { Test, TestingModule } from '@nestjs/testing'
import { BigNumber } from 'bignumber.js'

import {
  RequestingUpdateEvent,
  RequestingUpdateEventSchema
} from './schemas/requesting-update-event'
import { EventsDiscoveryService } from './events-discovery.service'
import {
  AllocationUpdatedEvent,
  AllocationUpdatedEventSchema
} from './schemas/allocation-updated-event'
import { EvmProviderModule } from '../evm-provider/evm-provider.module'
import { EventsService } from './events.service'
import {
  EventsDiscoveryServiceState,
  EventsDiscoveryServiceStateSchema
} from './schemas/events-discovery-service-state'
import {
  UpdateRewardsEvent,
  UpdateRewardsEventSchema
} from './schemas/update-rewards-event'
import {
  RewardedEvent,
  RewardedEventSchema
} from './schemas/rewarded-event'
import {
  RewardsDiscoveryServiceState,
  RewardsDiscoveryServiceStateSchema
} from './schemas/rewards-discovery-service-state'
import { ClusterModule } from '../cluster/cluster.module'
import { EvmProviderService } from '../evm-provider/evm-provider.service'

const dbName = 'facilitator-controller-events-discovery-service-tests'

describe('EventsDiscoveryService', () => {
  let module: TestingModule
  let service: EventsDiscoveryService
  let evmProviderService: EvmProviderService

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        EvmProviderModule,
        BullModule.registerQueue({
          name: 'facilitator-updates-queue',
          streams: { events: { maxLen: 2000 } }
        }),
        BullModule.registerFlowProducer({ name: 'facilitator-updates-flow' }),
        BullModule.registerQueue({
          name: 'discover-facilitator-events-queue',
          streams: { events: { maxLen: 1000 } }
        }),
        BullModule.registerFlowProducer({
          name: 'discover-facilitator-events-flow'
        }),
        BullModule.registerQueue({
          name: 'hodler-updates-queue',
          streams: { events: { maxLen: 2000 } }
        }),
        BullModule.registerFlowProducer({ name: 'hodler-updates-flow' }),
        BullModule.registerQueue({
          name: 'discover-hodler-events-queue',
          streams: { events: { maxLen: 1000 } }
        }),
        BullModule.registerFlowProducer({
          name: 'discover-hodler-events-flow'
        }),
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(`mongodb://localhost/${dbName}`),
        MongooseModule.forFeature([
          {
            name: AllocationUpdatedEvent.name,
            schema: AllocationUpdatedEventSchema
          },
          {
            name: EventsDiscoveryServiceState.name,
            schema: EventsDiscoveryServiceStateSchema
          },
          {
            name: RequestingUpdateEvent.name,
            schema: RequestingUpdateEventSchema
          },
          {
            name: UpdateRewardsEvent.name,
            schema: UpdateRewardsEventSchema
          },
          {
            name: RewardedEvent.name,
            schema: RewardedEventSchema
          },
          {
            name: RewardsDiscoveryServiceState.name,
            schema: RewardsDiscoveryServiceStateSchema
          },
        ]),
        ClusterModule
      ],
      providers: [EventsDiscoveryService, EventsService],
      exports: [EventsDiscoveryService]
    })
      .setLogger(new Logger())
      .compile()
    service = module.get<EventsDiscoveryService>(EventsDiscoveryService)
    evmProviderService = module.get<EvmProviderService>(EvmProviderService)
    await evmProviderService.onApplicationBootstrap()
    await service.onApplicationBootstrap()
  }, 30_000)

  afterEach(async () => {
    // await evmProviderService.onApplicationShutdown()
    await module.close()
  })

  it.skip('should be defined', () => {
    expect(service).toBeDefined()
  })

  it('Does event discovery', async () => {
    const lastSafeCompleteBlock = await service.getLastSafeCompleteBlockNumber()
    const blockQueryRange = await service.discoverRequestingUpdateEvents(lastSafeCompleteBlock)
    expect(blockQueryRange).toBeDefined()
    expect(blockQueryRange.from).toBeDefined()
    expect(blockQueryRange.to).toBeDefined()
    expect(BigNumber(blockQueryRange.to).minus(blockQueryRange.from).toNumber())
      .toBeLessThanOrEqual(EventsDiscoveryService.MAX_BLOCK_QUERY_RANGE)

    await service.discoverAllocationUpdatedEvents(
      blockQueryRange.from,
      blockQueryRange.to
    )
    await service.matchDiscoveredFacilitatorEvents(blockQueryRange.to)
  }, 60_000)
})
