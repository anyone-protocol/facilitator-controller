import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'

import { ClusterService } from './cluster.service'
import { LeaderOnlyWorker } from './leader-only.worker'

/**
 * Starts every LeaderOnlyWorker on the leader and pauses them everywhere else.
 *
 * Registered in AppModule on purpose. Nest runs onApplicationBootstrap module by module in
 * dependency order with the root module last, so by the time this hook runs every service a
 * worker calls into has finished its own bootstrap. Nothing else has to signal readiness, and
 * a new leader-only worker only has to extend the base class.
 */
@Injectable()
export class LeaderOnlyWorkersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaderOnlyWorkersService.name)

  private workers: LeaderOnlyWorker[] = []

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly cluster: ClusterService
  ) {}

  onApplicationBootstrap(): void {
    this.workers = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance)
      .filter(
        (instance): instance is LeaderOnlyWorker =>
          instance instanceof LeaderOnlyWorker
      )

    this.cluster.onLeadership((leader) => {
      void (leader ? this.startAll() : this.pauseAll())
    })

    if (this.cluster.isTheOne()) {
      this.startAll()
    } else {
      this.logger.log(
        `Not the leader, ${this.workers.length} leader-only worker(s) stay stopped`
      )
    }
  }

  private startAll(): void {
    for (const worker of this.workers) {
      this.logger.log(`Leader, starting worker [${worker.worker.name}]`)
      worker
        .start()
        .catch((error) =>
          this.logger.error(
            `Worker [${worker.worker.name}] stopped with error`,
            error?.stack
          )
        )
    }
  }

  private async pauseAll(): Promise<void> {
    for (const worker of this.workers) {
      this.logger.log(
        `Lost leadership, pausing worker [${worker.worker.name}] after its in-flight job`
      )
      await worker.pause()
    }
  }
}
