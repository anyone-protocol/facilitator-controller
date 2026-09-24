import { WorkerHost } from '@nestjs/bullmq'
import { Logger, OnApplicationBootstrap } from '@nestjs/common'

import { ClusterService } from './cluster.service'

/**
 * A BullMQ worker that consumes its queue only while this alloc is the cluster leader.
 *
 * Chain writes from one wallet are serial by nature: a second process signing from the same
 * wallet can only collide on nonces and overwrite the allowance an approve/reward pair depends
 * on. So the right shape is one active worker and a hot standby.
 *
 * The subclass must be declared `@Processor(name, { autorun: false })`. This host starts the
 * worker once the alloc is leader AND the service it calls into has finished bootstrapping,
 * pauses it when leadership is lost, and resumes it if leadership returns. `pause()` lets the
 * in-flight job finish first, so an approve/reward pair is never abandoned half-way. On a
 * crashed leader the active job simply stalls and the new leader re-runs it.
 *
 * Waiting for bootstrap also guarantees the worker never sees a job before the owning service
 * has built its contracts and wiped stale queues.
 */
export abstract class LeaderGatedWorkerHost
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly gateLogger = new Logger(LeaderGatedWorkerHost.name)
  private started = false

  protected constructor(
    private readonly cluster: ClusterService,
    /** Resolves once the service this worker calls into is fully bootstrapped. */
    private readonly ready: () => Promise<unknown>
  ) {
    super()
  }

  async onApplicationBootstrap(): Promise<void> {
    this.cluster.onLeadership((leader) => {
      void (leader ? this.activate() : this.standby())
    })

    if (this.cluster.isTheOne()) {
      await this.activate()
    } else {
      this.gateLogger.log(
        `[${this.worker.name}] not the leader, worker stays stopped`
      )
    }
  }

  private async activate(): Promise<void> {
    await this.ready()

    if (!this.started) {
      this.started = true
      this.gateLogger.log(`[${this.worker.name}] leader, starting worker`)
      this.worker
        .run()
        .catch((error) =>
          this.gateLogger.error(
            `[${this.worker.name}] worker stopped with error`,
            error?.stack
          )
        )
    } else if (this.worker.isPaused()) {
      this.gateLogger.log(`[${this.worker.name}] leader again, resuming worker`)
      this.worker.resume()
    }
  }

  private async standby(): Promise<void> {
    if (this.started && !this.worker.isPaused()) {
      this.gateLogger.log(
        `[${this.worker.name}] lost leadership, pausing worker after the in-flight job`
      )
      await this.worker.pause()
    }
  }
}
