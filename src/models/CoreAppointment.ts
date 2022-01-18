import mongoose, { Schema, Document } from 'mongoose'

export interface ICoreAppointment extends Document {
  status: 'upcoming' | 'open' | 'closed' | 'locked'
  appointmentType: 'A' | 'V'
  id: string
  date: Date
}

const CoreAppointmentSchema: Schema = new Schema(
  {
    status: { type: String, enum: ['upcoming', 'open', 'closed', 'locked'], required: true },
    appointmentType: { type: String, enum: ['A', 'V'], required: true },
    date: { type: Date, required: true },
    id: { type: String, required: true },
  },
  { timestamps: true }
)

CoreAppointmentSchema.index({ id: 1 })

export default mongoose.model<ICoreAppointment>('CoreAppointment', CoreAppointmentSchema)
