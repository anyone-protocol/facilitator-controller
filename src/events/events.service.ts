import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import {
  InjectQueue,
  InjectFlowProducer,
  QueueEventsHost,
  QueueEventsListener,
  OnQueueEvent
} from '@nestjs/bullmq'
import { Queue, FlowProducer, Job } from 'bullmq'
import { ConfigService } from '@nestjs/config'
import BigNumber from 'bignumber.js'
import { ethers, AddressLike, BigNumberish } from 'ethers'

import { RecoverUpdateAllocationData } from './dto/recover-update-allocation-data'
import { RewardAllocationData } from './dto/reward-allocation-data'
import { facilitatorABI } from './abi/facilitator'
import { EvmProviderService } from '../evm-provider/evm-provider.service'
import { HODLER_EVENTS, hodlerABI } from './abi/hodler'
import { ClaimedRewardsData } from './dto/claimed-rewards-data'
import { ClaimedConfigData } from './dto/claimed-config-data'
import { RecoverRewardsData } from './dto/recover-rewards-data'
import { EventsServiceState } from './schemas/events-service-state'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

@Injectable()
@QueueEventsListener('facilitator-updates-queue')
@QueueEventsListener('hodler-updates-queue')
export class EventsService
  extends QueueEventsHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(EventsService.name)

  private isLive?: string
  private doClean?: string

  private useHodler?: string
  private useFacility?: string

  private static readonly maxUpdateAllocationRetries = 2

  private static readonly removeOnComplete = true
  private static readonly removeOnFail = 8

  public static jobOpts = {
    removeOnComplete: EventsService.removeOnComplete,
    removeOnFail: EventsService.removeOnFail
  }

  private websocketProvider: ethers.WebSocketProvider

  private facilitatorAddress: string | undefined
  private facilityOperatorKey: string | undefined
  private facilitatorOperator: ethers.Wallet
  private facilitatorWebsocketContract: ethers.Contract
  private facilityContract: ethers.Contract

  private hodlerContractAddress: string | undefined
  private hodlerWebsocketContract: ethers.Contract
  private hodlerOperatorKey: string | undefined
  private hodlerOperator: ethers.Wallet
  public hodlerContract: ethers.Contract

  private rewardsPoolKey: string | undefined
  private rewardsPool: ethers.Wallet

  private tokenContract: ethers.Contract
  private tokenAddress: string | undefined

  constructor(
    private readonly config: ConfigService<{
      FACILITY_CONTRACT_ADDRESS: string
      FACILITY_OPERATOR_KEY: string
      IS_LIVE: string
      DO_CLEAN: string
      USE_HODLER: string
      USE_FACILITY: string
      HODLER_CONTRACT_ADDRESS: string
      HODLER_OPERATOR_KEY: string
      REWARDS_POOL_KEY: string
      TOKEN_CONTRACT_ADDRESS: string
    }>,
    private readonly evmProviderService: EvmProviderService,
    @InjectQueue('facilitator-updates-queue')
    public facilitatorUpdatesQueue: Queue,
    @InjectFlowProducer('facilitator-updates-flow')
    public facilitatorUpdatesFlow: FlowProducer,
    @InjectQueue('hodler-updates-queue')
    public hodlerUpdatesQueue: Queue,
    @InjectFlowProducer('hodler-updates-flow')
    public hodlerUpdatesFlow: FlowProducer,
    @InjectModel(EventsServiceState.name)
    private readonly eventsServiceState: Model<EventsServiceState>,
  ) {
    super()

    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })
    this.useHodler = this.config.get<string>('USE_HODLER', { infer: true })
    this.useFacility = this.config.get<string>('USE_FACILITY', { infer: true })

    if (this.useFacility == 'true') {
      this.facilitatorAddress = this.config.get<string>(
        'FACILITY_CONTRACT_ADDRESS',
        { infer: true }
      )

      if (!this.facilitatorAddress) {
        throw new Error('FACILITY_CONTRACT_ADDRESS is not set!')
      }

      this.facilityOperatorKey = this.config.get<string>(
        'FACILITY_OPERATOR_KEY',
        { infer: true }
      )

      if (!this.facilityOperatorKey) {
        throw new Error('FACILITY_OPERATOR_KEY is not set!')
      }
    }

    if (this.useHodler == 'true') {
      this.hodlerContractAddress = this.config.get<string>(
        'HODLER_CONTRACT_ADDRESS',
        { infer: true }
      )

      if (!this.hodlerContractAddress) {
        throw new Error('HODLER_CONTRACT_ADDRESS is not set!')
      }

      this.hodlerOperatorKey = this.config.get<string>(
        'HODLER_OPERATOR_KEY',
        { infer: true }
      )

      if (!this.hodlerOperatorKey) {
        throw new Error('HODLER_OPERATOR_KEY is not set!')
      }

      this.rewardsPoolKey = this.config.get<string>(
        'REWARDS_POOL_KEY',
        { infer: true }
      )
      if (!this.rewardsPoolKey) {
        throw new Error('REWARDS_POOL_KEY is not set!')
      }

      this.tokenAddress = this.config.get<string>(
        'TOKEN_CONTRACT_ADDRESS',
        { infer: true }
      )
      if (!this.tokenAddress) {
        throw new Error('TOKEN_CONTRACT_ADDRESS is not set!')
      }
    }

    this.logger.log(
      `Initializing events service (IS_LIVE: ${this.isLive}, ` +
        `FACILITATOR: ${this.facilitatorAddress} HODLER: ${this.hodlerContractAddress})`
    )
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.doClean === 'true') {
      this.logger.log(
        'Cleaning up facilitator updates queue because DO_CLEAN is true'
      )
      await this.facilitatorUpdatesQueue.obliterate({ force: true })
    }

    this.websocketProvider = await this.evmProviderService.getCurrentWebSocketProvider(
      (async (provider) => {
        this.websocketProvider = provider
        if (this.useHodler == 'true') { await this.subscribeToHodler() }
        if (this.useFacility == 'true') { await this.subscribeToFacilitator() }
      }).bind(this)
    )

    if (this.facilitatorAddress != undefined) {
      this.facilitatorOperator = new ethers.Wallet(
        this.facilityOperatorKey,
        this.websocketProvider
      )
      this.facilityContract = new ethers.Contract(
        this.facilitatorAddress,
        facilitatorABI,
        this.evmProviderService.jsonRpcProvider
      )
      this.subscribeToFacilitator().catch((error) =>
        this.logger.error('Failed subscribing to facilitator events:', error)
      )
    } else {
      this.logger.warn(
        'Missing FACILITY_CONTRACT_ADDRESS, ' +
          'not subscribing to Facilitator EVM events'
      )
    }

    if (this.hodlerContractAddress != undefined) {
      this.tokenContract = new ethers.Contract(
        this.tokenAddress,
        ['function approve(address spender, uint256 amount)'],
        this.evmProviderService.jsonRpcProvider
      )

      this.logger.log(`Connecting Hodler contract to operator wallet...`)
      // @ts-ignore
      this.hodlerContract = new ethers.Contract(
        this.hodlerContractAddress,
        hodlerABI,
        this.evmProviderService.jsonRpcProvider
      )
      this.hodlerOperator = new ethers.Wallet(
        this.hodlerOperatorKey,
        this.evmProviderService.jsonRpcProvider
      )
      this.rewardsPool = new ethers.Wallet(
        this.rewardsPoolKey,
        this.evmProviderService.jsonRpcProvider
      )
      this.subscribeToHodler().catch((error) =>
        this.logger.error('Failed subscribing to hodler events:', error)
      )
    } else {
      this.logger.warn(
        'Missing HODLER_CONTRACT_ADDRESS, ' +
          'not subscribing to Hodler EVM events'
      )
    }
  }

  @OnQueueEvent('duplicated')
  onDuplicatedJob({ jobId }: { jobId: string }) {
    this.logger.warn(`Did not queue duplicate job id [${jobId}]`)
  }

  public async recoverUpdateAllocation(rewardData: RewardAllocationData) {
    const recoverData: RecoverUpdateAllocationData = {
      ...rewardData,
      retries: EventsService.maxUpdateAllocationRetries
    }
    this.logger.log(
      `Attempting to recover updateAllocation job with ${recoverData.retries} ` +
        `retries for ${recoverData.address}`
    )
    this.facilitatorUpdatesQueue.add(
      'recover-update-allocation',
      recoverData,
      EventsService.jobOpts
    )
  }

  public async retryUpdateAllocation(recoverData: RecoverUpdateAllocationData) {
    const retryData: RecoverUpdateAllocationData = {
      ...recoverData,
      retries: recoverData.retries - 1
    }
    this.logger.log(
      `Retry updateAllocation job with ${recoverData.retries} retries for ` +
        `${recoverData.address}`
    )
    this.facilitatorUpdatesQueue.add(
      'recover-update-allocation',
      retryData,
      EventsService.jobOpts
    )
  }

  public async trackFailedUpdateAllocation(
    recoverData: RecoverUpdateAllocationData
  ) {
    this.logger.error(
      `Failed recovering the update of allocation for ${recoverData.address} ` +
        `with amount ${recoverData.amount}`
    )
  }
  
  public async trackFailedReward(
    recoverData: RecoverRewardsData
  ) {
    this.logger.error(
      `Failed recovering the update of allocation for ${recoverData.rewards[0].address} ` +
        `with rewards ${JSON.stringify(recoverData.rewards)}`
    )
  }

  private checkIfPassableReason(reason: string): boolean {
    switch (reason) {
      case 'Facility: no tokens allocated for sender':
        return true
      case 'Facility: no tokens available to claim':
        return true
      default:
        return false
    }
  }

  private checkForInternalWarnings(reason: string): boolean {
    switch (reason) {
      case 'Facility: not enough tokens to claim':
        return true
      case 'Facility: transfer of claimable tokens failed':
        return true
      default:
        return false
    }
  }

  public async updateAllocation(data: RewardAllocationData): Promise<boolean> {
    if (this.isLive === 'true') {
      if (this.facilityContract == undefined) {
        this.logger.error(
          'Facility signer contract not initialized, skipping allocation update'
        )
      } else {
        try {
          this.logger.log(
            `Updating allocation for [${data.address}] for amount [${data.amount}]`
          )
          const receipt = await this.facilityContract
            .connect(this.facilitatorOperator)
            // @ts-ignore
            .updateAllocation(
              data.address,
              BigNumber(data.amount).toFixed(0),
              true
            )
          const tx = await receipt.wait()
          this.logger.log(
            `UpdateAllocation for [${data.address}] tx: [${tx.hash}]`
          )

          return true
        } catch (updateError) {
          if (updateError.reason) {
            const isWarning = this.checkForInternalWarnings(updateError.reason)
            if (isWarning) {
              this.logger.error(
                `UpdateAllocation needs manual intervention: ` +
                  `${updateError.reason}`
              )
              return false
            }

            const isPassable = this.checkIfPassableReason(updateError.reason)
            if (isPassable) {
              this.logger.warn(
                `UpdateAllocation tx rejected: ${updateError.reason}`
              )
            } else {
              this.logger.error(
                `UpdateAllocation transaction failed: ${updateError.reason}`
              )
            }
            return isPassable
          } else {
            this.logger.error(
              `Error while calling updateAllocation for ${data.address}:`,
              updateError.stack
            )
          }
        }
      }

      this.logger.warn(
        `[alarm=update-allocation-failed] UpdateAllocation failed for: [${JSON.stringify(data)}]`
      )

      return false
    } else {
      this.logger.warn(
        `NOT LIVE: Not storing updating allocation of ${
          data.address
        } of ${BigNumber(data.amount).toFixed(0).toString()} atomic tokens`
      )

      return true
    }
  }

  public async enqueueUpdateAllocation(
    account: string,
    transactionHash?: string
  ) {
    // NB: To ensure the queue only contains unique update allocation attempts
    //     the jobId is prefixed with the requesting address
    const now = Date.now().toString()
    const prefix = `${account}-${transactionHash || now}`

    await this.facilitatorUpdatesFlow.add({
      name: 'update-allocation',
      queueName: 'facilitator-updates-queue',
      opts: {
        ...EventsService.jobOpts,
        jobId: `${prefix}-update-allocation`
      },
      children: [
        {
          name: 'get-current-rewards',
          queueName: 'facilitator-updates-queue',
          opts: {
            ...EventsService.jobOpts,
            jobId: `${prefix}-get-current-rewards`
          },
          data: account
        }
      ]
    })
  }

  private async onRequestingUpdateEvent(
    account: AddressLike,
    { log }: { log: ethers.EventLog }
  ) {
    let accountString: string
    if (account instanceof Promise) {
      accountString = await account
    } else if (ethers.isAddressable(account)) {
      accountString = await account.getAddress()
    } else {
      accountString = account
    }

    if (accountString != undefined) {
      this.logger.log(`Queueing rewards update for ${accountString}`)
      await this.enqueueUpdateAllocation(
        accountString,
        log.transactionHash
      )
    } else {
      this.logger.error(
        'Trying to request facility update but missing ' + 'address in data'
      )
    }
  }

  public async subscribeToFacilitator() {
    if (this.facilityOperatorKey == undefined) {
      this.logger.error(
        'Missing FACILITY_OPERATOR_KEY. Skipping facilitator subscription'
      )
    } else {
      if (this.facilitatorAddress == undefined) {
        this.logger.error(
          'Missing FACILITY_CONTRACT_ADDRESS. ' +
            'Skipping facilitator subscription'
        )
      } else {
        this.logger.log(
          `Subscribing to the Facilitator contract ` +
            `${this.facilitatorAddress} with ` +
            `${this.facilitatorOperator.address}...`
        )

        if (this.facilitatorWebsocketContract) {
          this.facilitatorWebsocketContract.off('RequestingUpdate')
        }

        this.facilitatorWebsocketContract = new ethers.Contract(
          this.facilitatorAddress,
          facilitatorABI,
          this.websocketProvider
        )
        this.facilitatorWebsocketContract.on(
          'RequestingUpdate',
          this.onRequestingUpdateEvent.bind(this)
        )
      }
    }
  }

  public async subscribeToHodler() {
    if (this.hodlerOperatorKey == undefined) {
      this.logger.error(
        'Missing HODLER_OPERATOR_KEY. Skipping hodler subscription'
      )
    } else {
      if (this.hodlerContractAddress == undefined) {
        this.logger.error(
          'Missing HODLER_CONTRACT_ADDRESS. ' +
            'Skipping Hodler subscription'
        )
      } else {
        this.logger.log(
          `Subscribing to the Hodler contract ` +
            `${this.hodlerContractAddress} with ` +
            `rewards pool [${this.rewardsPool.address}] and ` +
            `hodler operator [${this.hodlerOperator.address}]`
        )
        this.logger.log(`Creating Hodler contract instance...`)
        this.hodlerWebsocketContract = new ethers.Contract(
          this.hodlerContractAddress,
          hodlerABI,
          this.websocketProvider
        )
        if (this.hodlerWebsocketContract) {
          this.logger.log(
            `Removing previous Hodler contract event listeners...`
          )
          this.hodlerWebsocketContract.off(HODLER_EVENTS.UpdateRewards)
        }
        this.logger.log(`Attaching hodler UpdateRewards event listener...`)
        try {
          await this.hodlerWebsocketContract.on(
            HODLER_EVENTS.UpdateRewards,
            this.onHodlerUpdateRewards.bind(this)
          )
          this.logger.log(`Successfully subscribed to Hodler events!`)
        } catch (error) {
          this.logger.error(
            `Failed to subscribe to Hodler UpdateRewards event:`,
            error.stack
          )
          throw new Error(
            `Failed to subscribe to Hodler UpdateRewards event: ${error.message}`
          )
        }
      }
    }
  }

  private async onHodlerUpdateRewards(
    account: AddressLike,
    gasEstimate: BigNumberish,
    redeem: boolean,
    { log }: { log: ethers.EventLog }
  ) {
    this.logger.log(
      `Hodler UpdateRewards event for account: ${account}, ` +
        `gasEstimate: ${gasEstimate}, redeem: ${redeem}, ` +
        `tx: ${log.transactionHash}`
    )
    try {
      let accountString: string
      if (account instanceof Promise) {
        accountString = await account
      } else if (ethers.isAddressable(account)) {
        accountString = await account.getAddress()
      } else {
        accountString = account
      }

      if (accountString != undefined) {
        this.logger.log(`Queueing rewards update for ${accountString}`)
        await this.enqueueUpdateRewards(
          accountString,
          gasEstimate.toString(),
          redeem,
          log.transactionHash
        )
      } else {
        this.logger.error(
          'Trying to request facility update but missing ' + 'address in data'
        )
      }
    } catch (error) {
      this.logger.error(
        `Error processing Hodler UpdateRewards event for account ${account}:`,
        error.stack
      )
    }
  }

  public async enqueueUpdateRewards(
    account: string,
    gasEstimate: string,
    requestedRedeem: boolean,
    transactionHash?: string
  ) {
    // NB: To ensure the queue only contains unique update allocation attempts
    //     the jobId is prefixed with the requesting address
    const now = Date.now().toString()
    const prefix = `${account}-${transactionHash || now}`

    await this.hodlerUpdatesFlow.add({
      name: 'update-rewards',
      queueName: 'hodler-updates-queue',
      data: {
        gas: gasEstimate,
        redeem: requestedRedeem
      },
      opts: {
        ...EventsService.jobOpts,
        jobId: `${prefix}-update-rewards`
      },
      children: [
        {
          name: 'get-relay-rewards',
          queueName: 'hodler-updates-queue',
          opts: {
            ...EventsService.jobOpts,
            jobId: `${prefix}-get-relay-rewards`
          },
          data: account
        },
        {
          name: 'get-staking-rewards',
          queueName: 'hodler-updates-queue',
          opts: {
            ...EventsService.jobOpts,
            jobId: `${prefix}-get-staking-rewards`
          },
          data: account
        },
      ]
    })
  }
  
  private isRewardPassable(reason: string): boolean {
    switch (reason) {
      case 'Insufficient gas budget for hodler account':
        return true
      case 'No rewards to claim':
        return true
      default:
        return false
    }
  }

  private isRewardWarning(reason: string): boolean {
    switch (reason) {
      case 'Transfer of reward tokens failed':
        return true
      case 'Withdrawal of reward tokens failed':
        return true
      default:
        return false
    }
  }

  public async updateClaimedRewards(data: ClaimedRewardsData[], gasEstimate: string, requestedRedeem: boolean): Promise<boolean> {
    if (data.length === 0) {
      this.logger.warn('No rewards to update')
      return true
    }
    const hodlerAddress = data[0].address

    var stakingRewardAllocation = 0n
    var relayRewardAllocation = 0n
    for (const reward of data) {
      if (reward.address != hodlerAddress) {
        this.logger.warn(
          `Hodler address mismatch: ${hodlerAddress} != ${reward.address} in ${JSON.stringify(data)}`
        )
      } else {
        switch (reward.kind) {
          case 'relay': relayRewardAllocation = relayRewardAllocation + BigInt(reward.amount); break
          case 'staking': stakingRewardAllocation = stakingRewardAllocation + BigInt(reward.amount); break
        }
      }
    }

    if (this.hodlerContract == undefined) {
      this.logger.error(
        '[alarm=update-allocation-failed] Hodler signer contract not initialized, skipping claimed rewards update'
      )

      this.logger.warn(
        `[alarm=update-allocation-failed] Reward failed for: [${JSON.stringify(data)}]`
      )
      return false
    }

    const totalClaimableReward = stakingRewardAllocation + BigInt(relayRewardAllocation)
    if (totalClaimableReward <= 0n) {
      this.logger.debug(`No rewards to update for ${hodlerAddress} - ${totalClaimableReward}`)
      return true
    } else {
      this.logger.log(`Total claimable reward for ${hodlerAddress} is ${totalClaimableReward}`)
    }

    var approveCost: bigint = undefined
    var rewardCost: bigint = undefined

    try {
      const network = await this.evmProviderService.jsonRpcProvider.getNetwork();
      this.logger.log(`Checking data of ${hodlerAddress} on network: ${network.name}`);
      const hodlerData = await this.hodlerContract.hodlers(hodlerAddress)
      this.logger.log(`Found data for ${hodlerAddress}: #{hodlerData}`);
      const claimedRelayRewards = BigInt(hodlerData.claimedRelayRewards.toString())
      const claimedStakingRewards = BigInt(hodlerData.claimedStakingRewards.toString())

      const currentRelayReward = relayRewardAllocation - BigInt(claimedRelayRewards)
      const currentStakingReward = stakingRewardAllocation - BigInt(claimedStakingRewards)
      const currentTotalReward = currentRelayReward + BigInt(currentStakingReward)
            
      if (currentTotalReward >= 0) {
        this.logger.debug(`No new rewards to update for ${hodlerAddress}, ` +
          `current total reward: ${currentTotalReward} = ` +
          `staking [${stakingRewardAllocation}] - claimed [${claimedStakingRewards}] + ` +
          `relay [${relayRewardAllocation}] - claimed [${claimedRelayRewards}]`
        )
        return true
      }

      const receiverAddress = (requestedRedeem)? hodlerAddress : this.hodlerContractAddress

      this.logger.log(`Approving ${receiverAddress} for total ${currentTotalReward} = ` +
        `staking [${currentStakingReward}] + relay [${currentRelayReward}]...`
      )

      if (this.isLive === 'true') {
        // @ts-ignore
        const approveReceipt = await this.tokenContract.connect(this.rewardsPool).approve(
          receiverAddress,
          currentTotalReward
        )
        const approveTx = await approveReceipt.wait()
        this.websocketProvider.off(approveTx.hash)
        this.websocketProvider.off('block')

        approveCost = approveTx.gasUsed.mul(approveTx.gasPrice)
      
        this.logger.log(
          `Approved ${receiverAddress} for total ${currentTotalReward} tx: [${approveTx.hash}] cost: [${approveCost}]`
        )
      } else {
        this.logger.warn(
          `NOT LIVE: Skipped actual approval for ${receiverAddress} of ${currentTotalReward}`
        )
      }

      this.logger.log(
        `Rewarding [${hodlerAddress}] for ` +
          `staking [${stakingRewardAllocation}] relay [${relayRewardAllocation}]...`
      )

      if (this.isLive === 'true') {
        const receipt = await this.hodlerContract
          .connect(this.hodlerOperator)
          // @ts-ignore
          .reward(
            hodlerAddress,
            relayRewardAllocation,
            stakingRewardAllocation,
            BigInt(gasEstimate),
            requestedRedeem
          )
        const tx = await receipt.wait()
        this.websocketProvider.off(tx.hash)
        this.websocketProvider.off('block')

        rewardCost = tx.gasUsed.mul(tx.gasPrice)

        this.logger.log(
          `Rewarded [${hodlerAddress}] tx: [${tx.hash}]`
        )
      } else {
        this.logger.warn(
          `NOT LIVE: Skipped actual reward for ${hodlerAddress} of ` +
            `staking [${stakingRewardAllocation}] relay [${relayRewardAllocation}] with gas ${gasEstimate}`
        )
      }

      return true
    } catch (updateError) {
      if (updateError.reason) {
        const isWarning = this.isRewardWarning(updateError.reason)
        if (isWarning) {
          this.logger.error(
            `Reward of ${hodlerAddress} needs manual intervention: ` +
              `${updateError.reason}`
          )
          return false
        }

        const isPassable = this.isRewardPassable(updateError.reason)
        if (isPassable) {
          this.logger.log(
            `Reward tx of ${hodlerAddress} ignored: ${updateError.reason}`
          )
        } else {
          this.logger.error(
            `Reward transaction of ${hodlerAddress} failed: ${updateError.reason}`
          )
        }
        return isPassable
      } else {
        this.logger.error(
          `Error while calling reward on hodler for ${hodlerAddress}:`,
          updateError.stack
        )
        return false
      }
    } finally {
      if (approveCost && !rewardCost) {
        approveCost += await this.resetApproval(hodlerAddress, totalClaimableReward)
      }
      
      if (approveCost > 0 && rewardCost > 0) {
        const consumed = BigInt(gasEstimate)
        await this.rebalanceRewardGas(approveCost || 0n, rewardCost || 0n, consumed, hodlerAddress)
      }
    }
  }

  private async rebalanceRewardGas(approveCost: bigint, rewardCost: bigint, consumed: bigint, hodlerAddress: string) {
    const totalCost = approveCost + rewardCost
    const gasBalance = consumed - totalCost

    this.logger.log(
      `Reward process balance on gas for ${hodlerAddress}: ${ethers.formatEther(gasBalance.toString())} ETH`
    )
    if (gasBalance > consumed) {
      this.logger.warn(`Overcharged on gas for ${hodlerAddress}: ${ethers.formatEther(gasBalance)} ETH`)
    }
    if (gasBalance < 0n) {
      this.logger.error(`Undercharged on gas for ${hodlerAddress}: ${ethers.formatEther(gasBalance)} ETH`)
    }

    await this.eventsServiceState.updateMany({}, { $inc: { totalGasBalance: gasBalance } }, { upsert: true } )
  }

  private async resetApproval(hodlerAddress: string, totalClaimableReward: bigint): Promise<bigint> {
    this.logger.warn(
      `Approved ${hodlerAddress} for ${totalClaimableReward} but reward failed. Trying to reset approval...`
    )
    var approveCost: bigint = 0n

    if (this.isLive === 'true') {
      try {
        // @ts-ignore
        const approveReceipt = await this.tokenContract.connect(this.rewardsPool).approve(
          this.hodlerContractAddress,
          0
        )
        const approveTx = await approveReceipt.wait()
        this.websocketProvider.off(approveTx.hash)
        this.websocketProvider.off('block')

        approveCost += approveTx.gasUsed.mul(approveTx.gasPrice)
        this.logger.log(
          `Reset approval for ${hodlerAddress} cost: [${approveCost}] tx: [${approveTx.hash}]`
        )
      } catch (error) {
        this.logger.error(
          `Failed to reset approval for ${hodlerAddress}:`,
          error.stack
        )
      }
    } else {
      this.logger.warn(
        `NOT LIVE: Skipped resetting approval for ${hodlerAddress} of ${totalClaimableReward}`
      )
    }

    return approveCost
  }

  public async recoverReward(cfg: ClaimedConfigData, rewards: ClaimedRewardsData[]) {

    const recoverData: RecoverRewardsData = {
      retries: EventsService.maxUpdateAllocationRetries,
      gas: cfg.gas,
      redeem: cfg.redeem,
      rewards: rewards
    }
    this.logger.log(
      `Attempting to recover reward job with ${recoverData.retries} ` +
        `retries for ${rewards[0].address}`
    )
    this.hodlerUpdatesQueue.add(
      'recover-update-rewards',
      recoverData,
      EventsService.jobOpts
    )
  }

  public async retryReward(recoverData: RecoverRewardsData) {
    const retryData: RecoverRewardsData = {
      ...recoverData,
      retries: recoverData.retries - 1
    }
    this.logger.log(
      `Retry recover-reward job with ${recoverData.retries} retries for ` +
        `${recoverData.rewards[0].address}`
    )
    this.hodlerUpdatesQueue.add(
      'recover-update-rewards',
      retryData,
      EventsService.jobOpts
    )
  }
}
