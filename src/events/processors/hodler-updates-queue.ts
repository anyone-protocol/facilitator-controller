import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { EventsService } from '../events.service'
import { RewardAllocationData } from '../dto/reward-allocation-data'
import { RecoverUpdateAllocationData } from '../dto/recover-update-allocation-data'
import { RelayRewardsService } from '../../relay-rewards/relay-rewards.service'
import { ClaimedRewardsData } from '../dto/claimed-rewards-data'
import { StakingRewardsService } from 'src/staking-rewards/staking-rewards.service'
import BigNumber from 'bignumber.js'
import { ClaimedConfigData } from '../dto/claimed-config-data'
import { RecoverRewardsData } from '../dto/recover-rewards-data'

@Processor('hodler-updates-queue')
export class HodlerUpdatesQueue extends WorkerHost {
  private readonly logger = new Logger(HodlerUpdatesQueue.name)

  public static readonly JOB_GET_RELAY_REWARDS = 'get-relay-rewards'
  public static readonly JOB_GET_STAKING_REWARDS = 'get-staking-rewards'
  public static readonly JOB_UPDATE_REWARDS = 'update-rewards'
  public static readonly JOB_RECOVER_UPDATE_REWARDS = 'recover-update-rewards'

  constructor(
    private readonly events: EventsService,
    private readonly relayRewards: RelayRewardsService,
    private readonly stakingRewards: StakingRewardsService
  ) {
    super()
  }

  async process(
    job: Job<any, any, string>
  ): Promise<ClaimedRewardsData | boolean | undefined> {
    this.logger.debug(`Dequeueing ${job.name} [${job.id}]`)

    switch (job.name) {
      case HodlerUpdatesQueue.JOB_GET_RELAY_REWARDS:
        try {
          const address = job.data as string
          if (address != undefined) {
            this.logger.log(
              `Fetching current rewards from distribution for ${address}`
            )

            return await this.relayRewards.claimRewards(address)
          } else {
            this.logger.error('Missing address in job data')
            return false
          }
        } catch (error) {
          this.logger.error('Exception while getting current relay rewards:', error)
          return false
        }
        
      case HodlerUpdatesQueue.JOB_GET_STAKING_REWARDS:
        try {
          const address = job.data as string
          if (address != undefined) {
            this.logger.log(
              `Fetching current rewards from distribution for ${address}`
            )

            return await this.stakingRewards.claimRewards(address)
          } else {
            this.logger.error('Missing address in job data')
            return false
          }
        } catch (error) {
          this.logger.error('Exception while getting current staking rewards:', error)
          return false
        }

      case HodlerUpdatesQueue.JOB_UPDATE_REWARDS:
        const rewardData: ClaimedRewardsData[] = Object.values(
          await job.getChildrenValues()
        ).reduce((prev, curr) => (prev as []).concat(curr as []), [])

        const updateData: ClaimedConfigData = job.data as ClaimedConfigData

        try {
          if (rewardData && rewardData.length > 0) {
            this.logger.log(`Updating rewards for ${rewardData[0].address}`)
            const hasPassedUpdate = await this.events.updateClaimedRewards(
              rewardData, updateData.gas, updateData.redeem
            )
            if (!hasPassedUpdate) {
              this.events.recoverReward(updateData, rewardData)
            }

            return hasPassedUpdate
          } else {
            this.logger.warn('Missing reward data in job data')
            return false
          }
        } catch (e) {
          this.logger.error(
            `Exception when updating allocation. rewardData: [${rewardData}]`,
            e.stack
          )

          return false
        }

      case HodlerUpdatesQueue.JOB_RECOVER_UPDATE_REWARDS:
        try {
          const recoverData: RecoverRewardsData =
            job.data as RecoverRewardsData
          this.logger.log(
            `Running recovery of updateAllocation with ${recoverData.retries} retries: [${JSON.stringify(recoverData)}]`
          )
          if (recoverData.retries > 0) {
            const hasPassedRecovery = await this.events.updateClaimedRewards(
              recoverData.rewards,
              recoverData.gas,
              recoverData.redeem
            )
            if (!hasPassedRecovery) {
              if (recoverData.retries > 1) {
                this.events.retryReward(recoverData)
              } else {
                this.events.trackFailedReward(recoverData)
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
