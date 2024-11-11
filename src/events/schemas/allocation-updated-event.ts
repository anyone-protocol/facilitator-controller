import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema()
export class AllocationUpdatedEvent {
  @Prop({ type: String, required: true, default: 'AllocationUpdated' })
  eventName: 'AllocationUpdated'

  @Prop({ type: Number, required: true })
  blockNumber: number

  @Prop({ type: String, required: true })
  blockHash: string

  @Prop({ type: String, required: true })
  transactionHash: string

  @Prop({ type: String, required: true })
  requestingAddress: string
}

export type AllocationUpdatedEventDocument =
  HydratedDocument<AllocationUpdatedEvent>

export const AllocationUpdatedEventSchema = SchemaFactory.createForClass(
  AllocationUpdatedEvent
).index({ transactionHash: 1, requestingAddress: 1 }, { unique: true })
