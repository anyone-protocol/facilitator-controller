import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { forwardRef, Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { EventsDiscoveryService } from '../events-discovery.service'
import { RewardsDiscoveryService } from '../rewards-discovery.service'

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
          const lastHodlerBlock =
            await this.rewardsDiscoveryService.getLastSafeCompleteBlockNumber()

          return await this.rewardsDiscoveryService.discoverUpdateRewardsEvents(lastHodlerBlock)
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      case DiscoverHodlerEventsQueue.JOB_DISCOVER_REWARDED_EVENTS:
        try {
          const lastHodlerBlock =
            await this.rewardsDiscoveryService.getLastSafeCompleteBlockNumber()

          return await this.rewardsDiscoveryService.discoverRewardedEvents(
            lastHodlerBlock
          )
        } catch (error) {
          this.logger.error(
            `Exception during job ${job.name} [${job.id}]`,
            error.stack
          )
        }

        return undefined

      case DiscoverHodlerEventsQueue.JOB_MATCH_DISCOVERED_HODLER_EVENTS:
        try {
          await this.rewardsDiscoveryService.matchDiscoveredHodlerEvents(
            job.data.currentBlock
          )
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
