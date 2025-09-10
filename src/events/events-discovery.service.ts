import { InjectFlowProducer, InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { FlowProducer, Queue } from 'bullmq'
import { ethers } from 'ethers'
import { sortBy, uniqBy } from 'lodash'
import { Model, Types as MongooseTypes } from 'mongoose'
import { BigNumber } from 'bignumber.js'

import { FACILITATOR_EVENTS, facilitatorABI } from './abi/facilitator'
import { RequestingUpdateEvent } from './schemas/requesting-update-event'
import { AllocationUpdatedEvent } from './schemas/allocation-updated-event'
import { EventsService } from './events.service'
import {
  DiscoverFacilitatorEventsQueue
} from './processors/discover-facilitator-events-queue'
import {
  EventsDiscoveryServiceState
} from './schemas/events-discovery-service-state'
import { EvmProviderService } from '../evm-provider/evm-provider.service'
import { ClusterService } from '../cluster/cluster.service'

@Injectable()
export class EventsDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventsDiscoveryService.name)

  private static readonly removeOnComplete = true
  private static readonly removeOnFail = 8
  public static readonly DEFAULT_DELAY = 1000 * 60 * 60 // 1 hour
  public static readonly MAX_BLOCK_QUERY_RANGE = 5000

  public static jobOpts = {
    removeOnComplete: EventsDiscoveryService.removeOnComplete,
    removeOnFail: EventsDiscoveryService.removeOnFail
  }

  private readonly NOMAD_ALLOC_INDEX: string
  private isLive?: string
  private doClean?: string
  private doDbNuke?: string
  private useFacility?: string

  private facilitatorAddress?: string

  private facilitatorContract: ethers.Contract
  private facilitatorContractDeployedBlock: ethers.BlockTag

  constructor(
    private readonly config: ConfigService<{
      FACILITY_CONTRACT_ADDRESS: string
      FACILITY_CONTRACT_DEPLOYED_BLOCK: string
      IS_LIVE: string
      DO_CLEAN: string
      DO_DB_NUKE: string
      USE_FACILITY: string
      NOMAD_ALLOC_INDEX: string
    }>,
    private readonly evmProviderService: EvmProviderService,
    private readonly eventsService: EventsService,
    @InjectQueue('discover-facilitator-events-queue')
    public discoverFacilitatorEventsQueue: Queue,
    @InjectFlowProducer('discover-facilitator-events-flow')
    public discoverFacilitatorEventsFlow: FlowProducer,
    @InjectModel(EventsDiscoveryServiceState.name)
    private readonly eventsDiscoveryServiceStateModel:
      Model<EventsDiscoveryServiceState>,
    @InjectModel(AllocationUpdatedEvent.name)
    private readonly allocationUpdatedEventModel: Model<AllocationUpdatedEvent>,
    @InjectModel(RequestingUpdateEvent.name)
    private readonly requestingUpdateEventModel: Model<RequestingUpdateEvent>,
    private readonly clusterService: ClusterService
  ) {
    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })
    this.doDbNuke = this.config.get<string>('DO_DB_NUKE', { infer: true })
    this.useFacility = this.config.get<string>('USE_FACILITY', { infer: true })
    this.NOMAD_ALLOC_INDEX = this.config.get<string>(
      'NOMAD_ALLOC_INDEX',
      { infer: true }
    )

    if (this.useFacility === 'true') {
      this.facilitatorAddress = this.config.get<string>(
        'FACILITY_CONTRACT_ADDRESS',
        { infer: true }
      )
      if (!this.facilitatorAddress) {
        throw new Error('FACILITY_CONTRACT_ADDRESS is not set!')
      }

      const facilitatorContractDeployedBlock = Number.parseInt(
        this.config.get<string>('FACILITY_CONTRACT_DEPLOYED_BLOCK', {
          infer: true
        })
      )
      this.facilitatorContractDeployedBlock = facilitatorContractDeployedBlock
      if (Number.isNaN(facilitatorContractDeployedBlock)) {
        throw new Error('FACILITY_CONTRACT_DEPLOYED_BLOCK is NaN!')
      }

      this.logger.log(
        `Initializing events service (IS_LIVE: ${this.isLive}, ` +
          `FACILITATOR: ${this.facilitatorAddress})`
      )
    } else {
      this.logger.log(
        `Skipped initialization of events service [USE_FACILITY=false]`
      )
    }
  }

  async onApplicationBootstrap() {
    this.logger.log(
      `Bootstrapping EventsDiscoveryService with ` +
        `NOMAD_ALLOC_INDEX [${this.NOMAD_ALLOC_INDEX}]`
    )

    if (this.useFacility == 'true') {
      this.logger.log('Bootstrapping with Facilitator')
      this.facilitatorContract = new ethers.Contract(
        this.facilitatorAddress,
        facilitatorABI,
        this.evmProviderService.jsonRpcProvider
      )

      this.logger.log(
        `Bootstraped Facilitator contract: [${this.facilitatorAddress}]`
      )
    } else {
      this.logger.log(
        `Skipped bootstrap of events service [USE_FACILITY=false]`
      )
    }

    if (this.clusterService.isTheOne()) {
      this.logger.log(
        `I am the leader, checking queue cleanup, immediate queue start`
      )
      if (this.doClean === 'true') {
        this.logger.log(
          'Cleaning up discover facilitator events queue because DO_CLEAN is true'
        )
        await this.discoverFacilitatorEventsQueue.obliterate({ force: true })
      }

      if (this.doDbNuke === 'true') {
        this.logger.log(
          'Nuking DB of requesting update events because DO_DB_NUKE is true'
        )
        await this.requestingUpdateEventModel.deleteMany({})
        this.logger.log('Nuked RequestingUpdateEvent collection')
      }

      if (this.useFacility === 'true') {
        this.logger.log('Queueing immediate discovery of facilitator events')
        await this.enqueueDiscoverFacilitatorEventsFlow({ delayJob: 0 })
      } else {
        this.logger.log(
          'Skipped queuing immediate discovery of facilitator ' +
            'events [USE_FACILITY=false]'
        )
      }
    } else {
      this.logger.log(
        `Not the leader, skipping queue cleanup check, ` +
          `skipping db cleanup check, &` +
          `skipping queueing immediate tasks`
      )
    }
  }

  public async discoverRequestingUpdateEvents(
    from?: ethers.BlockTag,
    to: ethers.BlockTag = 'latest'
  ) {
    const fromBlock = from || this.facilitatorContractDeployedBlock
    let toBlock = to === 'latest'
      ? await this.evmProviderService.jsonRpcProvider.getBlockNumber()
      : to
    const blockQueryRange = BigNumber(toBlock).minus(fromBlock)
    if (blockQueryRange.gt(EventsDiscoveryService.MAX_BLOCK_QUERY_RANGE)) {
      this.logger.warn(
        `Querying too many blocks (${blockQueryRange.toString()})` +
          ` - limiting to ${EventsDiscoveryService.MAX_BLOCK_QUERY_RANGE}`
      )
      toBlock = BigNumber(fromBlock)
        .plus(EventsDiscoveryService.MAX_BLOCK_QUERY_RANGE)
        .toNumber()
    }

    this.logger.log(
      `Discovering ${FACILITATOR_EVENTS.RequestingUpdate} events` +
        ` from block [${fromBlock.toString()}] to block [${toBlock.toString()}]`
    )

    const filter =
      this.facilitatorContract.filters[FACILITATOR_EVENTS.RequestingUpdate]()
    const events = (await this.facilitatorContract.queryFilter(
      filter,
      fromBlock,
      toBlock
    )) as ethers.EventLog[]

    this.logger.log(
      `Found [${events.length}] ${FACILITATOR_EVENTS.RequestingUpdate} events` +
        ` between blocks [${fromBlock.toString()}] and [${toBlock.toString()}]`
    )

    let knownEvents = 0, newEvents = 0
    for (const evt of events) {
      const knownEvent = await this.requestingUpdateEventModel.findOne({
        eventName: FACILITATOR_EVENTS.RequestingUpdate,
        transactionHash: evt.transactionHash
      })

      if (!knownEvent) {
        try {
          await this.requestingUpdateEventModel.create({
            blockNumber: evt.blockNumber,
            blockHash: evt.blockHash,
            transactionHash: evt.transactionHash,
            requestingAddress: evt.args[0]
          })
          newEvents++
        } catch (err) {
          this.logger.debug(
            `RequestingUpdateEvent creation race condition gracefully avoided`
          )
          knownEvents++
        }
      } else {
        knownEvents++
      }
    }

    this.logger.log(
      `Stored [${newEvents}] newly discovered` +
        ` ${FACILITATOR_EVENTS.RequestingUpdate} events` +
        ` and skipped storing [${knownEvents}] previously known` +
        ` out of [${events.length}] total`
    )

    return { from: fromBlock, to: toBlock }
  }

  public async discoverAllocationUpdatedEvents(
    from: ethers.BlockTag,
    to: ethers.BlockTag
  ) {
    const fromBlock = from
    const toBlock = to
    this.logger.log(
      `Discovering ${FACILITATOR_EVENTS.AllocationUpdated} events` +
        ` from block [${fromBlock.toString()}] to block [${toBlock.toString()}]`
    )

    const filter =
      this.facilitatorContract.filters[FACILITATOR_EVENTS.AllocationUpdated]()
    const events = (await this.facilitatorContract.queryFilter(
      filter,
      fromBlock,
      toBlock
    )) as ethers.EventLog[]

    this.logger.log(
      `Found [${events.length}] ${FACILITATOR_EVENTS.AllocationUpdated} events` +
        ` between blocks [${fromBlock.toString()}] and [${toBlock.toString()}]`
    )

    let knownEvents = 0, newEvents = 0
    for (const evt of events) {
      const knownEvent = await this.allocationUpdatedEventModel.findOne({
        eventName: FACILITATOR_EVENTS.AllocationUpdated,
        transactionHash: evt.transactionHash
      })

      if (!knownEvent) {
        try {
          await this.allocationUpdatedEventModel.create({
            blockNumber: evt.blockNumber,
            blockHash: evt.blockHash,
            transactionHash: evt.transactionHash,
            requestingAddress: evt.args[0]
          })
          newEvents++
        } catch (err) {
          this.logger.debug(
            `AllocationUpdatedEvent creation race condition gracefully avoided`
          )
          knownEvents++
        }
      } else {
        knownEvents++
      }
    }

    this.logger.log(
      `Stored [${newEvents}] newly discovered` +
        ` ${FACILITATOR_EVENTS.AllocationUpdated} events` +
        ` and skipped storing [${knownEvents}] previously known` +
        ` out of [${events.length}] total`
    )
  }

  public async matchDiscoveredFacilitatorEvents(to: ethers.BlockTag) {
    this.logger.log('Matching RequestingUpdate to AllocationUpdated events')

    const unfulfilledRequestingUpdateEvents =
      await this.requestingUpdateEventModel.find({ fulfilled: false })

    if (unfulfilledRequestingUpdateEvents.length < 1) {
      this.logger.log(`No unfulfilled RequestingUpdate events to match`)
      await this.setLastSafeCompleteBlockNumber(BigNumber(to).toNumber())
      return
    }

    this.logger.log(
      `Found [${unfulfilledRequestingUpdateEvents.length}]` +
        ` unfulfilled RequestingUpdate events`
    )

    let matchedCount = 0
    const unmatchedEvents: typeof unfulfilledRequestingUpdateEvents = []
    for (const unfulfilledEvent of unfulfilledRequestingUpdateEvents) {
      const subsequentAllocationUpdatedEventForAddress =
        await this.allocationUpdatedEventModel.findOne({
          blockNumber: { $gt: unfulfilledEvent.blockNumber },
          requestingAddress: unfulfilledEvent.requestingAddress
        })

      if (subsequentAllocationUpdatedEventForAddress) {
        unfulfilledEvent.allocationUpdatedEventTransactionHash =
          subsequentAllocationUpdatedEventForAddress.transactionHash
        unfulfilledEvent.fulfilled = true
        await unfulfilledEvent.save()
        matchedCount++
      } else {
        unmatchedEvents.push(unfulfilledEvent)
      }
    }

    const unmatchedToQueue = sortBy(
      uniqBy(
        unmatchedEvents.map(
          ({ requestingAddress, transactionHash, blockNumber }) => ({
            requestingAddress,
            transactionHash,
            blockNumber
          })
        ),
        'requestingAddress'
      ),
      'blockNumber'
    )

    for (const { requestingAddress, transactionHash } of unmatchedToQueue) {
      await this.eventsService.enqueueUpdateAllocation(
        requestingAddress,
        transactionHash
      )
    }

    const duplicateAddresses = unmatchedEvents.length - unmatchedToQueue.length
    const lastSafeCompleteBlock = BigNumber(to).toNumber()

    this.logger.log(
      `Matched [${matchedCount}] RequestingUpdate to AllocationUpdated events` +
        ` and enqueued [${unmatchedToQueue.length}]` +
        ` UpdateAllocation jobs ([${duplicateAddresses}] duplicate addresses)`
    )

    await this.setLastSafeCompleteBlockNumber(lastSafeCompleteBlock)
  }

  public async enqueueDiscoverFacilitatorEventsFlow(
    opts: {
      delayJob?: number
      skipActiveCheck?: boolean
    } = {
      delayJob: EventsDiscoveryService.DEFAULT_DELAY,
      skipActiveCheck: false
    }
  ) {
    this.logger.log(
      `Checking jobs in discover facilitator events queue before queueing ` +
      `new discover facilitator events flow with delay: ${opts.delayJob}ms`
    )

    let numJobsInQueue = 0
    numJobsInQueue += await this.discoverFacilitatorEventsQueue
      .getWaitingCount()
    numJobsInQueue += await this.discoverFacilitatorEventsQueue
      .getDelayedCount()
    if (!opts.skipActiveCheck) {
      numJobsInQueue += await this.discoverFacilitatorEventsQueue
        .getActiveCount()
    }
    if (numJobsInQueue > 0) {
      this.logger.warn(
        `There are ${numJobsInQueue} jobs in the discover facilitator events ` +
        `queue, not queueing new discover facilitator events flow`
      )
      return
    }

    let currentBlock = null
    try {
      currentBlock = await this.evmProviderService
        .jsonRpcProvider
        .getBlockNumber()
    } catch (error) {
      this.logger.error(
        'Not queueing new discover facilitator events flow: ' +
          'Failed to get current block number',
        error.stack
      )
      return
    }
    this.logger.log(
      `Queueing discover facilitator events flow with ` +
        `currentBlock: ${currentBlock} ` +
        `delay: ${opts.delayJob}ms`
    )
    await this.discoverFacilitatorEventsFlow.add({
      name: DiscoverFacilitatorEventsQueue
        .JOB_MATCH_DISCOVERED_FACILITATOR_EVENTS,
      queueName: 'discover-facilitator-events-queue',
      opts: EventsDiscoveryService.jobOpts,
      data: { currentBlock },
      children: [
        {
          name: DiscoverFacilitatorEventsQueue
            .JOB_DISCOVER_ALLOCATION_UPDATED_EVENTS,
          queueName: 'discover-facilitator-events-queue',
          opts: EventsDiscoveryService.jobOpts,
          data: { currentBlock },
          children: [
            {
              name: DiscoverFacilitatorEventsQueue
                .JOB_DISCOVER_REQUESTING_UPDATE_EVENTS,
              queueName: 'discover-facilitator-events-queue',
              opts: { delay: opts.delayJob, ...EventsDiscoveryService.jobOpts },
              data: { currentBlock }
            }
          ]
        }
      ]
    })

    this.logger.log(
      '[alarm=enqueued-discover-facilitator-events] ' +
        'Enqueued discover facilitator events flow'
    )
  }

  private async setLastSafeCompleteBlockNumber(blockNumber: number) {
    this.logger.log(`Setting last safe complete block number ${blockNumber}`)

    await this.eventsDiscoveryServiceStateModel.updateMany({}, { lastSafeCompleteBlock: blockNumber }, { upsert: true })
  }

  public async getLastSafeCompleteBlockNumber() {
    const eventsDiscoveryServiceState =
      await this.eventsDiscoveryServiceStateModel.findOne()

    if (eventsDiscoveryServiceState) {
      const state = eventsDiscoveryServiceState.toObject()
      this.logger.log(`Found existing EventsDiscoveryServiceState: ${state.lastSafeCompleteBlock}`)
      return state.lastSafeCompleteBlock || this.facilitatorContractDeployedBlock
    } else {
      this.logger.log(`Creating new EventsDiscoveryServiceState: ${this.facilitatorContractDeployedBlock}`)
      await this.eventsDiscoveryServiceStateModel.create({ lastSafeCompleteBlock: this.facilitatorContractDeployedBlock } )
      return this.facilitatorContractDeployedBlock
    }
  }
}
