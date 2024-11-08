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

@Module({
  imports: [
    ClusterModule,
    DistributionModule,
    BullModule.registerQueue({
      name: 'facilitator-updates-queue',
      streams: { events: { maxLen: 2000 } }
    }),
    BullModule.registerFlowProducer({ name: 'facilitator-updates-flow' }),
    MongooseModule.forFeature([
      { name: RequestingUpdateEvent.name, schema: RequestingUpdateEventSchema }
    ])
  ],
  providers: [EventsService, FacilitatorUpdatesQueue],
  exports: [EventsService]
})
export class EventsModule {}
