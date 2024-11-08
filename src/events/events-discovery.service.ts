import { InjectFlowProducer, InjectQueue } from '@nestjs/bullmq'
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { FlowProducer, Queue } from 'bullmq'
import { ethers } from 'ethers'
import { uniq } from 'lodash'
import { Model, Types as MongooseTypes } from 'mongoose'

import { FACILITATOR_EVENTS, facilitatorABI } from './abi/facilitator'
import { RequestingUpdateEvent } from './schemas/requesting-update-event'
import { AllocationUpdatedEvent } from './schemas/allocation-updated-event'
import { EventsService } from './events.service'
import { ClusterService } from '../cluster/cluster.service'
import {
  DiscoverFacilitatorEventsQueue
} from './processors/discover-facilitator-events-queue'
import { EventsDiscoveryServiceState } from './schemas/events-discovery-service-state'

@Injectable()
export class EventsDiscoveryService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EventsDiscoveryService.name)

  private static readonly removeOnComplete = true
  private static readonly removeOnFail = 8

  public static jobOpts = {
    removeOnComplete: EventsDiscoveryService.removeOnComplete,
    removeOnFail: EventsDiscoveryService.removeOnFail
  }

  private isLive?: string
  private doClean?: string

  private infuraNetwork?: string
  private infuraWsUrl?: string
  private facilitatorAddress?: string

  private provider: ethers.WebSocketProvider
  private facilitatorContract: ethers.Contract
  private facilitatorContractDeployedBlock: ethers.BlockTag

  private state: {
    _id?: MongooseTypes.ObjectId
    isDiscovering: boolean
    lastDiscoveredBlock?: number
  } = { isDiscovering: false }

  constructor(
    private readonly config: ConfigService<{
      FACILITY_CONTRACT_ADDRESS: string
      FACILITY_CONTRACT_DEPLOYED_BLOCK: string
      IS_LIVE: string
      INFURA_NETWORK: string
      INFURA_WS_URL: string
    }>,
    private readonly cluster: ClusterService,
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
    private readonly requestingUpdateEventModel: Model<RequestingUpdateEvent>
  ) {
    this.isLive = this.config.get<string>('IS_LIVE', { infer: true })
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })

    this.infuraNetwork = this.config.get<string>(
      'INFURA_NETWORK',
      { infer: true }
    )
    if (!this.infuraNetwork) {
      throw new Error('INFURA_NETWORK is not set!')
    }

    this.infuraWsUrl = this.config.get<string>('INFURA_WS_URL', { infer: true })
    if (!this.infuraWsUrl) {
      throw new Error('INFURA_WS_URL is not set!')
    }

    this.facilitatorAddress = this.config.get<string>(
      'FACILITY_CONTRACT_ADDRESS',
      { infer: true }
    )
    if (!this.facilitatorAddress) {
      throw new Error('FACILITY_CONTRACT_ADDRESS is not set!')
    }

    const facilitatorContractDeployedBlock = Number.parseInt(
      this.config.get<string>(
        'FACILITY_CONTRACT_DEPLOYED_BLOCK',
        { infer: true }
      )
    )
    this.facilitatorContractDeployedBlock = facilitatorContractDeployedBlock
    if (Number.isNaN(facilitatorContractDeployedBlock)) {
      throw new Error('FACILITY_CONTRACT_DEPLOYED_BLOCK is NaN!')
    }

    this.provider = new ethers.WebSocketProvider(
      this.infuraWsUrl,
      this.infuraNetwork
    )

    this.facilitatorContract = new ethers.Contract(
      this.facilitatorAddress,
      facilitatorABI,
      this.provider
    )

    this.logger.log(
      `Initializing events service (IS_LIVE: ${this.isLive}, `
        + `FACILITATOR: ${this.facilitatorAddress})`
    )
  }

  async onApplicationBootstrap() {
    if (this.cluster.isTheOne()) {
      this.logger.log('Bootstrapping')
      const eventsDiscoveryServiceState =
        await this.eventsDiscoveryServiceStateModel.findOne()

      if (eventsDiscoveryServiceState) {
        this.state = eventsDiscoveryServiceState.toObject()
      } else {
        await this.eventsDiscoveryServiceStateModel.create(this.state)
      }

      if (this.doClean != 'true') {
        this.logger.log('Skipped cleaning up old jobs')
      } else {
        this.logger.log('Cleaning up old (24hrs+) jobs')
        await this.discoverFacilitatorEventsQueue.clean(24 * 60 * 60 * 1000, -1)
      }

      if (this.isLive != 'true') {
        this.logger.debug('Cleaning up queues for dev...')
        await this.discoverFacilitatorEventsQueue.obliterate({ force: true })
        await this.enqueueDiscoverFacilitatorEventsFlow(0)
        this.logger.log('Queued immediate discovery of facilitator events')
      } else {
        if (this.state.isDiscovering) {
          this.logger.log(
            'Discovering facilitator events should already be queued'
          )
        } else {
          await this.enqueueDiscoverFacilitatorEventsFlow(0)
          this.logger.log('Queued immediate discovery of facilitator events')
        }
      }      
    } else {
      this.logger.debug('Not the one, so skipping event subscriptions')
    }
  }

  async onApplicationShutdown() {
    const waitForWebsocketAndDestroy = () => {
      setTimeout(() => {
        if (this.provider.websocket.readyState) {
          this.provider.destroy()
        } else {
          waitForWebsocketAndDestroy()
        }
      }, 5)
    }

    waitForWebsocketAndDestroy()
  }

  public async discoverRequestingUpdateEvents(from?: ethers.BlockTag) {
    const fromBlock = from || this.facilitatorContractDeployedBlock

    this.logger.log(
      `Discovering ${FACILITATOR_EVENTS.RequestingUpdate} events`
        + ` from block ${fromBlock.toString()}`
    )

    const filter = this.facilitatorContract.filters[
      FACILITATOR_EVENTS.RequestingUpdate
    ]()
    const events = await this.facilitatorContract.queryFilter(
      filter,
      fromBlock
    ) as ethers.EventLog[]

    this.logger.log(
      `Found ${events.length} RequestingUpdate events`
        + ` since block ${fromBlock.toString()}`
    )

    let knownEvents = 0, newEvents = 0
    for (const evt of events) {
      const knownEvent = await this.requestingUpdateEventModel.findOne({
        eventName: FACILITATOR_EVENTS.RequestingUpdate,
        transactionHash: evt.transactionHash
      })

      if (!knownEvent) {
        await this.requestingUpdateEventModel.create({
          blockNumber: evt.blockNumber,
          blockHash: evt.blockHash,
          transactionHash: evt.transactionHash,
          requestingAddress: evt.args[0]
        })
        newEvents++
      } else {
        knownEvents++
      }
    }

    this.logger.log(
      `Stored ${newEvents} newly discovered`
        + ` ${FACILITATOR_EVENTS.RequestingUpdate} events`
        + ` and skipped storing ${knownEvents} previously known`
        + ` out of ${events.length} total`
    )
  }

  public async discoverAllocationUpdatedEvents(from?: ethers.BlockTag) {
    const fromBlock = from || this.facilitatorContractDeployedBlock

    this.logger.log(
      `Discovering ${FACILITATOR_EVENTS.AllocationUpdated} events`
        + ` from block ${fromBlock.toString()}`
    )

    const filter = this.facilitatorContract.filters[
      FACILITATOR_EVENTS.AllocationUpdated
    ]()
    const events = await this.facilitatorContract.queryFilter(
      filter,
      fromBlock
    ) as ethers.EventLog[]

    this.logger.log(
      `Found ${events.length} ${FACILITATOR_EVENTS.AllocationUpdated} events`
        + ` since block ${fromBlock.toString()}`
    )

    let knownEvents = 0, newEvents = 0
    for (const evt of events) {
      const knownEvent = await this.allocationUpdatedEventModel.findOne({
        eventName: FACILITATOR_EVENTS.AllocationUpdated,
        transactionHash: evt.transactionHash
      })

      if (!knownEvent) {
        await this.allocationUpdatedEventModel.create({
          blockNumber: evt.blockNumber,
          blockHash: evt.blockHash,
          transactionHash: evt.transactionHash,
          requestingAddress: evt.args[0]
        })
        newEvents++
      } else {
        knownEvents++
      }
    }

    this.logger.log(
      `Stored ${newEvents} newly discovered`
        + ` ${FACILITATOR_EVENTS.AllocationUpdated} events`
        + ` and skipped storing ${knownEvents} previously known`
        + ` out of ${events.length} total`
    )
  }

  public async matchDiscoveredFacilitatorEvents() {
    this.logger.log('Matching RequestingUpdate to AllocationUpdated events')

    const unfulfilledRequestingUpdateEvents = await this
      .requestingUpdateEventModel
      .find({ fulfilled: false })

    this.logger.log(
      `Found ${unfulfilledRequestingUpdateEvents.length}`
        + ` unfulfilled RequestingUpdate events`
    )

    let matchedCount = 0
    const unmatchedEvents: typeof unfulfilledRequestingUpdateEvents = []
    for (const unfulfilledEvent of unfulfilledRequestingUpdateEvents) {
      const subsequentAllocationUpdatedEventForAddress = await this
        .allocationUpdatedEventModel
        .findOne({
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

    const unmatchedRequestingAddresses = uniq(
      unmatchedEvents.map(ume => ume.requestingAddress)
    )
    for (const requestingAddress of unmatchedRequestingAddresses) {
      await this.eventsService.enqueueUpdateAllocation(requestingAddress)
    }

    const duplicateAddresses = unmatchedEvents.length
      - unmatchedRequestingAddresses.length

    this.logger.log(
      `Matched ${matchedCount} RequestingUpdate to AllocationUpdated events`
        + ` and enqueued ${unmatchedRequestingAddresses.length}`
        + ` UpdateAllocation jobs (${duplicateAddresses} duplicate addresses)`
    )
  }

  public async enqueueDiscoverFacilitatorEventsFlow(
    delayJob: number = 1000 * 60 * 60 * 1
  ) {
    if (!this.state.isDiscovering) {
      this.state.isDiscovering = true
      await this.updateServiceState()
    }

    const currentBlock = await this.provider.getBlockNumber()

    await this.discoverFacilitatorEventsFlow.add({
      name: DiscoverFacilitatorEventsQueue
        .JOB_MATCH_DISCOVERED_FACILITATOR_EVENTS,
      queueName: 'discover-facilitator-events-queue',
      opts: EventsDiscoveryService.jobOpts,
      data: { currentBlock },
      children: [{
        name: DiscoverFacilitatorEventsQueue
          .JOB_DISCOVER_ALLOCATION_UPDATED_EVENTS,
        queueName: 'discover-facilitator-events-queue',
        opts: EventsDiscoveryService.jobOpts,
        data: { currentBlock },
        children: [{
          name: DiscoverFacilitatorEventsQueue
            .JOB_DISCOVER_REQUESTING_UPDATE_EVENTS,
          queueName: 'discover-facilitator-events-queue',
          opts: { delay: delayJob, ...EventsDiscoveryService.jobOpts },
          data: { currentBlock }
        }]
      }]
    })
  }

  private async updateServiceState() {
    await this.eventsDiscoveryServiceStateModel.updateMany({}, this.state)
  }

  public async setLastDiscoveredBlockNumber(blockNumber: number) {
    this.logger.log(`Setting last discovered block number ${blockNumber}`)

    this.state.lastDiscoveredBlock = blockNumber
    await this.updateServiceState()
  }

  public async getLastDiscoveredBlockNumber() {
    return this.state.lastDiscoveredBlock
  }
}
