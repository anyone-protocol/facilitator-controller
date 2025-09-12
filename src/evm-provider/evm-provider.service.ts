import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ethers } from 'ethers'

import { createResilientProviders, WEBSOCKET_APP_SHUTDOWN_CUSTOM_CODE } from '../util/resilient-websocket-provider'

const DefaultEvmProviderServiceConfig = {
  EVM_NETWORK: '',
  EVM_PRIMARY_WSS: '',
  EVM_SECONDARY_WSS: '',
  EVM_JSONRPC: '',
  EVM_INFURA_API_KEY: ''
}
const DESTROY_WEBSOCKET_INTERVAL = 5

@Injectable()
export class EvmProviderService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EvmProviderService.name)

  public readonly config: typeof DefaultEvmProviderServiceConfig =
    DefaultEvmProviderServiceConfig

  private primaryWebSocketProvider!: ethers.WebSocketProvider
  private secondaryWebSocketProvider!: ethers.WebSocketProvider
  private currentWebSocketProvider!: ethers.WebSocketProvider
  private currentWebSocketName: 'primary (infura)' | 'secondary (alchemy)' =
    'primary (infura)'

  private providerSwapCallbacks: (
    (provider: ethers.WebSocketProvider) => void
  )[] = []

  public jsonRpcProvider: ethers.JsonRpcProvider

  constructor(config: ConfigService<typeof DefaultEvmProviderServiceConfig>) {
    this.config.EVM_NETWORK = config.get<string>('EVM_NETWORK', { infer: true })
    if (!this.config.EVM_NETWORK) {
      throw new Error('EVM_NETWORK is not set!')
    }
    this.config.EVM_PRIMARY_WSS = config.get<string>('EVM_PRIMARY_WSS', {
      infer: true
    })
    if (!this.config.EVM_PRIMARY_WSS) {
      throw new Error('EVM_PRIMARY_WSS is not set!')
    }
    this.config.EVM_SECONDARY_WSS = config.get<string>('EVM_SECONDARY_WSS', {
      infer: true
    })
    if (!this.config.EVM_SECONDARY_WSS) {
      throw new Error('EVM_SECONDARY_WSS is not set!')
    }
    this.config.EVM_JSONRPC = config.get<string>('EVM_JSONRPC', { infer: true })
    if (!this.config.EVM_JSONRPC) {
      throw new Error('EVM_JSONRPC is not set!')
    }
    this.jsonRpcProvider = new ethers.JsonRpcProvider(this.config.EVM_JSONRPC)
  }

  onApplicationShutdown() {
    if (this.primaryWebSocketProvider && !this.primaryWebSocketProvider.destroyed) {
      this.logger.log('Shutting down primary WebSocket provider...')
      // try {
      //   this.primaryWebSocketProvider.websocket?.close(
      //     WEBSOCKET_APP_SHUTDOWN_CUSTOM_CODE,
      //     'Application Shutdown'
      //   )
      // } catch (err) {}
      this.primaryWebSocketProvider.destroy()
    }

    if (this.secondaryWebSocketProvider && !this.secondaryWebSocketProvider.destroyed) {
      this.logger.log('Shutting down secondary WebSocket provider...')
      // try {
      //   this.secondaryWebSocketProvider.websocket?.close(
      //     WEBSOCKET_APP_SHUTDOWN_CUSTOM_CODE,
      //     'Application Shutdown'
      //   )
      // } catch (err) {}
      this.secondaryWebSocketProvider.destroy()
    }
  }

  async onApplicationBootstrap() {
    this.logger.log(`Bootstrapping EVM Provider Service...`)

    this.logger.log(`Creating primary (infura) WebSocket provider...`)
    const primaryProviderName = 'primary (infura)'
    const primaryProviderUrl = this.config.EVM_PRIMARY_WSS
    const primaryCreditsCheckSuccess = await this.checkProviderCredits(
      primaryProviderName,
      primaryProviderUrl
    )
    if (primaryCreditsCheckSuccess) {
      const [primaryProvider] = await createResilientProviders(
        [{ url: primaryProviderUrl, name: primaryProviderName, requirePong: true }],
        this.config.EVM_NETWORK,
        this.swapProviders.bind(this)
      )
      if (!primaryProvider) {
        this.logger.error('Failed to create primary (infura) WebSocket provider')
      }
      this.primaryWebSocketProvider = primaryProvider
    } else {
      this.logger.error(
        'Primary (infura) WebSocket provider credits check failed!'
      )
    }

    this.logger.log(`Creating secondary (alchemy) WebSocket provider...`)
    const secondaryProviderName = 'secondary (alchemy)'
    const secondaryProviderUrl = this.config.EVM_SECONDARY_WSS
    const secondaryCreditsCheckSuccess = await this.checkProviderCredits(
      secondaryProviderName,
      secondaryProviderUrl
    )
    if (secondaryCreditsCheckSuccess) {
      const [secondaryProvider] = await createResilientProviders(
        [{ url: secondaryProviderUrl, name: secondaryProviderName, requirePong: false }],
        this.config.EVM_NETWORK,
        this.swapProviders.bind(this)
      )
      if (!secondaryProvider) {
        this.logger.error(
          'Failed to create secondary (alchemy) WebSocket provider'
        )
      }
      this.secondaryWebSocketProvider = secondaryProvider
    } else {
      this.logger.error(
        'Secondary (alchemy) WebSocket provider credits check failed!'
      )
    }

    if (this.primaryWebSocketProvider) {
      this.logger.log(`Using primary (infura) WebSocket provider`)
      this.currentWebSocketProvider = this.primaryWebSocketProvider
    } else if (this.secondaryWebSocketProvider) {
      this.logger.log(`Using secondary (alchemy) WebSocket provider`)
      this.currentWebSocketProvider = this.secondaryWebSocketProvider
    } else {
      throw new Error('No WebSocket providers available! Cannot bootstrap!')
    }
    this.logger.log(`EVM Provider Service bootstrapped successfully!`)
  }

  private async checkProviderCredits(
    providerName: string,
    providerWssUrl: string
  ) {
    this.logger.log(`Checking credits for ${providerName} WebSocket provider`)
    try {
      const provider = new ethers.WebSocketProvider(providerWssUrl)
      const blockNumber = await provider.getBlockNumber()
      provider.destroy()
      this.logger.log(
        `Successfully checked credits for ${providerName} WebSocket provider. ` +
          `Block number: ${blockNumber}`
      )
    } catch (error) {
      this.logger.error(
        `Failed to check credits for ${providerName} WebSocket provider:`,
        error instanceof Error ? error.stack : error
      )
      return false
    }

    return true
  }

  private swapProviders() {
    if (this.currentWebSocketName === 'primary (infura)') {
      this.currentWebSocketName = 'secondary (alchemy)'
      this.currentWebSocketProvider = this.secondaryWebSocketProvider
    } else {
      this.currentWebSocketName = 'primary (infura)'
      this.currentWebSocketProvider = this.primaryWebSocketProvider
    }

    for (const providerSwapCallback of this.providerSwapCallbacks) {
      providerSwapCallback(this.currentWebSocketProvider)
    }

    this.logger.log(`Swapped provider to ${this.currentWebSocketName}`)
  }

  private async waitOnBootstrap() {
    this.logger.debug('Waiting for service to bootstrap')
    return new Promise<void>((resolve) => {
      const checkReadyAndResolve = () => {
        if (
          this.currentWebSocketProvider &&
          this.currentWebSocketProvider.websocket &&
          this.currentWebSocketProvider.websocket.readyState
        ) {
          this.logger.debug(`Service is bootstrapped and ready`)
          resolve()
        } else {
          setTimeout(checkReadyAndResolve, 100)
        }
      }

      checkReadyAndResolve()
    })
  }

  async getCurrentWebSocketProvider(
    onSwapProvidersCallback: (provider: ethers.WebSocketProvider) => void
  ) {
    await this.waitOnBootstrap()
    this.providerSwapCallbacks.push(onSwapProvidersCallback)

    return this.currentWebSocketProvider
  }
}
