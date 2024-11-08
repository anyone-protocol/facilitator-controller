import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { forwardRef, Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { EventsDiscoveryService } from '../events-discovery.service'

@Processor('discover-facilitator-events-queue')
export class DiscoverFacilitatorEventsQueue extends WorkerHost {
  private readonly logger = new Logger(DiscoverFacilitatorEventsQueue.name)

  public static readonly JOB_DISCOVER_REQUESTING_UPDATE_EVENTS =
    'discover-requesting-update-events'
  public static readonly JOB_DISCOVER_ALLOCATION_UPDATED_EVENTS =
    'discover-allocation-updated-events'
  public static readonly JOB_MATCH_DISCOVERED_FACILITATOR_EVENTS =
    'match-discovered-facilitator-events'

  constructor(
    @Inject(forwardRef(() => EventsDiscoveryService))
    private readonly eventsDiscoveryService: EventsDiscoveryService
  ) {
    super()
  }

  async process(job: Job<{ currentBlock: number }, any, string>) {
    this.logger.debug(`Dequeueing ${job.name} [${job.id}]`)

    switch (job.name) {
      case DiscoverFacilitatorEventsQueue
        .JOB_DISCOVER_REQUESTING_UPDATE_EVENTS:
        try {
          const lastDiscoveredBlock = await this
            .eventsDiscoveryService
            .getLastDiscoveredBlockNumber()

          return await this
            .eventsDiscoveryService
            .discoverRequestingUpdateEvents(lastDiscoveredBlock)
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      case DiscoverFacilitatorEventsQueue
        .JOB_DISCOVER_ALLOCATION_UPDATED_EVENTS:
        try {
          const lastDiscoveredBlock = await this
            .eventsDiscoveryService
            .getLastDiscoveredBlockNumber()

          return await this
            .eventsDiscoveryService
            .discoverAllocationUpdatedEvents(lastDiscoveredBlock)
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      case DiscoverFacilitatorEventsQueue
        .JOB_MATCH_DISCOVERED_FACILITATOR_EVENTS:
        try {
          await this
            .eventsDiscoveryService
            .matchDiscoveredFacilitatorEvents()

          // NB: Store the last discovered block
          await this
            .eventsDiscoveryService
            .setLastDiscoveredBlockNumber(job.data.currentBlock)

          // NB: Re-enqueue this flow
          await this
            .eventsDiscoveryService
            .enqueueDiscoverFacilitatorEventsFlow()
          return
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      default:
        this.logger.warn(`Found unknown job ${job.name} [${job.id}]`)

        return undefined
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Finished ${job.name} [${job.id}]`)
  }
}
