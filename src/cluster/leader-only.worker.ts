import { WorkerHost } from '@nestjs/bullmq'

/**
 * A BullMQ worker that consumes its queue only while this alloc is the cluster leader.
 *
 * Chain writes from one wallet are serial by nature: a second process signing from the same
 * wallet can only collide on nonces and overwrite the allowance an approve/reward pair depends
 * on. So the right shape is one active worker and a hot standby.
 *
 * Declare the subclass `@Processor(name, { autorun: false })`. LeaderOnlyWorkersService finds
 * every instance and drives it from leadership once all modules have bootstrapped. `pause()`
 * lets the in-flight job finish, so an approve/reward pair is never abandoned half-way; on a
 * crashed leader the active job simply stalls and the new leader re-runs it.
 */
export abstract class LeaderOnlyWorker extends WorkerHost {
  private started = false

  /** Start consuming, or resume if paused. Safe to call repeatedly. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true
      // Resolves only when the worker closes; rejects if it cannot start.
      return this.worker.run()
    }
    if (this.worker.isPaused()) {
      this.worker.resume()
    }
    return Promise.resolve()
  }

  /** Stop taking new jobs. The in-flight job finishes first. */
  async pause(): Promise<void> {
    if (this.started && !this.worker.isPaused()) {
      await this.worker.pause()
    }
  }
}
