import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema()
export class EventsServiceState {
  @Prop({ type: BigInt, required: true })
  totalGasBalance: bigint
}

export type EventsServiceStateDocument =
  HydratedDocument<EventsServiceState>

export const EventsServiceStateSchema = SchemaFactory.createForClass(
  EventsServiceState
)
