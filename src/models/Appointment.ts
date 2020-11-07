import mongoose, { Schema, Document } from 'mongoose'

export interface IAppointment extends Document {
  name: string
  start: Date
  end: Date
  description: string
  doctorId: string
  type: 'PrivateEvent' | 'CustomAppointment' | 'Appointment'
}

const AppointmentSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    description: String,
    doctorId: { type: String, required: true },
    type: { type: String, required: true },
  },
  { timestamps: true }
)

export default mongoose.model<IAppointment>('Appointment', AppointmentSchema)
