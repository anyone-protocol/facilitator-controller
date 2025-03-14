import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { RewardAllocationData } from '../dto/reward-allocation-data'
import { EventsService } from '../events.service'
import { RecoverUpdateAllocationData } from '../dto/recover-update-allocation-data'
import { RelayRewardsService } from '../../relay-rewards/relay-rewards.service'

@Processor('facilitator-updates-queue')
export class FacilitatorUpdatesQueue extends WorkerHost {
  private readonly logger = new Logger(FacilitatorUpdatesQueue.name)

  public static readonly JOB_GET_CURRENT_REWARDS = 'get-current-rewards'
  public static readonly JOB_UPDATE_ALLOCATION = 'update-allocation'
  public static readonly JOB_RECOVER_UPDATE_ALLOCATION =
    'recover-update-allocation'

  constructor(
    private readonly events: EventsService,
    private readonly relayRewards: RelayRewardsService
  ) {
    super()
  }

  async process(
    job: Job<any, any, string>
  ): Promise<RewardAllocationData | boolean | undefined> {
    this.logger.debug(`Dequeueing ${job.name} [${job.id}]`)

    switch (job.name) {
      case FacilitatorUpdatesQueue.JOB_GET_CURRENT_REWARDS:
        try {
          const address = job.data as string
          if (address != undefined) {
            this.logger.log(
              `Fetching current rewards from distribution for ${address}`
            )

            return await this.relayRewards.getAllocation(address)
          } else {
            this.logger.error('Missing address in job data')
            return false
          }
        } catch (error) {
          this.logger.error('Exception while getting current rewards:', error)
          return false
        }

      case FacilitatorUpdatesQueue.JOB_UPDATE_ALLOCATION:
        const rewardData: RewardAllocationData[] = Object.values(
          await job.getChildrenValues()
        ).reduce((prev, curr) => (prev as []).concat(curr as []), [])

        try {
          if (rewardData && rewardData.length > 0 && rewardData[0]) {
            this.logger.log(`Updating rewards for ${rewardData[0].address}`)
            const hasPassedUpdate = await this.events.updateAllocation(
              rewardData[0]
            )
            if (!hasPassedUpdate) {
              this.events.recoverUpdateAllocation(rewardData[0])
            }

            return hasPassedUpdate
          } else {
            return false
          }
        } catch (e) {
          this.logger.error(
            `Exception when updating allocation. rewardData: [${rewardData}]`,
            e.stack
          )

          return false
        }

      case FacilitatorUpdatesQueue.JOB_RECOVER_UPDATE_ALLOCATION:
        try {
          const recoverData: RecoverUpdateAllocationData =
            job.data as RecoverUpdateAllocationData
          this.logger.log(
            `Running recovery of updateAllocation with ${recoverData.retries} retries: [${JSON.stringify(recoverData)}]`
          )
          if (recoverData.retries > 0) {
            const hasPassedRecovery = await this.events.updateAllocation({
              address: recoverData.address,
              amount: recoverData.amount
            })
            if (!hasPassedRecovery) {
              if (recoverData.retries > 1) {
                this.events.retryUpdateAllocation(recoverData)
              } else {
                this.events.trackFailedUpdateAllocation(recoverData)
              }
            }
            return hasPassedRecovery
          } else {
            this.logger.warn(
              `No more retries to try while recovering allocation: [${JSON.stringify(recoverData)}]`
            )
          }
          return true
        } catch (e) {
          this.logger.error(`Exception during recovering allocation job: [${JSON.stringify(job.data)}]`, e)
          return false
        }

      default:
        this.logger.warn(`Found unknown job ${job.name} [${job.id}]`)
        return undefined
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<any, any, string>) {
    this.logger.debug(`Finished ${job.name} [${job.id}]`)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<any, any, string>) {
    this.logger.error(`[alarm=failed-job-${job.name}] Failed ${job.name} [${job.id}]: ${job.failedReason}`)
  }
}
