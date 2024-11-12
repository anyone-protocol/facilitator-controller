import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ethers } from 'ethers'
import WebSocket from 'ws'

const DefaultEvmProviderServiceConfig = {
  EVM_NETWORK: '',
  EVM_PRIMARY_WSS: '',
  EVM_SECONDARY_WSS: ''
}

const EXPECTED_PONG_BACK = 15000
const KEEP_ALIVE_CHECK_INTERVAL = 7500
const DESTROY_WEBSOCKET_INTERVAL = 5
const BACKOFF_STEP_INTERVAL = 2000

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

  constructor(config: ConfigService<typeof DefaultEvmProviderServiceConfig>) {
    this.config.EVM_NETWORK = config.get<string>('EVM_NETWORK', { infer: true })
    if (!this.config.EVM_NETWORK) {
      throw new Error('EVM_NETWORK is not set!')
    }
    this.config.EVM_PRIMARY_WSS = config.get<string>(
      'EVM_PRIMARY_WSS',
      { infer: true }
    )
    if (!this.config.EVM_PRIMARY_WSS) {
      throw new Error('EVM_PRIMARY_WSS is not set!')
    }
    this.config.EVM_SECONDARY_WSS = config.get<string>(
      'EVM_SECONDARY_WSS',
      { infer: true }
    )
    if (!this.config.EVM_SECONDARY_WSS) {
      throw new Error('EVM_SECONDARY_WSS is not set!')
    }
  }

  onApplicationShutdown() {
    const waitForWebsocketAndDestroy = (provider: ethers.WebSocketProvider) => {
      setTimeout(() => {
        if (provider.websocket.readyState) {
          provider.destroy()
        } else {
          waitForWebsocketAndDestroy(provider)
        }
      }, DESTROY_WEBSOCKET_INTERVAL)
    }

    waitForWebsocketAndDestroy(this.primaryWebSocketProvider)
    waitForWebsocketAndDestroy(this.secondaryWebSocketProvider)
  }

  async onApplicationBootstrap() {
    await this.startWebSocketConnection(
      this.config.EVM_PRIMARY_WSS,
      this.config.EVM_NETWORK,
      'primary (infura)',
      this.primaryWebSocketProvider
    )
    await this.startWebSocketConnection(
      this.config.EVM_SECONDARY_WSS,
      this.config.EVM_NETWORK,
      'secondary (alchemy)',
      this.secondaryWebSocketProvider
    )
    this.currentWebSocketProvider = this.primaryWebSocketProvider
  }

  private startWebSocketConnection(
    wssUrl: string,
    network: string,
    socketName: string,
    provider: ethers.WebSocketProvider,
    attempts = 0,
    retries = 10
  ) {
    this.logger.log(
      `Attempting to start ${socketName} connection [${attempts}/${retries}]`
    )

    return new Promise<void>((resolve) => {
      let pingTimeout = null
      let keepAliveInterval = null
      const webSocket = new WebSocket(wssUrl)

      provider = new ethers.WebSocketProvider(() => webSocket)

      webSocket.on('open', () => {
        keepAliveInterval = setInterval(() => {
          this.logger.debug(
            `Checking if ${socketName} connection is alive, sending a ping`
          )
          webSocket.ping()
          pingTimeout = setTimeout(
            () => webSocket.terminate(),
            EXPECTED_PONG_BACK
          )
        }, KEEP_ALIVE_CHECK_INTERVAL)

        resolve()
      })

      webSocket.on('close', () => {
        this.logger.error(`The ${socketName} connection was closed`)
        clearInterval(keepAliveInterval)
        clearTimeout(pingTimeout)

        if (attempts < retries) {
          const sleepDuration = 2 ** attempts * BACKOFF_STEP_INTERVAL
          this.logger.log(
            `Sleeping ${sleepDuration} before retrying ${socketName} connection`
          )
          attempts++
          setTimeout(
            () =>
              this.startWebSocketConnection(
                wssUrl,
                network,
                socketName,
                provider,
                attempts,
                retries
              ),
            sleepDuration
          )
        } else {
          this.logger.warn(`Retry limit on ${socketName} exceeded`)
          this.swapProviders()
        }
      })

      webSocket.on('pong', () => {
        this.logger.debug(`Received pong, ${socketName} connection is alive`)
        clearInterval(pingTimeout)
      })
    })
  }

  private swapProviders() {
    if (this.currentWebSocketName === 'primary (infura)') {
      this.currentWebSocketName = 'secondary (alchemy)'
      this.currentWebSocketProvider = this.secondaryWebSocketProvider
    } else {
      this.currentWebSocketName = 'primary (infura)'
      this.currentWebSocketProvider = this.primaryWebSocketProvider
    }
    this.logger.log(`Swapped provider to ${this.currentWebSocketName}`)
  }

  attachWebSocketProvider(provider?: ethers.WebSocketProvider) {
    provider = this.currentWebSocketProvider

    return provider
  }
}
