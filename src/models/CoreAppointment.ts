import mongoose, { Schema, Document } from 'mongoose'

export interface ICoreAppointment extends Document {
  status: 'upcoming' | 'open' | 'closed' | 'locked'
  id: string
  date: Date
}

const CoreAppointmentSchema: Schema = new Schema(
  {
    status: { type: String, enum: ['upcoming', 'open', 'closed', 'locked'], required: true },
    date: { type: Date, required: true },
    id: { type: String, required: true },
  },
  { timestamps: true }
)

CoreAppointmentSchema.index({ id: 1 })

export default mongoose.model<ICoreAppointment>('CoreAppointment', CoreAppointmentSchema)
