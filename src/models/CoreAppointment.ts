import mongoose, { Schema, Document } from 'mongoose'

export interface ICoreAppointment extends Document {
  status: 'upcoming' | 'open' | 'closed'
  id: string
}

const CoreAppointmentSchema: Schema = new Schema(
  {
    status: { type: String, enum: ['closed'], required: true },
    id: { type: String, required: true },
  },
  { timestamps: true }
)

CoreAppointmentSchema.index({ id: 1 })

export default mongoose.model<ICoreAppointment>('CoreAppointment', CoreAppointmentSchema)
