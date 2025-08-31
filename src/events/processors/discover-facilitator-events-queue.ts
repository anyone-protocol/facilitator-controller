import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { forwardRef, Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { EventsDiscoveryService } from '../events-discovery.service'
import {
  EventDiscoveryQueryRangeDto
} from '../dto/event-discovery-query-range.dto'

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
      case DiscoverFacilitatorEventsQueue.JOB_DISCOVER_REQUESTING_UPDATE_EVENTS:
        try {
          const lastSafeCompleteBlock =
            this.eventsDiscoveryService.getLastSafeCompleteBlockNumber()
          this.logger.log(
            `Using lastSafeCompleteBlock [${lastSafeCompleteBlock}]`
          )
          return await this.eventsDiscoveryService.discoverRequestingUpdateEvents(
            lastSafeCompleteBlock,
            job.data.currentBlock
          )
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      case DiscoverFacilitatorEventsQueue.JOB_DISCOVER_ALLOCATION_UPDATED_EVENTS:
        try {
          const flowData = await job.getChildrenValues<EventDiscoveryQueryRangeDto>()
          this.logger.log(`[${job.name}] Dequeueing flow data: ${JSON.stringify(flowData)}`)
          const { from, to } = Object.values(flowData).at(0)

          await this.eventsDiscoveryService.discoverAllocationUpdatedEvents(
            from,
            to
          )

          return { from, to }
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      case DiscoverFacilitatorEventsQueue.JOB_MATCH_DISCOVERED_FACILITATOR_EVENTS:
        try {
          const flowData = await job.getChildrenValues<EventDiscoveryQueryRangeDto>()
          this.logger.log(`[${job.name}] Dequeueing flow data: ${JSON.stringify(flowData)}`)
          const { to } = Object.values(flowData).at(0)
          await this.eventsDiscoveryService.matchDiscoveredFacilitatorEvents(to)
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        } finally {
          // NB: Re-enqueue this flow
          await this.eventsDiscoveryService.enqueueDiscoverFacilitatorEventsFlow({
            delayJob: EventsDiscoveryService.DEFAULT_DELAY,
            skipActiveCheck: true
          })
        }

        return

      default:
        this.logger.warn(`Found unknown job ${job.name} [${job.id}]`)

        return undefined
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Finished ${job.name} [${job.id}]`)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<any, any, string>) {
    this.logger.error(`[alarm=failed-job-${job.name}] Failed ${job.name} [${job.id}]: ${job.failedReason}`)
  }
}
