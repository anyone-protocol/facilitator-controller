import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { EventsService } from './events.service'
import { FacilitatorUpdatesQueue } from './processors/facilitator-updates-queue'
import {
  RequestingUpdateEvent,
  RequestingUpdateEventSchema
} from './schemas/requesting-update-event'
import {
  AllocationUpdatedEvent,
  AllocationUpdatedEventSchema
} from './schemas/allocation-updated-event'
import { EventsDiscoveryService } from './events-discovery.service'
import { DiscoverFacilitatorEventsQueue } from './processors/discover-facilitator-events-queue'
import {
  EventsDiscoveryServiceState,
  EventsDiscoveryServiceStateSchema
} from './schemas/events-discovery-service-state'
import { EvmProviderModule } from '../evm-provider/evm-provider.module'
import { RelayRewardsModule } from '../relay-rewards/relay-rewards.module'
import { StakingRewardsModule } from '../staking-rewards/staking-rewards.module'
import { HodlerUpdatesQueue } from './processors/hodler-updates-queue'
import { DiscoverHodlerEventsQueue } from './processors/discover-hodler-events-queue'
import { RewardsDiscoveryServiceState, RewardsDiscoveryServiceStateSchema } from './schemas/rewards-discovery-service-state'
import { UpdateRewardsEvent, UpdateRewardsEventSchema } from './schemas/update-rewards-event'
import { RewardedEvent, RewardedEventSchema } from './schemas/rewarded-event'
import { RewardsDiscoveryService } from './rewards-discovery.service'
import { ClusterModule } from '../cluster/cluster.module'
import { EventsServiceState, EventsServiceStateSchema } from './schemas/events-service-state'

@Module({
  imports: [
    ClusterModule,
    EvmProviderModule,
    RelayRewardsModule,
    StakingRewardsModule,
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
    MongooseModule.forFeature([
      {
        name: AllocationUpdatedEvent.name,
        schema: AllocationUpdatedEventSchema
      },
      {
        name: EventsDiscoveryServiceState.name,
        schema: EventsDiscoveryServiceStateSchema
      },
      { name: RequestingUpdateEvent.name, schema: RequestingUpdateEventSchema },
      {
        name: UpdateRewardsEvent.name,
        schema: UpdateRewardsEventSchema
      },
      {
        name: RewardedEvent.name,
        schema: RewardedEventSchema
      },
      {
        name: EventsServiceState.name,
        schema: EventsServiceStateSchema
      },
      {
        name: RewardsDiscoveryServiceState.name,
        schema: RewardsDiscoveryServiceStateSchema
      },
    ])
  ],
  providers: [
    EventsService,
    EventsDiscoveryService,
    RewardsDiscoveryService,
    FacilitatorUpdatesQueue,
    HodlerUpdatesQueue,
    DiscoverFacilitatorEventsQueue,
    DiscoverHodlerEventsQueue
  ]
})
export class EventsModule {}
