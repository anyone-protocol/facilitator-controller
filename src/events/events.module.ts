import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { EventsService } from './events.service'
import { FacilitatorUpdatesQueue } from './processors/facilitator-updates-queue'
import { ClusterModule } from '../cluster/cluster.module'
import { DistributionModule } from '../distribution/distribution.module'
import {
  RequestingUpdateEvent,
  RequestingUpdateEventSchema
} from './schemas/requesting-update-event'
import {
  AllocationUpdatedEvent,
  AllocationUpdatedEventSchema
} from './schemas/allocation-updated-event'
import { EventsDiscoveryService } from './events-discovery.service'
import {
  DiscoverFacilitatorEventsQueue
} from './processors/discover-facilitator-events-queue'
import {
  EventsDiscoveryServiceState,
  EventsDiscoveryServiceStateSchema
} from './schemas/events-discovery-service-state'
import { EvmProviderModule } from '../evm-provider/evm-provider.module'

@Module({
  imports: [
    EvmProviderModule,
    ClusterModule,
    DistributionModule,
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
    MongooseModule.forFeature([
      {
        name: AllocationUpdatedEvent.name,
        schema: AllocationUpdatedEventSchema
      },
      {
        name: EventsDiscoveryServiceState.name,
        schema: EventsDiscoveryServiceStateSchema
      },
      { name: RequestingUpdateEvent.name, schema: RequestingUpdateEventSchema }
    ])
  ],
  providers: [
    EventsService,
    EventsDiscoveryService,
    FacilitatorUpdatesQueue,
    DiscoverFacilitatorEventsQueue
  ]
})
export class EventsModule {}
