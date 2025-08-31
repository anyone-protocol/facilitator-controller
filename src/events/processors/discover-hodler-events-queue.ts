import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { forwardRef, Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { RewardsDiscoveryService } from '../rewards-discovery.service'
import {
  EventDiscoveryQueryRangeDto
} from '../dto/event-discovery-query-range.dto'

@Processor('discover-hodler-events-queue')
export class DiscoverHodlerEventsQueue extends WorkerHost {
  private readonly logger = new Logger(DiscoverHodlerEventsQueue.name)

  public static readonly JOB_DISCOVER_UPDATE_REWARDS_EVENTS =
    'discover-update-rewards-events'
  public static readonly JOB_DISCOVER_REWARDED_EVENTS =
    'discover-rewarded-events'
  public static readonly JOB_MATCH_DISCOVERED_HODLER_EVENTS =
    'match-discovered-hodler-events'

  constructor(
    @Inject(forwardRef(() => RewardsDiscoveryService))
    private readonly rewardsDiscoveryService: RewardsDiscoveryService
  ) {
    super()
  }

  async process(job: Job<{ currentBlock: number }, any, string>) {
    this.logger.debug(`Dequeueing ${job.name} [${job.id}]`)

    switch (job.name) {
      case DiscoverHodlerEventsQueue.JOB_DISCOVER_UPDATE_REWARDS_EVENTS:
        try {
          const lastSafeCompleteBlock =
            this.rewardsDiscoveryService.getLastSafeCompleteBlockNumber()
          this.logger.log(
            `Using lastSafeCompleteBlock [${lastSafeCompleteBlock}]`
          )
          return await this.rewardsDiscoveryService.discoverUpdateRewardsEvents(
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

      case DiscoverHodlerEventsQueue.JOB_DISCOVER_REWARDED_EVENTS:
        try {
          const flowData = await job.getChildrenValues<EventDiscoveryQueryRangeDto>()
          this.logger.log(`[${job.name}] Dequeueing flow data: ${JSON.stringify(flowData)}`)
          const { from, to } = Object.values(flowData).at(0)

          await this.rewardsDiscoveryService.discoverRewardedEvents(
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

      case DiscoverHodlerEventsQueue.JOB_MATCH_DISCOVERED_HODLER_EVENTS:
        try {
          const flowData = await job.getChildrenValues<EventDiscoveryQueryRangeDto>()
          this.logger.log(`[${job.name}] Dequeueing flow data: ${JSON.stringify(flowData)}`)
          const { to } = Object.values(flowData).at(0)
          await this.rewardsDiscoveryService.matchDiscoveredHodlerEvents(to)
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        } finally {
          // NB: Re-enqueue this flow
          await this.rewardsDiscoveryService.enqueueDiscoverHodlerEventsFlow({
            delayJob: RewardsDiscoveryService.DEFAULT_DELAY,
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
