/**
 * Modified from:
 *  https://github.com/ethers-io/ethers.js/issues/1053#issuecomment-2402226658
 * Thanks to @blacklistholder @trixobird
 */
import { Logger } from '@nestjs/common'
import { Listener, Networkish, ProviderEvent, WebSocketProvider } from 'ethers'
import { WebSocket } from 'ws'

const EXPECTED_PONG_BACK = 60 * 1000
const KEEP_ALIVE_CHECK_INTERVAL = 30 * 60 * 1000
const MAX_RECONNECTION_ATTEMPTS = 10
const RECONNECTION_DELAY = 30000

export const WEBSOCKET_APP_SHUTDOWN_NORMAL_CODE = 1000
export const WEBSOCKET_APP_SHUTDOWN_TCP_CODE = 1005
export const WEBSOCKET_APP_SHUTDOWN_CUSTOM_CODE = 4200
export const WEBSOCKET_APP_SHUTDOWN_CODES = [
  WEBSOCKET_APP_SHUTDOWN_NORMAL_CODE,
  WEBSOCKET_APP_SHUTDOWN_TCP_CODE,
  WEBSOCKET_APP_SHUTDOWN_CUSTOM_CODE
]

interface Subscription {
  type: ProviderEvent
  listener: Listener
}

class ResilientWebsocketProvider {
  private readonly url: string
  private readonly network: Networkish
  private terminate: boolean
  private resolved: boolean = false
  private pingTimeout: NodeJS.Timeout | null
  private keepAliveInterval: NodeJS.Timeout | null
  private ws: WebSocket | null
  private provider: WebSocketProvider | null
  readonly subscriptions: Set<Subscription>
  private reconnectionAttempts: number
  private name: string
  private requirePong: boolean
  private maxRetriesCallback: (...args: any[]) => void
  private logger: Logger

  constructor(
    url: string,
    network: Networkish,
    name: string,
    requirePong: boolean,
    maxRetriesCallback: (...args: any[]) => void
  ) {
    this.url = url
    this.network = network
    this.terminate = false
    this.pingTimeout = null
    this.keepAliveInterval = null
    this.ws = null
    this.provider = null
    this.subscriptions = new Set()
    this.reconnectionAttempts = 0
    this.name = name
    this.requirePong = requirePong
    this.maxRetriesCallback = maxRetriesCallback
    this.logger = new Logger(`${ResilientWebsocketProvider.name}(${this.name})`)
  }

  async connect(): Promise<WebSocketProvider | null> {
    return new Promise((resolve, reject) => {
      const closeConnection = (code?: number) => {
        this.logger.log(`Closing connection... Code: ${code}`)
        this.cleanupConnection()
        if (WEBSOCKET_APP_SHUTDOWN_CODES.includes(code)) {
          this.terminate = true
        }
        if (!this.terminate) {
          this.reconnectionAttempts++
          this.logger.log(
            `Attempting to reconnect... ` +
              `(Attempt ${this.reconnectionAttempts})`
          )
          setTimeout(startConnection, RECONNECTION_DELAY)
        }
      }

      const startConnection = () => {
        if (this.reconnectionAttempts >= MAX_RECONNECTION_ATTEMPTS) {
          this.logger.error(
            `Max reconnection attempts (${MAX_RECONNECTION_ATTEMPTS}) reached` +
              ` for ${this.name}. Stopping reconnection.`
          )
          this.terminate = true
          this.maxRetriesCallback(this.name)
          resolve(null)
          return
        } else {
          this.logger.log(
            `Starting connection to ${this.name}... ` +
              `(Attempts ${this.reconnectionAttempts})`
          )
        }

        this.ws = new WebSocket(this.url)

        this.ws.on('open', async () => {
          this.reconnectionAttempts = 0
          this.setupKeepAlive()

          try {
            const wsp = new WebSocketProvider(() => this.ws, this.network)

            while (this.ws?.readyState !== WebSocket.OPEN) {
              // this.logger.debug('Waiting for websocket to be open')
              await this.sleep(1000)
            }

            wsp._start()

            while (!wsp.ready) {
              // this.logger.debug('Waiting for websocket provider to be ready')
              await this.sleep(1000)
            }

            this.provider = wsp
            await this.resubscribe()
            this.resolved = true
            resolve(this.provider)
          } catch (error) {
            this.logger.error(
              `Error initializing WebSocketProvider for ${this.name}:`,
              error
            )
            this.cleanupConnection()
            this.reconnectionAttempts++
            setTimeout(startConnection, RECONNECTION_DELAY)
          }
        })

        this.ws.on('close', (code?: number, reason?: string) => {
          const msg = `The websocket connection was closed for ${this.name}. Code: ${code}, Reason: ${reason}`
          if (WEBSOCKET_APP_SHUTDOWN_CODES.includes(code)) {
            this.logger.log(msg)
          } else {
            this.logger.error(msg)
          }
          closeConnection(code)
        })

        this.ws.on('error', (error) => {
          this.logger.error(`WebSocket error for ${this.name}:`, error)
          if (error.message.includes('429')) {
            this.logger.error(
              `Rate limit exceeded for ${this.name}. Retrying connection...`
            )

            if (!this.resolved) {
              reject(
                new Error(
                  `Rate limit exceeded on initial connection for ${this.name}`
                )
              )
            }

            closeConnection()
          }
        })

        this.ws.on('ping', () => {
          // this.logger.debug('Received ping from server, sending pong back')
          if (this.ws) this.ws.pong()
        })

        this.ws.on('pong', () => {
          // this.logger.debug(
          //   'Received pong, so connection is alive, clearing the timeout'
          // )
          if (this.pingTimeout) clearTimeout(this.pingTimeout)
        })
      }

      startConnection()
    })
  }

  private setupKeepAlive() {
    this.keepAliveInterval = setInterval(() => {
      if (!this.ws) {
        this.logger.debug('No websocket, exiting keep alive interval')
        return
      }
      this.logger.debug('Checking if the connection is alive, sending a ping')

      if (this.requirePong) this.ws.ping()

      this.pingTimeout = setTimeout(() => {
        if (this.requirePong && this.ws) {
          this.ws.terminate()
          this.logger.error(
            'Did not receive pong back from server, terminating connection'
          )
        }
      }, EXPECTED_PONG_BACK)
    }, KEEP_ALIVE_CHECK_INTERVAL)
  }

  private cleanupConnection() {
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval)
    if (this.pingTimeout) clearTimeout(this.pingTimeout)
  }

  private async resubscribe() {
    this.logger.log(`Resubscribing to topics: [${this.subscriptions.size}]`)
    for (const subscription of this.subscriptions) {
      try {
        await this.provider?.on(subscription.type, subscription.listener)
        this.logger.log(
          `Resubscribed to ${JSON.stringify(subscription.type)}`
        )
      } catch (error) {
        this.logger.error(
          `Failed to resubscribe to ${subscription.type}:`,
          error.stack
        )
        throw new Error(
          `Failed to resubscribe to ${subscription.type}: ${error.message}`
        )
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

async function createResilientProviders(
  urls: { url: string; name: string, requirePong: boolean }[],
  network: Networkish,
  maxRetriesCallback: (...args: any[]) => void
): Promise<WebSocketProvider[]> {
  const providers = await Promise.all(
    urls.map(async ({ url, name, requirePong }) => {
      const logger = new Logger(`${ResilientWebsocketProvider.name}(${name})`)
      try {        
        const resilientProvider = new ResilientWebsocketProvider(
          url,
          network,
          name,
          requirePong,
          maxRetriesCallback
        )
        const provider = await resilientProvider.connect()
        if (provider) {
          // Wrap the provider's 'on' method to track subscriptions
          const originalOn = provider.on.bind(provider)
          provider.on = (eventName: ProviderEvent, listener: Listener) => {
            resilientProvider.subscriptions.add({ type: eventName, listener })
            logger.log(`Subscribed to ${eventName.toString()} for ${name}`)
            try {
              return originalOn(eventName, listener)
            } catch (error) {
              logger.error(`Error subscribing to ${eventName}:`, error)
              throw error
            }
          }

          // Wrap the provider's 'off' method to track unsubscriptions
          const originalOff = provider.off.bind(provider)
          provider.off = (eventName: ProviderEvent, listener: Listener) => {
            resilientProvider.subscriptions.forEach((sub) => {
              if (
                sub.type === eventName &&
                sub.listener === listener
              ) {
                resilientProvider.subscriptions.delete(sub)
                logger.log(
                  `Unsubscribed from ${eventName.toString()} for ${name}`
                )
              }
            })
            return originalOff(eventName, listener)
          }
        }
        return provider
      } catch (error) {
        logger.error(
          `Failed to create ResilientWebsocketProvider for ${url}:`,
          error.stack
        )
        return null
      }
    })
  )

  // Filter out any null providers (failed connections)
  return providers.filter(
    (provider) => provider !== null
  ) as WebSocketProvider[]
}

export { createResilientProviders, ResilientWebsocketProvider }
