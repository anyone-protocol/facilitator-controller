import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema()
export class RequestingUpdateEvent {
  @Prop({ type: String, required: true, default: 'RequestingUpdate' })
  eventName: 'RequestingUpdate'

  @Prop({ type: Number, required: true })
  blockNumber: number

  @Prop({ type: String, required: true })
  blockHash: string

  @Prop({ type: String, required: true, index: true, unique: true })
  transactionHash: string

  @Prop({ type: String, required: true })
  requestingAddress: string

  @Prop({ type: Boolean, required: true, default: false })
  fulfilled: boolean

  @Prop({ type: String, required: false })
  allocationUpdatedEventTransactionHash?: string
}

export type RequestingUpdateEventDocument = HydratedDocument<
  RequestingUpdateEvent
>

export const RequestingUpdateEventSchema = SchemaFactory.createForClass(
  RequestingUpdateEvent
)
